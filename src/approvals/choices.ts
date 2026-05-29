import type { ApprovalDecision, ApprovalOption, PendingApproval } from "./types.js";

export interface ApprovalChoice {
  decision: ApprovalDecision;
  command?: string;
  numeric: string;
  description: string;
  buttonText: string;
  buttonStyle: "primary" | "default" | "danger";
  optionId?: string;
}

const DEFAULT_VISIBLE_DECISIONS: ApprovalDecision[] = ["approve", "approve-session", "deny"];

export function effectiveApprovalDecisions(approval: Pick<PendingApproval, "availableDecisions" | "approvalOptions">): ApprovalDecision[] {
  if (approval.approvalOptions?.length) return approval.approvalOptions.map((option) => option.decision);
  const decisions = approval.availableDecisions?.filter(uniqueDecision) ?? [];
  const visible = decisions.filter((decision) => decision !== "cancel");
  return visible.length > 0 ? visible : [...DEFAULT_VISIBLE_DECISIONS];
}

export function approvalChoices(approval: Pick<PendingApproval, "availableDecisions" | "approvalOptions">): ApprovalChoice[] {
  const options = approval.approvalOptions;
  if (options?.length) {
    return options.map((option, index) => ({
      decision: option.decision,
      command: commandForOption(option, options),
      numeric: `/${index + 1}`,
      description: option.description ?? option.label,
      buttonText: buttonTextForOption(option),
      buttonStyle: buttonStyleForOption(option),
      optionId: option.id,
    }));
  }
  return effectiveApprovalDecisions(approval).map((decision, index) => ({
    decision,
    command: commandForDecision(decision),
    numeric: `/${index + 1}`,
    description: descriptionForDecision(decision),
    buttonText: buttonTextForDecision(decision),
    buttonStyle: buttonStyleForDecision(decision),
  }));
}

export function formatApprovalChoiceLine(choice: ApprovalChoice): string {
  return choice.command ? `${choice.command} 或 ${choice.numeric}：${choice.description}` : `${choice.numeric}：${choice.description}`;
}

export function formatApprovalChoiceSummaryLine(choice: ApprovalChoice): string {
  return choice.command ? `- \`${choice.command}\` 或 \`${choice.numeric}\`：${choice.description}` : `- \`${choice.numeric}\`：${choice.description}`;
}

export interface ApprovalSelection {
  decision: ApprovalDecision;
  optionId?: string;
}

export function selectionForNumericApprovalChoice(
  approval: Pick<PendingApproval, "availableDecisions" | "approvalOptions"> | undefined,
  numeric: string,
): ApprovalSelection | undefined {
  const index = Number.parseInt(numeric, 10) - 1;
  if (!Number.isInteger(index) || index < 0) return undefined;
  const choice = approvalChoices(approval ?? { availableDecisions: undefined, approvalOptions: undefined })[index];
  return choice ? { decision: choice.decision, ...(choice.optionId ? { optionId: choice.optionId } : {}) } : undefined;
}

export function decisionForNumericApprovalChoice(
  approval: Pick<PendingApproval, "availableDecisions" | "approvalOptions"> | undefined,
  numeric: string,
): ApprovalDecision | undefined {
  return selectionForNumericApprovalChoice(approval, numeric)?.decision;
}

export function selectionForApprovalAlias(
  approval: Pick<PendingApproval, "availableDecisions" | "approvalOptions"> | undefined,
  decision: ApprovalDecision,
): ApprovalSelection | undefined {
  if (approval?.approvalOptions?.length) {
    const option = optionForAlias(approval.approvalOptions, decision);
    return option ? { decision: option.decision, optionId: option.id } : undefined;
  }
  if (approval && !isApprovalDecisionAvailable(approval, decision)) return undefined;
  return { decision };
}

export function isApprovalDecisionAvailable(
  approval: Pick<PendingApproval, "availableDecisions" | "approvalOptions">,
  decision: ApprovalDecision,
): boolean {
  return effectiveApprovalDecisions(approval).includes(decision);
}

export function unavailableApprovalDecisionMessage(decision: ApprovalDecision): string {
  return [
    `当前审批不支持${descriptionForDecision(decision)}。`,
    "下一步：请发送审批提示中实际列出的命令；不确定时发送 /status 查看当前待处理审批。",
  ].join("\n");
}

function commandForOption(option: ApprovalOption, options: ApprovalOption[]): string | undefined {
  if (option.decision === "approve" && !option.updatedPermissions?.length) return "/OK";
  if (option.decision === "deny") return "/NO";
  const persistentOptions = options.filter((candidate) => candidate.updatedPermissions?.length);
  if (persistentOptions.length === 1 && option.id === persistentOptions[0]?.id) return "/P";
  return undefined;
}

function optionForAlias(options: ApprovalOption[], decision: ApprovalDecision): ApprovalOption | undefined {
  if (decision === "approve") return options.find((option) => option.decision === "approve" && !option.updatedPermissions?.length);
  if (decision === "approve-session") {
    const persistentOptions = options.filter((option) => option.updatedPermissions?.length);
    if (persistentOptions.length === 1) return persistentOptions[0];
    return undefined;
  }
  if (decision === "deny") return options.find((option) => option.decision === "deny");
  return undefined;
}

function buttonTextForOption(option: ApprovalOption): string {
  if (option.decision === "deny") return "拒绝";
  if (option.decision === "approve" && !option.updatedPermissions?.length) return "允许";
  if (option.updatedPermissions?.some(isAcceptEditsUpdate)) return "允许编辑";
  if (option.updatedPermissions?.length || option.label === "Don't ask again") return "不再询问";
  return option.label;
}

function isAcceptEditsUpdate(update: unknown): boolean {
  return Boolean(update && typeof update === "object" && "type" in update && update.type === "setMode" && "mode" in update && update.mode === "acceptEdits");
}

function buttonStyleForOption(option: ApprovalOption): "primary" | "default" | "danger" {
  if (option.decision === "deny") return "danger";
  if (option.decision === "approve" && !option.updatedPermissions?.length) return "primary";
  return "default";
}

function buttonTextForDecision(decision: ApprovalDecision): string {
  if (decision === "approve") return "允许";
  if (decision === "approve-session") return "本会话允许";
  if (decision === "deny") return "拒绝";
  return "取消";
}

function buttonStyleForDecision(decision: ApprovalDecision): "primary" | "default" | "danger" {
  if (decision === "approve") return "primary";
  if (decision === "deny") return "danger";
  return "default";
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
