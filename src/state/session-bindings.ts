import type { AiBackend } from "../backend/metadata.js";
import type { CodexSession } from "../codex/types.js";

export interface SessionBinding {
  routeKey: string;
  sessionId: string;
  backend?: AiBackend;
  backendSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionOwner {
  sessionId: string;
  backend?: AiBackend;
  backendSessionId?: string;
  ownerRouteKey: string;
  claimedAt: string;
  updatedAt: string;
}

export interface SessionBindingsSnapshot {
  active: SessionBinding[];
  owners: SessionOwner[];
}

export interface SessionBindingOptions {
  backend?: AiBackend;
  backendSessionId?: string;
}

export type ClaimSessionResult =
  | { ok: true; owner: SessionOwner; newlyClaimed: boolean }
  | { ok: false; reason: "owned_by_other_route"; owner: SessionOwner };

export type TransferSessionOwnerResult =
  | { ok: true; owner: SessionOwner }
  | { ok: false; reason: "not_owned_by_source"; owner?: SessionOwner };

export type ActivateSessionResult =
  | { ok: true; binding: SessionBinding; owner: SessionOwner }
  | { ok: false; reason: "not_owned_by_route"; owner?: SessionOwner };

export type UnbindSessionResult =
  | { ok: true; binding: SessionBinding }
  | { ok: false; reason: "no_active_session" };

export class SessionBindings {
  private readonly activeByRoute = new Map<string, SessionBinding>();
  private readonly ownersBySession = new Map<string, SessionOwner>();
  private readonly routeSessions = new Map<string, Set<string>>();

  constructor(snapshot?: Partial<SessionBindingsSnapshot>) {
    for (const owner of snapshot?.owners ?? []) {
      const normalized = normalizeOwner(owner);
      const backend = normalized.backend ?? "codex";
      this.ownersBySession.set(sessionOwnerKey(backend, normalized.sessionId), normalized);
      this.addRouteSession(normalized.ownerRouteKey, normalized.sessionId, backend);
    }
    for (const binding of snapshot?.active ?? []) {
      const normalized = normalizeBinding(binding);
      const backend = normalized.backend ?? "codex";
      this.activeByRoute.set(normalized.routeKey, normalized);
      this.addRouteSession(normalized.routeKey, normalized.sessionId, backend);
      const key = sessionOwnerKey(backend, normalized.sessionId);
      if (!this.ownersBySession.has(key)) {
        this.ownersBySession.set(key, {
          sessionId: normalized.sessionId,
          backend,
          backendSessionId: normalized.backendSessionId,
          ownerRouteKey: normalized.routeKey,
          claimedAt: normalized.createdAt,
          updatedAt: normalized.updatedAt,
        });
      }
    }
  }

  bindNewSession(routeKey: string, session: CodexSession, options: SessionBindingOptions = {}): SessionBinding {
    const now = new Date().toISOString();
    const backend = options.backend ?? session.backend ?? "codex";
    const backendSessionId = options.backendSessionId ?? session.backendSessionId;
    const key = sessionOwnerKey(backend, session.id);
    const existingOwner = this.ownersBySession.get(key);
    if (existingOwner && existingOwner.ownerRouteKey !== routeKey) {
      throw new Error(`session ${session.id} is owned by another route`);
    }
    const owner: SessionOwner = {
      sessionId: session.id,
      backend,
      backendSessionId,
      ownerRouteKey: routeKey,
      claimedAt: existingOwner?.claimedAt ?? now,
      updatedAt: now,
    };
    this.releaseReplacedActiveOwner(routeKey, session.id, backend);
    this.ownersBySession.set(key, owner);
    return this.setActive(routeKey, session.id, now, { backend, backendSessionId });
  }

  claimSessionOwner(routeKey: string, sessionId: string, options: SessionBindingOptions = {}): ClaimSessionResult {
    const now = new Date().toISOString();
    const backend = options.backend ?? "codex";
    const key = sessionOwnerKey(backend, sessionId);
    const existing = this.ownersBySession.get(key);
    if (existing && existing.ownerRouteKey !== routeKey) {
      return { ok: false, reason: "owned_by_other_route", owner: existing };
    }
    if (existing) {
      const owner = { ...existing, backendSessionId: options.backendSessionId ?? existing.backendSessionId, updatedAt: now };
      this.ownersBySession.set(key, owner);
      return { ok: true, owner, newlyClaimed: false };
    }
    const owner: SessionOwner = {
      sessionId,
      backend,
      backendSessionId: options.backendSessionId,
      ownerRouteKey: routeKey,
      claimedAt: now,
      updatedAt: now,
    };
    this.ownersBySession.set(key, owner);
    return { ok: true, owner, newlyClaimed: true };
  }

  activateOwnedSession(routeKey: string, session: CodexSession, options: SessionBindingOptions = {}): ActivateSessionResult {
    const backend = options.backend ?? session.backend ?? "codex";
    const key = sessionOwnerKey(backend, session.id);
    const owner = this.ownersBySession.get(key);
    if (!owner || owner.ownerRouteKey !== routeKey) {
      return { ok: false, reason: "not_owned_by_route", owner };
    }
    const backendSessionId = options.backendSessionId ?? session.backendSessionId ?? owner.backendSessionId;
    this.releaseReplacedActiveOwner(routeKey, session.id, backend);
    return {
      ok: true,
      binding: this.setActive(routeKey, session.id, undefined, { backend, backendSessionId }),
      owner: this.ownersBySession.get(key) ?? owner,
    };
  }

  unbindActiveSession(routeKey: string): UnbindSessionResult {
    const binding = this.activeByRoute.get(routeKey);
    if (!binding) return { ok: false, reason: "no_active_session" };
    this.activeByRoute.delete(routeKey);
    const bindingBackend = binding.backend ?? "codex";
    const key = sessionOwnerKey(bindingBackend, binding.sessionId);
    const owner = this.ownersBySession.get(key);
    if (owner?.ownerRouteKey === routeKey) {
      this.ownersBySession.delete(key);
    }
    this.routeSessions.get(routeKey)?.delete(sessionOwnerKey(bindingBackend, binding.sessionId));
    return { ok: true, binding };
  }

  rollbackClaim(routeKey: string, sessionId: string, options: SessionBindingOptions = {}): void {
    const backend = options.backend ?? "codex";
    const key = sessionOwnerKey(backend, sessionId);
    const owner = this.ownersBySession.get(key);
    if (owner?.ownerRouteKey === routeKey) {
      this.ownersBySession.delete(key);
      this.routeSessions.get(routeKey)?.delete(key);
    }
  }

  transferSessionOwner(fromRouteKey: string, toRouteKey: string, sessionId: string, options: SessionBindingOptions = {}): TransferSessionOwnerResult {
    const backend = options.backend ?? "codex";
    const key = sessionOwnerKey(backend, sessionId);
    const existing = this.ownersBySession.get(key);
    if (!existing || existing.ownerRouteKey !== fromRouteKey) {
      return { ok: false, reason: "not_owned_by_source", owner: existing };
    }
    const now = new Date().toISOString();
    const owner: SessionOwner = {
      ...existing,
      ownerRouteKey: toRouteKey,
      backendSessionId: options.backendSessionId ?? existing.backendSessionId,
      updatedAt: now,
    };
    this.ownersBySession.set(key, owner);
    this.routeSessions.get(fromRouteKey)?.delete(key);
    this.addRouteSession(toRouteKey, sessionId, backend);
    return { ok: true, owner };
  }

  getActive(routeKey: string): SessionBinding | undefined {
    return this.activeByRoute.get(routeKey);
  }

  getOwner(sessionId: string, options: SessionBindingOptions = {}): SessionOwner | undefined {
    return this.ownersBySession.get(sessionOwnerKey(options.backend ?? "codex", sessionId));
  }

  listRouteSessions(routeKey: string): string[] {
    return [...(this.routeSessions.get(routeKey) ?? [])].map(sessionIdFromOwnerKey);
  }

  listOwners(routeKey?: string): SessionOwner[] {
    const owners = [...this.ownersBySession.values()];
    return routeKey ? owners.filter((owner) => owner.ownerRouteKey === routeKey) : owners;
  }

  updateBackendSessionId(backend: AiBackend, sessionId: string, backendSessionId: string): void {
    const key = sessionOwnerKey(backend, sessionId);
    const owner = this.ownersBySession.get(key);
    if (owner) this.ownersBySession.set(key, { ...owner, backendSessionId, updatedAt: new Date().toISOString() });
    for (const [routeKey, binding] of this.activeByRoute.entries()) {
      if ((binding.backend ?? "codex") === backend && binding.sessionId === sessionId) {
        this.activeByRoute.set(routeKey, { ...binding, backendSessionId, updatedAt: new Date().toISOString() });
      }
    }
  }

  snapshot(): SessionBindingsSnapshot {
    return {
      active: [...this.activeByRoute.values()].map((binding) => ({ ...binding })),
      owners: [...this.ownersBySession.values()].map((owner) => ({ ...owner })),
    };
  }

  private setActive(routeKey: string, sessionId: string, now = new Date().toISOString(), options: SessionBindingOptions = {}): SessionBinding {
    const existing = this.activeByRoute.get(routeKey);
    const backend = options.backend ?? existing?.backend ?? "codex";
    const binding: SessionBinding = {
      routeKey,
      sessionId,
      backend,
      backendSessionId: options.backendSessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.activeByRoute.set(routeKey, binding);
    this.addRouteSession(routeKey, sessionId, backend);
    const key = sessionOwnerKey(backend, sessionId);
    const owner = this.ownersBySession.get(key);
    if (owner?.ownerRouteKey === routeKey) {
      this.ownersBySession.set(key, { ...owner, backendSessionId: options.backendSessionId ?? owner.backendSessionId, updatedAt: now });
    }
    return binding;
  }

  private releaseReplacedActiveOwner(routeKey: string, nextSessionId: string, nextBackend: AiBackend): void {
    const previous = this.activeByRoute.get(routeKey);
    if (!previous) return;
    const previousBackend = previous.backend ?? "codex";
    if (previous.sessionId === nextSessionId && previousBackend === nextBackend) return;
    const previousKey = sessionOwnerKey(previousBackend, previous.sessionId);
    const previousOwner = this.ownersBySession.get(previousKey);
    if (previousOwner?.ownerRouteKey === routeKey) {
      this.ownersBySession.delete(previousKey);
      this.routeSessions.get(routeKey)?.delete(previousKey);
    }
  }

  private addRouteSession(routeKey: string, sessionId: string, backend: AiBackend): void {
    const routeSessions = this.routeSessions.get(routeKey) ?? new Set<string>();
    routeSessions.add(sessionOwnerKey(backend, sessionId));
    this.routeSessions.set(routeKey, routeSessions);
  }
}

function normalizeBinding(binding: SessionBinding): SessionBinding {
  return { ...binding, backend: binding.backend ?? "codex" };
}

function normalizeOwner(owner: SessionOwner): SessionOwner {
  return { ...owner, backend: owner.backend ?? "codex" };
}

export function sessionOwnerKey(backend: AiBackend | undefined, sessionId: string): string {
  return `${backend ?? "codex"}:${sessionId}`;
}

function sessionIdFromOwnerKey(key: string): string {
  const index = key.indexOf(":");
  return index >= 0 ? key.slice(index + 1) : key;
}
