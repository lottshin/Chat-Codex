import type { CommandNamespaceProfile } from "../backend/metadata.js";
import type { CodexPromptInput } from "../codex/types.js";
import type { ChannelActionMessage, ChannelMessage, ChannelTarget } from "../protocol/channel.js";

export type PlanWorkflowChoice = "execute" | "edit" | "replan" | "cancel";

export interface PendingPlanWorkflow {
  routeKey: string;
  message: ChannelMessage;
  target: ChannelTarget;
  originalPrompt: CodexPromptInput;
  planText: string;
  sessionId: string;
  createdAt: string;
  actionMessageId?: string;
}

export class PlanWorkflowStore {
  private readonly workflows = new Map<string, PendingPlanWorkflow>();

  set(workflow: PendingPlanWorkflow): PendingPlanWorkflow {
    this.workflows.set(workflow.routeKey, workflow);
    return workflow;
  }

  get(routeKey: string): PendingPlanWorkflow | undefined {
    return this.workflows.get(routeKey);
  }

  delete(routeKey: string): boolean {
    return this.workflows.delete(routeKey);
  }

  has(routeKey: string): boolean {
    return this.workflows.has(routeKey);
  }
}

export function formatPlanWorkflowChoices(_commandProfile: CommandNamespaceProfile = "codex"): string {
  const planExecute = "/plan-execute";
  const planEdit = "/plan-edit";
  const replan = "/replan";
  return [
    "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    `${planExecute} 或 /1 Yes, and use auto mode`,
    `${planEdit} 或 /2 Yes, manually approve edits`,
    `${replan} <补充> 或 /3 <补充> Tell Claude what to change`,
  ].join("\n");
}

export function formatPlanWorkflowActionMessage(commandProfile: CommandNamespaceProfile = "codex"): ChannelActionMessage {
  return {
    text: formatPlanWorkflowChoices(commandProfile),
    buttonGroups: [[
      { text: "Use auto mode", action: "cmd:/plan-execute", style: "primary" },
      { text: "Manually approve edits", action: "cmd:/plan-edit", style: "default" },
      { text: "Tell Claude what to change", action: "cmd:/replan", style: "default" },
    ]],
  };
}

export function planExecutionPrompt(workflow: PendingPlanWorkflow): string {
  return [
    "请按以下已批准的计划执行。",
    "",
    "原始任务:",
    promptText(workflow.originalPrompt),
    "",
    "已批准计划:",
    workflow.planText,
  ].join("\n");
}

export function planReplanPrompt(workflow: PendingPlanWorkflow, notes: string): string {
  return [
    "请基于以下既有计划继续规划，不要执行代码修改。",
    "",
    "原始任务:",
    promptText(workflow.originalPrompt),
    "",
    "既有计划:",
    workflow.planText,
    "",
    notes.trim() ? `补充要求:\n${notes.trim()}` : "补充要求:\n请继续完善这个计划。",
  ].join("\n");
}

function promptText(input: CodexPromptInput): string {
  if (typeof input === "string") return input;
  return input.items.map((item) => item.type === "text" ? item.text : `[${item.type}] ${item.path}`).join("\n");
}
