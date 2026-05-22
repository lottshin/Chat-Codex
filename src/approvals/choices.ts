import type { ApprovalDecision, PendingApproval } from "./types.js";

export interface ApprovalChoice {
  decision: ApprovalDecision;
  command: string;
  numeric: string;
  description: string;
}

const DEFAULT_VISIBLE_DECISIONS: ApprovalDecision[] = ["approve", "approve-session", "deny"];

export function effectiveApprovalDecisions(approval: Pick<PendingApproval, "availableDecisions">): ApprovalDecision[] {
  const decisions = approval.availableDecisions?.filter(uniqueDecision) ?? [];
  const visible = decisions.filter((decision) => decision !== "cancel");
  return visible.length > 0 ? visible : [...DEFAULT_VISIBLE_DECISIONS];
}

export function approvalChoices(approval: Pick<PendingApproval, "availableDecisions">): ApprovalChoice[] {
  return effectiveApprovalDecisions(approval).map((decision, index) => ({
    decision,
    command: commandForDecision(decision),
    numeric: `/${index + 1}`,
    description: descriptionForDecision(decision),
  }));
}

export function formatApprovalChoiceLine(choice: ApprovalChoice): string {
  return `${choice.command} 或 ${choice.numeric} ${choice.description}`;
}

export function decisionForNumericApprovalChoice(
  approval: Pick<PendingApproval, "availableDecisions"> | undefined,
  numeric: string,
): ApprovalDecision | undefined {
  const index = Number.parseInt(numeric, 10) - 1;
  if (!Number.isInteger(index) || index < 0) return undefined;
  return approvalChoices(approval ?? { availableDecisions: undefined })[index]?.decision;
}

export function isApprovalDecisionAvailable(
  approval: Pick<PendingApproval, "availableDecisions">,
  decision: ApprovalDecision,
): boolean {
  return effectiveApprovalDecisions(approval).includes(decision);
}

export function unavailableApprovalDecisionMessage(decision: ApprovalDecision): string {
  return `当前审批不支持${descriptionForDecision(decision)}。`;
}

function commandForDecision(decision: ApprovalDecision): string {
  if (decision === "approve") return "/OK";
  if (decision === "approve-session") return "/P";
  if (decision === "deny") return "/NO";
  return "/CANCEL";
}

function descriptionForDecision(decision: ApprovalDecision): string {
  if (decision === "approve") return "通过当前审批";
  if (decision === "approve-session") return "本会话通过，后续同类操作尽量不再询问";
  if (decision === "deny") return "拒绝当前审批";
  return "取消当前审批";
}

function uniqueDecision(decision: ApprovalDecision, index: number, decisions: ApprovalDecision[]): boolean {
  return decisions.indexOf(decision) === index;
}
