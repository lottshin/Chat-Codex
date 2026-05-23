import type { ClaudeApprovalContext, ClaudeApprovalService, ClaudePermissionPromptResult } from "./approval-service.js";

export const CLAUDE_PERMISSION_MCP_SERVER_NAME = "chat_codex";
export const CLAUDE_PERMISSION_MCP_TOOL_NAME = "approval_prompt";
export const CLAUDE_PERMISSION_MCP_FULL_TOOL_NAME = "mcp__chat_codex__approval_prompt";

export interface ClaudePermissionMcpContextStore {
  get(token: string): ClaudeApprovalContext | undefined;
  getOnlyActive?(): ClaudeApprovalContext | undefined;
  activeCount?(): number;
}

export interface ClaudePermissionMcpServerOptions {
  approvals: Pick<ClaudeApprovalService, "requestPermission">;
  contexts: ClaudePermissionMcpContextStore;
}

export type ClaudePermissionMcpToolResult = ClaudePermissionPromptResult;

export class ClaudePermissionMcpServer {
  private readonly approvals: Pick<ClaudeApprovalService, "requestPermission">;
  private readonly contexts: ClaudePermissionMcpContextStore;

  constructor(options: ClaudePermissionMcpServerOptions) {
    this.approvals = options.approvals;
    this.contexts = options.contexts;
  }

  async handleApprovalPrompt(input: unknown): Promise<ClaudePermissionMcpToolResult> {
    const request = requestObject(input);
    if (!request) return deny("审批请求格式无效，已拒绝。");

    const token = stringValue(request.context_token ?? request.contextToken ?? request.token);
    const context = token ? this.contexts.get(token) : onlyActiveContext(this.contexts);
    if (!context) {
      if (token) return deny("远程审批上下文无效或已过期，已拒绝。");
      const count = this.contexts.activeCount?.() ?? 0;
      return count > 1 ? deny("存在多个远程审批上下文，已拒绝以避免串线。") : deny("缺少远程审批上下文，已拒绝。");
    }

    const payload = request.payload ?? request;
    try {
      return await this.approvals.requestPermission(payload, context);
    } catch {
      return deny("审批服务异常，已拒绝。");
    }
  }
}

function onlyActiveContext(contexts: ClaudePermissionMcpContextStore): ClaudeApprovalContext | undefined {
  if (contexts.activeCount?.() !== 1) return undefined;
  return contexts.getOnlyActive?.();
}

function requestObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function deny(message: string): ClaudePermissionMcpToolResult {
  return { behavior: "deny", message };
}
