import { isApprovalDecisionAvailable, unavailableApprovalDecisionMessage } from "../../approvals/choices.js";
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
}

export async function handleApprovalCommand(
  options: ApprovalCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  decision: ApprovalDecision,
): Promise<void> {
  const parsed = parseApprovalArgs(options.approvals, message.routeKey, args);
  const key = parsed.approvalKey ?? options.approvals.latest(message.routeKey)?.approvalKey;
  if (!key) {
    await options.delivery.sendText(target, "当前没有待处理审批。");
    return;
  }
  try {
    const selected = options.approvals.get(key);
    if (selected?.routeKey === message.routeKey && !isApprovalDecisionAvailable(selected, decision)) {
      await options.delivery.sendText(target, unavailableApprovalDecisionMessage(decision));
      return;
    }
    const pending = options.approvals.decide(key, message.routeKey, decision);
    await options.codex.resolveApproval?.(pending.adapterApprovalId ?? pending.approvalKey, decision);
    await options.delivery.sendText(target, `审批已处理: ${formatApprovalDecision(decision)}`);
  } catch (error) {
    await options.delivery.sendText(target, error instanceof Error ? error.message : String(error));
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
  return { approvalKey: first };
}
