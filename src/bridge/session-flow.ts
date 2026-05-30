import type { AiBackend } from "../backend/metadata.js";
import type { CodexAdapter, CodexCollaborationMode, CodexResumeSessionOptions, CodexSession } from "../codex/types.js";
import type { ChannelActionMessage, ChannelButton, ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import { pendingBindingOwnerRouteKey } from "../state/memory-state-store.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { SessionContextSnapshotObservedBy } from "../state/persistent-state-types.js";
import type {
  BindSessionResult,
  InitialRouteBinding,
  SessionListItem,
  SessionSelectionState,
  UnboundRoutePolicy,
} from "./bridge-types.js";
import { ROUTE_BUSY_MUTATION_REJECT_TEXT } from "./bridge-types.js";
import { formatAppConversationTitle } from "./app-conversation.js";
import {
  formatCollaborationModeForStatus,
  isCancelSessionSelectionText,
  ownerConflictError,
  ownerConflictText,
} from "./formatters.js";
import type { BridgeDelivery } from "./delivery.js";
import {
  SESSION_LIST_PAGE_SIZE,
  buildSessionList,
  formatSessionListPage,
  matchSessionListItems,
  pageNumberFromText,
  paginateSessionList,
  recoverableSessionItems,
  sessionListStateExpired,
  sessionPageAction,
} from "./session-list.js";

export interface BridgeSessionFlowOptions {
  codex: CodexAdapter;
  backend?: AiBackend;
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  cwd: string;
  initialRouteBinding?: InitialRouteBinding;
  unboundRoutePolicy: UnboundRoutePolicy;
  isRouteExecutionBusy(routeKey: string): Promise<boolean>;
  applyStoredSessionRunPolicy(sessionId: string): void;
  collaborationModeForRoute(routeKey: string, sessionId?: string): CodexCollaborationMode;
  hasRouteCollaborationMode(routeKey: string): boolean;
  applyRouteCollaborationModeToSession(routeKey: string, sessionId: string): void;
  syncRouteCollaborationModeFromSession(routeKey: string, sessionId: string): CodexCollaborationMode;
  recordSessionContextSnapshot?(sessionId: string, observedBy: SessionContextSnapshotObservedBy): void | Promise<void>;
}

export interface EnsureSessionOptions {
  recordResumeSnapshot?: boolean;
}

export class BridgeSessionFlow {
  private readonly codex: CodexAdapter;
  private readonly backend: AiBackend;
  private readonly state: MemoryStateStore;
  private readonly delivery: BridgeDelivery;
  private cwd: string;
  private readonly unboundRoutePolicy: UnboundRoutePolicy;
  private readonly isRouteExecutionBusy: BridgeSessionFlowOptions["isRouteExecutionBusy"];
  private readonly applyStoredSessionRunPolicy: BridgeSessionFlowOptions["applyStoredSessionRunPolicy"];
  private readonly collaborationModeForRoute: BridgeSessionFlowOptions["collaborationModeForRoute"];
  private readonly hasRouteCollaborationMode: BridgeSessionFlowOptions["hasRouteCollaborationMode"];
  private readonly applyRouteCollaborationModeToSession: BridgeSessionFlowOptions["applyRouteCollaborationModeToSession"];
  private readonly syncRouteCollaborationModeFromSession: BridgeSessionFlowOptions["syncRouteCollaborationModeFromSession"];
  private readonly recordSessionContextSnapshot?: BridgeSessionFlowOptions["recordSessionContextSnapshot"];
  private readonly selections = new Map<string, SessionSelectionState>();
  private pendingInitialRouteBinding?: InitialRouteBinding;
  private pendingInitialRouteKey?: string;

  constructor(options: BridgeSessionFlowOptions) {
    this.codex = options.codex;
    this.backend = options.backend ?? "codex";
    this.state = options.state;
    this.delivery = options.delivery;
    this.cwd = options.cwd;
    this.pendingInitialRouteBinding = options.initialRouteBinding;
    this.unboundRoutePolicy = options.unboundRoutePolicy;
    this.isRouteExecutionBusy = options.isRouteExecutionBusy;
    this.applyStoredSessionRunPolicy = options.applyStoredSessionRunPolicy;
    this.collaborationModeForRoute = options.collaborationModeForRoute;
    this.hasRouteCollaborationMode = options.hasRouteCollaborationMode;
    this.applyRouteCollaborationModeToSession = options.applyRouteCollaborationModeToSession;
    this.syncRouteCollaborationModeFromSession = options.syncRouteCollaborationModeFromSession;
    this.recordSessionContextSnapshot = options.recordSessionContextSnapshot;
  }

  hasSessionSelection(routeKey: string): boolean {
    return this.selections.has(routeKey);
  }

  pendingInitialBindingForStatus(): InitialRouteBinding | undefined {
    return this.pendingInitialRouteBinding;
  }

  defaultWorkdir(): string {
    return this.cwd;
  }

  setDefaultWorkdir(cwd: string): void {
    this.cwd = cwd;
  }

  cancelSessionSelection(routeKey: string): boolean {
    return this.selections.delete(routeKey);
  }

  async createNewSession(message: ChannelMessage, target: ChannelTarget): Promise<CodexSession> {
    const session = await this.codex.startSession({
      routeKey: message.routeKey,
      cwd: this.cwd,
      title: `channel:${message.routeKey}`,
    });
    this.state.bindSession(message.routeKey, { ...session, backend: session.backend ?? this.backend });
    this.applyStoredSessionRunPolicy(session.id);
    this.selections.delete(message.routeKey);
    this.clearPendingInitialRouteBindingIfApplies(message);
    this.applyRouteCollaborationModeToSession(message.routeKey, session.id);
    await this.recordSnapshot(session.id, "bind");
    await this.delivery.sendText(target, [
      "已创建新会话",
      `Session: ${session.id}`,
      `Cwd: ${session.cwd}`,
      "Status: idle",
      `Mode: ${this.collaborationModeForRoute(message.routeKey, session.id)}`,
    ].join("\n"));
    return session;
  }

  async createNewAppChatSession(
    message: ChannelMessage,
    target: ChannelTarget,
    options: { firstPrompt?: string } = {},
  ): Promise<CodexSession> {
    const title = formatAppConversationTitle(message, target);
    const session = await this.codex.startSession({
      routeKey: message.routeKey,
      cwd: this.cwd,
      title,
    });
    this.state.bindSession(message.routeKey, { ...session, backend: session.backend ?? this.backend });
    this.applyStoredSessionRunPolicy(session.id);
    this.selections.delete(message.routeKey);
    this.clearPendingInitialRouteBindingIfApplies(message);
    this.applyRouteCollaborationModeToSession(message.routeKey, session.id);
    await this.recordSnapshot(session.id, "bind");
    const titleSync = await this.syncAppConversationTitle(session.id, title);
    const previewSync = await this.syncAppConversationPreview(session.id, options.firstPrompt || title);
    await this.delivery.sendText(target, this.newAppChatSessionText(session, title, titleSync, previewSync, Boolean(options.firstPrompt)));
    return session;
  }

  async ensureSession(message: ChannelMessage, options: EnsureSessionOptions = {}): Promise<CodexSession> {
    const binding = this.state.getBinding(message.routeKey);
    if (binding) {
      const stored = this.state.getSession(binding.sessionId);
      const backendSessionId = binding.backendSessionId ?? stored?.backendSessionId ?? stored?.session.backendSessionId;
      if (stored && !(this.backend === "claude" && backendSessionId && binding.sessionId !== backendSessionId)) return stored.session;
      const adapterSessionId = this.backend === "claude" && backendSessionId ? backendSessionId : binding.sessionId;
      const claim = adapterSessionId !== binding.sessionId
        ? this.state.claimSessionOwner(message.routeKey, adapterSessionId, { backend: this.backend, backendSessionId })
        : undefined;
      if (claim && !claim.ok) throw ownerConflictError(adapterSessionId, claim.owner.ownerRouteKey);
      let session: CodexSession;
      try {
        session = await this.codex.resumeSession(adapterSessionId, adapterSessionId === backendSessionId ? {
          cwd: stored?.session.cwd,
          title: stored?.session.title,
          createdAt: stored?.session.createdAt,
        } : {
          backendSessionId,
          cwd: stored?.session.cwd,
          title: stored?.session.title,
          createdAt: stored?.session.createdAt,
        });
      } catch (error) {
        if (claim?.ok && claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(message.routeKey, adapterSessionId, { backend: this.backend });
        throw error;
      }
      session.backend = session.backend ?? binding.backend ?? this.backend;
      session.backendSessionId = session.backendSessionId ?? backendSessionId;
      if (adapterSessionId !== binding.sessionId) this.state.unbindSession(message.routeKey);
      const activated = this.state.activateOwnedSession(message.routeKey, session, { backend: this.backend, backendSessionId });
      if (!activated.ok) {
        if (claim?.ok && claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(message.routeKey, adapterSessionId, { backend: this.backend });
        throw new Error(`session is owned by another route: ${activated.owner?.ownerRouteKey ?? "unknown"}`);
      }
      this.applyStoredSessionRunPolicy(session.id);
      if (options.recordResumeSnapshot ?? true) {
        await this.recordSnapshot(session.id, "resume");
      }
      return session;
    }
    if (this.shouldConsumePendingInitialRouteBinding(message)) {
      return await this.consumePendingInitialRouteBinding(message);
    }
    const session = await this.codex.startSession({
      routeKey: message.routeKey,
      cwd: this.cwd,
      title: `channel:${message.routeKey}`,
    });
    this.state.bindSession(message.routeKey, { ...session, backend: session.backend ?? this.backend });
    this.applyStoredSessionRunPolicy(session.id);
    this.applyRouteCollaborationModeToSession(message.routeKey, session.id);
    await this.recordSnapshot(session.id, "bind");
    return session;
  }

  async resumeOrUseSession(
    message: ChannelMessage,
    target: ChannelTarget,
    command: "resume" | "use",
    sessionRef: string | undefined,
  ): Promise<void> {
    if (command === "resume") {
      await this.handleResumeSession(message, target, sessionRef);
      return;
    }
    await this.handleUseSession(message, target, sessionRef);
  }

  async handleSessionSelectionReply(
    message: ChannelMessage,
    target: ChannelTarget,
    text: string,
  ): Promise<void> {
    const selection = this.selections.get(message.routeKey);
    if (!selection) return;
    if (isCancelSessionSelectionText(text)) {
      this.selections.delete(message.routeKey);
      await this.updateSelectionActionMessageOrSendText(target, selection, "已退出切换会话。");
      return;
    }
    if (sessionListStateExpired(selection.createdAt)) {
      this.selections.delete(message.routeKey);
      await this.updateSelectionActionMessageOrSendText(target, selection, "会话选择已过期。\n下一步：请重新发送 `/resume` 或 `/use`。");
      return;
    }
    const action = sessionPageAction(text);
    if (action) {
      selection.page += action === "next" ? 1 : -1;
      selection.createdAt = Date.now();
      await this.sendSessionSelection(target, selection, undefined, { updateExisting: true });
      return;
    }
    const choiceIndex = pageNumberFromText(text);
    if (choiceIndex === undefined) {
      await this.delivery.sendText(target, [
        "正在切换会话。",
        "下一步：请直接回复当前页列表编号，例如 1；回复 `n` 下一页，`p` 上一页；回复“取消”退出。",
      ].join("\n"));
      return;
    }
    if (await this.isRouteExecutionBusy(message.routeKey)) {
      await this.updateSelectionActionMessageOrSendText(target, selection, ROUTE_BUSY_MUTATION_REJECT_TEXT);
      return;
    }
    const page = paginateSessionList(selection.items, "selectable", selection.page, selection.pageSize);
    const choice = page.items[choiceIndex - 1];
    if (!choice) {
      await this.sendSessionSelection(target, selection, `没有第 ${choiceIndex} 项，请重新选择。`, { updateExisting: true });
      return;
    }
    const result = await this.bindSessionById(message, target, choice.id, choice);
    await this.updateSelectionActionMessageOrSendText(target, selection, this.bindSessionResultText(result));
  }

  shouldAskBeforeBindingSession(message: ChannelMessage): boolean {
    return this.unboundRoutePolicy === "ask"
      && !this.state.getBinding(message.routeKey)
      && !this.shouldConsumePendingInitialRouteBinding(message);
  }

  unboundRoutePromptText(message: ChannelMessage): string {
    return [
      "当前聊天还没有绑定 Codex 会话。",
      "请先发送 /new 创建新会话，或发送 /resume 进入会话选择。",
      `Route: ${message.routeKey}`,
    ].join("\n");
  }

  shouldConsumePendingInitialRouteBinding(message: ChannelMessage): boolean {
    if (this.state.getPendingBindingForMessage(message)) return true;
    return Boolean(
      this.pendingInitialRouteBinding
      && message.conversation.kind === "direct"
      && (!this.pendingInitialRouteKey || this.pendingInitialRouteKey === message.routeKey),
    );
  }

  claimPendingInitialRouteBindingRoute(message: ChannelMessage): void {
    if (!this.pendingInitialRouteBinding) return;
    if (this.pendingInitialRouteKey) return;
    if (message.conversation.kind !== "direct") return;
    if (this.state.getBinding(message.routeKey)) return;
    this.pendingInitialRouteKey = message.routeKey;
  }

  private async handleUseSession(
    message: ChannelMessage,
    target: ChannelTarget,
    sessionRef: string | undefined,
  ): Promise<void> {
    if (!sessionRef) {
      await this.beginSessionSelection(message, target);
      return;
    }
    const choiceIndex = pageNumberFromText(sessionRef);
    if (choiceIndex !== undefined) {
      const choices = await this.selectableSessionItemsForRoute(message.routeKey);
      const choice = choices[choiceIndex - 1];
      if (!choice) {
        await this.beginSessionSelection(message, target, `没有第 ${choiceIndex} 项，请重新选择。`);
        return;
      }
      const result = await this.bindSessionById(message, target, choice.id, choice);
      await this.sendBindSessionResultText(target, result);
      return;
    }

    const result = await this.bindSessionById(message, target, sessionRef);
    if (result.ok) {
      await this.sendBindSessionResultText(target, result);
      return;
    }
    if (result.reason === "owner_conflict") {
      await this.sendBindSessionResultText(target, result);
      return;
    }
    await this.beginSessionSelection(message, target, `没有找到 session \`${sessionRef}\`，请从下面选择。`);
  }

  private async handleResumeSession(
    message: ChannelMessage,
    target: ChannelTarget,
    query: string | undefined,
  ): Promise<void> {
    const allItems = await this.sessionItemsForRoute(message.routeKey);
    const items = recoverableSessionItems(allItems);
    if (!query) {
      await this.beginResumeSelection(message, target, items);
      return;
    }
    const choiceIndex = pageNumberFromText(query);
    if (choiceIndex !== undefined) {
      const choice = items[choiceIndex - 1];
      if (!choice) {
        await this.beginResumeSelection(message, target, items, `没有第 ${choiceIndex} 项，请重新选择。`);
        return;
      }
      const result = await this.bindSessionById(message, target, choice.id, choice);
      await this.sendBindSessionResultText(target, result);
      return;
    }
    if (query.trim().toLowerCase() === "last") {
      const choice = items.find((item) => !item.current) ?? items[0];
      if (!choice) {
        await this.beginResumeSelection(message, target, items);
        return;
      }
      const result = await this.bindSessionById(message, target, choice.id, choice);
      await this.sendBindSessionResultText(target, result);
      return;
    }
    const exactItem = allItems.find((item) => item.id === query || item.backendSessionId === query);
    if (exactItem) {
      const result = await this.bindSessionById(message, target, exactItem.id, exactItem);
      await this.sendBindSessionResultText(target, result);
      return;
    }

    const matches = matchSessionListItems(items, query);
    if (matches.length === 1) {
      const result = await this.bindSessionById(message, target, matches[0].id, matches[0]);
      await this.sendBindSessionResultText(target, result);
      return;
    }
    if (matches.length > 1) {
      await this.beginResumeSelection(message, target, matches, `找到 ${matches.length} 个匹配的会话，请回复编号选择。`);
      return;
    }
    if (this.backend === "claude" && isLikelyClaudeSessionId(query)) {
      const result = await this.bindSessionById(message, target, query);
      await this.sendBindSessionResultText(target, result);
      return;
    }
    await this.beginResumeSelection(message, target, items, `没有找到匹配 \`${query}\` 的可恢复会话，请从下面选择。`);
  }

  private async bindSessionById(
    message: ChannelMessage,
    _target: ChannelTarget,
    sessionId: string,
    hint?: Pick<SessionListItem, "backendSessionId" | "cwd" | "title" | "updatedAt">,
  ): Promise<BindSessionResult> {
    const resumeOptions = this.resumeOptionsForSession(sessionId, hint);
    const adapterSessionId = this.backend === "claude" && resumeOptions.backendSessionId ? resumeOptions.backendSessionId : sessionId;
    const claim = this.state.claimSessionOwner(message.routeKey, adapterSessionId, { backend: this.backend, backendSessionId: resumeOptions.backendSessionId });
    if (!claim.ok) {
      return { ok: false, reason: "owner_conflict", message: ownerConflictText(adapterSessionId, claim.owner.ownerRouteKey) };
    }
    try {
      const session = await this.codex.resumeSession(
        adapterSessionId,
        resumeOptions.backendSessionId === adapterSessionId ? { ...resumeOptions, backendSessionId: undefined } : resumeOptions,
      );
      const activated = this.state.activateOwnedSession(message.routeKey, session, { backend: this.backend, backendSessionId: resumeOptions.backendSessionId });
      if (!activated.ok) {
        if (claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(message.routeKey, adapterSessionId, { backend: this.backend });
        return { ok: false, reason: "owner_conflict", message: ownerConflictText(adapterSessionId, activated.owner?.ownerRouteKey ?? "unknown") };
      }
      const mode = this.syncRouteCollaborationModeFromSession(message.routeKey, session.id);
      this.applyStoredSessionRunPolicy(session.id);
      await this.recordSnapshot(session.id, "bind");
      this.selections.delete(message.routeKey);
      this.clearPendingInitialRouteBindingIfApplies(message);
      return { ok: true, session, mode };
    } catch (error) {
      if (claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(message.routeKey, adapterSessionId, { backend: this.backend });
      return { ok: false, reason: "resume_failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private resumeOptionsForSession(
    sessionId: string,
    hint?: Pick<SessionListItem, "backendSessionId" | "cwd" | "title" | "updatedAt">,
  ): CodexResumeSessionOptions {
    const stored = this.state.getSession(sessionId);
    const backendSessionId = hint?.backendSessionId ?? stored?.backendSessionId ?? stored?.session.backendSessionId ?? this.state.getSessionBackendSessionId(sessionId);
    return {
      backendSessionId,
      cwd: hint?.cwd ?? stored?.session.cwd,
      title: hint?.title ?? stored?.session.title,
      createdAt: stored?.session.createdAt ?? hint?.updatedAt,
    };
  }

  private async syncAppConversationTitle(
    sessionId: string,
    title: string,
  ): Promise<{ type: "synced" } | { type: "unsupported" } | { type: "failed"; message: string }> {
    if (!this.codex.setSessionTitle) return { type: "unsupported" };
    try {
      await this.codex.setSessionTitle(sessionId, title);
      return { type: "synced" };
    } catch (error) {
      return { type: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async syncAppConversationPreview(
    sessionId: string,
    preview: string,
  ): Promise<{ type: "synced" } | { type: "unsupported" } | { type: "failed"; message: string }> {
    if (!this.codex.setSessionPreview) return { type: "unsupported" };
    try {
      await this.codex.setSessionPreview(sessionId, preview);
      return { type: "synced" };
    } catch (error) {
      return { type: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async recordSnapshot(sessionId: string, observedBy: SessionContextSnapshotObservedBy): Promise<void> {
    await this.recordSessionContextSnapshot?.(sessionId, observedBy);
  }

  private newAppChatSessionText(
    session: CodexSession,
    title: string,
    titleSync: { type: "synced" } | { type: "unsupported" } | { type: "failed"; message: string },
    previewSync: { type: "synced" } | { type: "unsupported" } | { type: "failed"; message: string },
    hasFirstPrompt: boolean,
  ): string {
    const lines = [
      titleSync.type === "unsupported"
        ? "已创建 Codex session，但当前 Codex adapter 不支持同步 App 对话标题。"
        : "已创建 Codex App 对话",
      "",
      `Session: ${session.id}`,
      `标题: ${title}`,
      `工作目录: ${session.cwd}`,
    ];
    if (titleSync.type === "failed") {
      lines.push("", `标题同步失败: ${titleSync.message}`);
    }
    if (previewSync.type === "failed") {
      lines.push("", `App 列表 preview 同步失败: ${previewSync.message}`);
    }
    if (previewSync.type === "unsupported") {
      lines.push("", "当前 Codex adapter 不支持同步 App 列表 preview，空会话可能不会立刻出现在 Codex App 对话列表中。");
    }
    lines.push(
      "",
      hasFirstPrompt
        ? "正在把后续文本作为这个对话的第一条任务执行。"
        : "已写入 Codex preview，空对话也应能进入 Codex App 对话列表。",
      "如果 Codex App 已添加这个工作目录，会在 App 的对话列表中显示。",
    );
    return lines.join("\n");
  }

  private async consumePendingInitialRouteBinding(message: ChannelMessage): Promise<CodexSession> {
    const persisted = this.state.consumePendingBindingForMessage(message);
    const pending = persisted?.binding ?? this.pendingInitialRouteBinding;
    this.pendingInitialRouteBinding = undefined;
    this.pendingInitialRouteKey = undefined;
    if (!pending || pending.type === "new") {
      const session = await this.codex.startSession({
        routeKey: message.routeKey,
        cwd: this.cwd,
        title: `channel:${message.routeKey}`,
      });
      this.state.bindSession(message.routeKey, { ...session, backend: session.backend ?? this.backend });
      this.applyStoredSessionRunPolicy(session.id);
      this.applyRouteCollaborationModeToSession(message.routeKey, session.id);
      return session;
    }

    const sessionId = pending.sessionId;
    const pendingBackendSessionId = backendSessionIdForPending(pending);
    const pendingOwnerRouteKey = persisted ? pendingBindingOwnerRouteKey(persisted.id) : undefined;
    const existingOwner = this.state.getSessionOwner(sessionId, this.backend);
    const claim = persisted && pendingOwnerRouteKey && existingOwner?.ownerRouteKey === pendingOwnerRouteKey
      ? this.state.transferSessionOwner(pendingOwnerRouteKey, message.routeKey, sessionId, { backend: this.backend, backendSessionId: pendingBackendSessionId })
      : this.state.claimSessionOwner(message.routeKey, sessionId, { backend: this.backend, backendSessionId: pendingBackendSessionId });
    if (!claim.ok) throw ownerConflictError(sessionId, claim.owner?.ownerRouteKey ?? "unknown");
    let session: CodexSession;
    try {
      session = await this.codex.resumeSession(sessionId, {
        backendSessionId: pendingBackendSessionId,
      });
      session.backend = session.backend ?? this.backend;
      session.backendSessionId = session.backendSessionId ?? pendingBackendSessionId;
    } catch (error) {
      if ("newlyClaimed" in claim && claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(message.routeKey, sessionId);
      throw error;
    }
    const activated = this.state.activateOwnedSession(message.routeKey, session, { backend: this.backend, backendSessionId: pendingBackendSessionId });
    if (!activated.ok) {
      if ("newlyClaimed" in claim && claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(message.routeKey, sessionId);
      throw ownerConflictError(sessionId, activated.owner?.ownerRouteKey ?? "unknown");
    }
    if (this.hasRouteCollaborationMode(message.routeKey)) {
      this.applyRouteCollaborationModeToSession(message.routeKey, session.id);
    } else {
      this.syncRouteCollaborationModeFromSession(message.routeKey, session.id);
    }
    this.applyStoredSessionRunPolicy(session.id);
    return session;
  }

  private clearPendingInitialRouteBindingIfApplies(message: ChannelMessage): void {
    this.state.clearPendingBindingForMessage(message);
    if (this.shouldConsumePendingInitialRouteBinding(message)) {
      this.pendingInitialRouteBinding = undefined;
      this.pendingInitialRouteKey = undefined;
    }
  }

  private async beginSessionSelection(
    message: ChannelMessage,
    target: ChannelTarget,
    intro?: string,
  ): Promise<void> {
    let items: SessionListItem[];
    try {
      items = await buildSessionList({
        state: this.state,
        codex: this.codex,
        routeKey: message.routeKey,
        scope: "selectable",
      });
    } catch (error) {
      await this.delivery.sendText(target, `读取 Codex 会话列表失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const hiddenUnavailableCount = items.filter((item) => !item.selectable).length;
    const selectableItems = items.filter((item) => item.selectable);
    if (selectableItems.length === 0) {
      this.selections.delete(message.routeKey);
      await this.delivery.sendText(target, [
        intro,
        "没有可切换的 Codex 会话。",
        "可发送 /new 创建新会话。",
      ].filter(Boolean).join("\n"));
      return;
    }
    this.beginSelection(message.routeKey, selectableItems, {
      hiddenUnavailableCount,
      intro,
    });
    await this.sendSessionSelection(target, this.selections.get(message.routeKey)!);
  }

  private async beginResumeSelection(
    message: ChannelMessage,
    target: ChannelTarget,
    items: SessionListItem[],
    intro?: string,
  ): Promise<void> {
    if (items.length === 0) {
      this.selections.delete(message.routeKey);
      await this.delivery.sendText(target, [
        intro,
        "没有可恢复的 Codex 会话。",
        "可发送 /new 创建新会话。",
      ].filter(Boolean).join("\n"));
      return;
    }
    this.beginSelection(message.routeKey, items, {
      title: "恢复最近会话",
      scopeLabel: "最近可恢复",
      emptyText: "没有可恢复的 Codex 会话。",
      intro,
    });
    await this.sendSessionSelection(target, this.selections.get(message.routeKey)!);
  }

  private beginSelection(
    routeKey: string,
    items: SessionListItem[],
    options: {
      hiddenUnavailableCount?: number;
      title?: string;
      scopeLabel?: string;
      emptyText?: string;
      intro?: string;
    } = {},
  ): void {
    this.selections.set(routeKey, {
      items,
      page: 1,
      pageSize: SESSION_LIST_PAGE_SIZE,
      createdAt: Date.now(),
      hiddenUnavailableCount: options.hiddenUnavailableCount,
      title: options.title,
      scopeLabel: options.scopeLabel,
      emptyText: options.emptyText,
      intro: options.intro,
    });
  }

  private async selectableSessionItemsForRoute(routeKey: string): Promise<SessionListItem[]> {
    const items = await buildSessionList({
      state: this.state,
      codex: this.codex,
      routeKey,
      scope: "selectable",
    });
    return items.filter((item) => item.selectable);
  }

  private async sessionItemsForRoute(routeKey: string): Promise<SessionListItem[]> {
    return buildSessionList({
      state: this.state,
      codex: this.codex,
      routeKey,
      scope: "selectable",
    });
  }

  private async sendSessionSelection(
    target: ChannelTarget,
    selection: SessionSelectionState,
    intro?: string,
    options: { updateExisting?: boolean } = {},
  ): Promise<void> {
    const text = this.sessionSelectionText(selection, intro);
    if (options.updateExisting) {
      await this.updateSelectionActionMessageOrSendText(target, selection, text);
      return;
    }
    const result = await this.delivery.deliverActionMessage(target, this.sessionSelectionActionMessage(selection, text), text);
    selection.actionMessageId = result.messageId;
  }

  private async updateSelectionActionMessageOrSendText(
    target: ChannelTarget,
    selection: SessionSelectionState,
    text: string,
  ): Promise<void> {
    if (selection.actionMessageId) {
      const updated = await this.delivery.updateActionMessage(target, selection.actionMessageId, text);
      if (updated) return;
    }
    await this.delivery.sendText(target, text);
  }

  private async sendBindSessionResultText(target: ChannelTarget, result: BindSessionResult): Promise<void> {
    await this.delivery.sendText(target, this.bindSessionResultText(result));
  }

  private bindSessionResultText(result: BindSessionResult): string {
    if (!result.ok) return result.message;
    return this.boundSessionStatusText(result.session, result.mode);
  }

  private boundSessionStatusText(session: CodexSession, mode: CodexCollaborationMode): string {
    return [
      "已绑定 Codex 会话",
      `- 当前会话: \`${session.id}\``,
      `- 工作目录: \`${session.cwd}\``,
      `- 协作模式: ${formatCollaborationModeForStatus(mode)}`,
    ].join("\n");
  }

  private sessionSelectionActionMessage(selection: SessionSelectionState, text: string): ChannelActionMessage {
    const page = paginateSessionList(selection.items, "selectable", selection.page, selection.pageSize);
    const navigationButtons: ChannelButton[] = [];
    if (page.page > 1) navigationButtons.push({ text: "上一页", action: "reply:p" });
    if (page.page < page.totalPages) navigationButtons.push({ text: "下一页", action: "reply:n" });
    navigationButtons.push({ text: "取消", action: "reply:取消", style: "danger" });
    return {
      text,
      format: "markdown",
      buttonGroups: [
        page.items.map((_item, index): ChannelButton => ({
          text: `选择 ${index + 1}`,
          action: `reply:${index + 1}`,
          style: "primary",
        })),
        navigationButtons,
      ].filter((group) => group.length > 0),
    };
  }

  private sessionSelectionText(selection: SessionSelectionState, intro?: string): string {
    const page = paginateSessionList(selection.items, "selectable", selection.page, selection.pageSize);
    selection.page = page.page;
    return formatSessionListPage(page, {
      title: selection.title ?? "切换 Codex 会话",
      scopeLabel: selection.scopeLabel ?? "可切换会话",
      emptyText: selection.emptyText ?? "没有可切换的 Codex 会话。",
      selectionMode: true,
      hiddenUnavailableCount: selection.hiddenUnavailableCount,
      intro: intro ?? selection.intro,
    });
  }
}

function backendSessionIdForPending(binding: { type: "existing"; sessionId: string } | { type: "new" } | { type: "existing"; sessionId: string; backendSessionId?: string }): string | undefined {
  return binding.type === "existing" && "backendSessionId" in binding ? binding.backendSessionId : undefined;
}

function isLikelyClaudeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}
