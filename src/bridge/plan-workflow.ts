import type { CodexPromptInput } from "../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";

export type PlanWorkflowChoice = "execute" | "edit" | "replan" | "cancel";

export interface PendingPlanWorkflow {
  routeKey: string;
  message: ChannelMessage;
  target: ChannelTarget;
  originalPrompt: CodexPromptInput;
  planText: string;
  sessionId: string;
  createdAt: string;
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

export function formatPlanWorkflowChoices(): string {
  return [
    "Chat-Codex 计划快捷回复（不是 Claude 原生 TUI 选项）：",
    "/plan-execute 或 /1 执行这个计划，继续按当前权限/审批策略处理工具请求",
    "/plan-edit 或 /2 执行这个计划，并切到 Claude acceptEdits 语义（自动接受文件编辑，工具权限仍按当前策略）",
    "/replan <补充> 或 /3 <补充> 继续规划/修改计划",
    "/plan-cancel 或 /4 取消这个待执行计划",
  ].join("\n");
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
