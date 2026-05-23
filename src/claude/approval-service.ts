import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { PendingApproval } from "../approvals/types.js";
import type { BridgeDelivery } from "../bridge/delivery.js";
import type { Logger } from "../logging/logger.js";
import type { ChannelTarget } from "../protocol/channel.js";
import { normalizeClaudePermissionPrompt, type ClaudePermissionPromptContext } from "./permission-prompt.js";

export interface ClaudeApprovalContext extends ClaudePermissionPromptContext {
  routeKey: string;
  requestedBy: string;
  target: ChannelTarget;
}

export interface ClaudeApprovalServiceOptions {
  approvals: ApprovalManager;
  delivery: Pick<BridgeDelivery, "sendApprovalTextUntilDelivered">;
  logger?: Logger;
  waitTimeoutMs?: number | null;
}

export type ClaudePermissionPromptResult =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export class ClaudeApprovalService {
  private readonly approvals: ApprovalManager;
  private readonly delivery: Pick<BridgeDelivery, "sendApprovalTextUntilDelivered">;
  private readonly logger?: Logger;
  private readonly waitTimeoutMs?: number | null;

  constructor(options: ClaudeApprovalServiceOptions) {
    this.approvals = options.approvals;
    this.delivery = options.delivery;
    this.logger = options.logger;
    this.waitTimeoutMs = options.waitTimeoutMs;
  }

  async requestPermission(payload: unknown, context: ClaudeApprovalContext | undefined): Promise<ClaudePermissionPromptResult> {
    if (!context?.routeKey || !context.requestedBy || !context.target) {
      return deny("缺少远程审批上下文，已拒绝。");
    }
    const normalized = normalizeClaudePermissionPrompt(payload, context);
    if (!normalized.ok) {
      this.logger?.warn("claude permission prompt normalization failed", { reason: normalized.reason });
      return deny(normalized.reason === "missing_context" ? "缺少远程审批上下文，已拒绝。" : "审批请求格式无效，已拒绝。");
    }

    let pending: PendingApproval | undefined;
    try {
      pending = this.approvals.create(context.routeKey, context.requestedBy, normalized.approval);
      await this.delivery.sendApprovalTextUntilDelivered(context.routeKey, context.target, pending);
      const resolved = await this.approvals.waitForDecision(pending.approvalKey, { timeoutMs: this.waitTimeoutMs });
      return resultForApproval(resolved);
    } catch (error) {
      this.logger?.warn("claude permission approval failed", { error: error instanceof Error ? error.message : String(error) });
      if (pending?.status === "pending") this.approvals.cancelRoute(context.routeKey, "审批服务异常");
      return deny("审批取消或超时，已拒绝。");
    }
  }
}

function resultForApproval(approval: PendingApproval): ClaudePermissionPromptResult {
  if (approval.status === "resolved" && (approval.decision === "approve" || approval.decision === "approve-session")) {
    return { behavior: "allow" };
  }
  if (approval.status === "resolved" && approval.decision === "deny") {
    return deny("远程审批已拒绝。");
  }
  return deny("审批取消或超时，已拒绝。");
}

function deny(message: string): ClaudePermissionPromptResult {
  return { behavior: "deny", message };
}
