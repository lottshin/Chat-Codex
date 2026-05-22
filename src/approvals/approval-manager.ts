import type { ApprovalDecision, ApprovalRequest, PendingApproval } from "./types.js";
import { approvalChoices, formatApprovalChoiceLine } from "./choices.js";

export interface ApprovalManagerOptions {
  ttlMs?: number | null;
}

export interface ApprovalWaitOptions {
  timeoutMs?: number | null;
}

interface ApprovalWaiter {
  resolve(approval: PendingApproval): void;
  timer?: NodeJS.Timeout;
}

export class ApprovalManager {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly waiters = new Map<string, Set<ApprovalWaiter>>();
  private sequence = 0;
  private readonly ttlMs?: number;

  constructor(options: ApprovalManagerOptions = {}) {
    this.ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : undefined;
  }

  create(routeKey: string, requestedBy: string, request: ApprovalRequest): PendingApproval {
    const now = new Date();
    const approvalKey = this.nextKey();
    const pending: PendingApproval = {
      ...request,
      approvalKey,
      routeKey,
      requestedBy,
      requestedAt: now.toISOString(),
      ...(this.ttlMs !== undefined ? { expiresAt: new Date(now.getTime() + this.ttlMs).toISOString() } : {}),
      status: "pending",
    };
    this.approvals.set(approvalKey, pending);
    return pending;
  }

  list(routeKey?: string): PendingApproval[] {
    this.expireOld();
    return [...this.approvals.values()].filter((approval) => {
      if (approval.status !== "pending") return false;
      return routeKey ? approval.routeKey === routeKey : true;
    });
  }

  get(approvalKey: string): PendingApproval | undefined {
    this.expireOld();
    return this.approvals.get(approvalKey);
  }

  latest(routeKey: string): PendingApproval | undefined {
    return this.list(routeKey).at(-1);
  }

  waitForDecision(approvalKey: string, options: ApprovalWaitOptions = {}): Promise<PendingApproval> {
    this.expireOld();
    const existing = this.approvals.get(approvalKey);
    if (!existing) return Promise.reject(new Error(`未找到审批请求: ${approvalKey}`));
    if (existing.status !== "pending") return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter: ApprovalWaiter = { resolve };
      const waiters = this.waiters.get(approvalKey) ?? new Set<ApprovalWaiter>();
      waiters.add(waiter);
      this.waiters.set(approvalKey, waiters);
      const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : undefined;
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const pending = this.approvals.get(approvalKey);
          if (!pending || pending.status !== "pending") return;
          pending.status = "resolved";
          pending.decision = "cancel";
          pending.decisionReason = "审批超时";
          this.approvals.set(approvalKey, pending);
          this.notifyWaiters(pending);
        }, Math.max(timeoutMs, 0));
        waiter.timer.unref?.();
      }
    });
  }

  decide(approvalKey: string, routeKey: string, decision: ApprovalDecision): PendingApproval {
    this.expireOld();
    const pending = this.approvals.get(approvalKey);
    if (!pending) {
      throw new Error(`未找到审批请求: ${approvalKey}`);
    }
    if (pending.routeKey !== routeKey) {
      throw new Error(`审批请求 ${approvalKey} 不属于当前会话`);
    }
    if (pending.status !== "pending") {
      throw new Error(`审批请求 ${approvalKey} 已处理`);
    }
    pending.status = "resolved";
    pending.decision = decision;
    this.approvals.set(approvalKey, pending);
    this.notifyWaiters(pending);
    return pending;
  }

  cancelRoute(routeKey: string, reason?: string): PendingApproval[] {
    this.expireOld();
    const cancelled: PendingApproval[] = [];
    for (const pending of this.approvals.values()) {
      if (pending.routeKey !== routeKey || pending.status !== "pending") continue;
      pending.status = "resolved";
      pending.decision = "cancel";
      pending.decisionReason = reason?.trim() || undefined;
      this.approvals.set(pending.approvalKey, pending);
      this.notifyWaiters(pending);
      cancelled.push(pending);
    }
    return cancelled;
  }

  formatForChannel(pending: PendingApproval, backendName = "Codex"): string {
    const lines = [
      `${backendName} 请求审批`,
      `类型: ${pending.kind}`,
      `Session: ${shortId(pending.sessionId)}`,
      `Turn: ${shortId(pending.turnId)}`,
    ];
    if (pending.cwd) lines.push(`CWD: ${pending.cwd}`);
    if (pending.command) lines.push("Command:", pending.command);
    if (pending.reason) lines.push(`Reason: ${pending.reason}`);
    if (pending.risk) lines.push(`风险: ${pending.risk}`);
    lines.push(
      "",
      "快捷回复:",
      ...approvalChoices(pending).map(formatApprovalChoiceLine),
    );
    return lines.join("\n");
  }

  private expireOld(): void {
    if (this.ttlMs === undefined) return;
    const now = Date.now();
    for (const approval of this.approvals.values()) {
      if (approval.status === "pending" && approval.expiresAt && Date.parse(approval.expiresAt) <= now) {
        approval.status = "expired";
        this.approvals.set(approval.approvalKey, approval);
        this.notifyWaiters(approval);
      }
    }
  }

  private notifyWaiters(approval: PendingApproval): void {
    const waiters = this.waiters.get(approval.approvalKey);
    if (!waiters) return;
    this.waiters.delete(approval.approvalKey);
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(approval);
    }
  }

  private nextKey(): string {
    this.sequence += 1;
    return `a${this.sequence.toString(36).padStart(3, "0")}`;
  }
}

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}
