import { selectionForApprovalAlias, unavailableApprovalDecisionMessage } from "../../approvals/choices.js";
import type { ApprovalDecision } from "../../approvals/types.js";
import type { ApprovalManager } from "../../approvals/approval-manager.js";
import type { CodexAdapter } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { BridgeDelivery } from "../delivery.js";
import { formatApprovalDecision } from "../formatters.js";

export interface ApprovalCommandOptions {
  approvals: ApprovalManager;
  codex: CodexAdapter;
  delivery: BridgeDelivery;
  suppressHandledText?: boolean;
}

export interface ApprovalCommandResult {
  approvalKey?: string;
  decision?: ApprovalDecision;
  handled: boolean;
}

export async function handleApprovalCommand(
  options: ApprovalCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  decision: ApprovalDecision,
  optionId?: string,
): Promise<ApprovalCommandResult> {
  const parsed = parseApprovalArgs(options.approvals, message.routeKey, args);
  const key = parsed.approvalKey ?? options.approvals.latest(message.routeKey)?.approvalKey;
  if (!key) {
    await options.delivery.sendText(target, "当前没有待处理审批。下一步：等待新的审批提示、发送 /status 查看当前状态，或直接发送普通消息继续任务。");
    return { handled: false };
  }
  try {
    const selected = options.approvals.get(key);
    const selection = optionId ? { decision, optionId } : selected?.routeKey === message.routeKey ? selectionForApprovalAlias(selected, decision) : { decision };
    if (!selection) {
      await options.delivery.sendText(target, unavailableApprovalDecisionMessage(decision));
      return { handled: false, approvalKey: key };
    }
    const pending = options.approvals.decide(key, message.routeKey, selection.decision, selection.optionId);
    await options.codex.resolveApproval?.(pending.adapterApprovalId ?? pending.approvalKey, selection.decision);
    if (!options.suppressHandledText) {
      await options.delivery.sendText(target, `审批已处理：${formatApprovalDecision(selection.decision)}，当前操作将继续执行。\n下一步：等待当前任务继续输出；如需补充信息，直接发送普通消息。`);
    }
    return { handled: true, approvalKey: pending.approvalKey, decision: selection.decision };
  } catch (error) {
    await options.delivery.sendText(target, error instanceof Error ? error.message : String(error));
    return { handled: false, approvalKey: key };
  }
}

function parseApprovalArgs(approvals: ApprovalManager, routeKey: string, args: string[]): {
  approvalKey?: string;
} {
  if (args.length === 0) return {};
  const [first = ""] = args;
  const knownApproval = approvals.get(first);
  if (knownApproval?.routeKey === routeKey) {
    return { approvalKey: first };
  }
  return {};
}
