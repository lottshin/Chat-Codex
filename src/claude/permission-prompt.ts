import type { ApprovalKind, ApprovalRequest } from "../approvals/types.js";

export interface ClaudePermissionPromptContext {
  sessionId?: string;
  turnId?: string;
  cwd?: string;
}

export type ClaudePermissionPromptNormalizationResult =
  | { ok: true; approval: ApprovalRequest }
  | { ok: false; reason: "missing_context" | "malformed_payload" };

const CURRENT_DECISIONS = ["approve", "deny"] as const;
const SESSION_DECISIONS = ["approve", "approve-session", "deny"] as const;

export function normalizeClaudePermissionPrompt(
  payload: unknown,
  context: ClaudePermissionPromptContext,
): ClaudePermissionPromptNormalizationResult {
  const sessionId = stringValue(context.sessionId);
  const turnId = stringValue(context.turnId);
  const cwd = stringValue(context.cwd);
  if (!sessionId || !turnId || !cwd) return { ok: false, reason: "missing_context" };

  const prompt = objectValue(payload);
  if (!prompt) return { ok: false, reason: "malformed_payload" };

  const toolName = firstString(prompt.tool_name, prompt.toolName, prompt.tool);
  const input = objectValue(prompt.input) ?? objectValue(prompt.tool_input) ?? objectValue(prompt.toolInput);
  if (!toolName || !input) return { ok: false, reason: "malformed_payload" };

  const kind = kindForTool(toolName);
  const adapterApprovalId = firstString(prompt.tool_use_id, prompt.toolUseId, prompt.id, prompt.requestId, prompt.callId);
  const command = commandForTool(toolName, kind, input);
  const reason = firstString(prompt.reason, prompt.description, input.reason, input.description);
  const permissionSuggestions = arrayValue(prompt.suggestions);
  return {
    ok: true,
    approval: {
      kind,
      ...(adapterApprovalId ? { adapterApprovalId } : {}),
      sessionId,
      turnId,
      itemId: adapterApprovalId ?? `${turnId}:${toolName}`,
      ...(command ? { command } : {}),
      cwd,
      ...(reason ? { reason } : {}),
      ...(kind === "command" && command && riskyCommand(command) ? { risk: "high" } : {}),
      availableDecisions: permissionSuggestions ? [...SESSION_DECISIONS] : [...CURRENT_DECISIONS],
      ...(permissionSuggestions ? { permissionSuggestions } : {}),
      raw: payload,
    },
  };
}

function kindForTool(toolName: string): ApprovalKind {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized === "shell" || normalized.includes("command") || normalized.includes("terminal")) return "command";
  if (["edit", "multiedit", "write", "notebookedit"].includes(normalized) || normalized.includes("file") || normalized.includes("patch")) return "file_change";
  if (["webfetch", "websearch"].includes(normalized) || normalized.includes("fetch") || normalized.includes("search") || normalized.includes("network")) return "network";
  return "permissions";
}

function commandForTool(toolName: string, kind: ApprovalKind, input: Record<string, unknown>): string | undefined {
  if (kind === "command") return commandValue(input.command) ?? toolName;
  if (kind === "file_change") return summary(toolName, firstString(input.file_path, input.path, input.notebook_path));
  if (kind === "network") return summary(toolName, firstString(input.url, input.query));
  return toolName;
}

function summary(toolName: string, value: string | undefined): string {
  return value ? `${toolName}: ${value}` : toolName;
}

function commandValue(value: unknown): string | undefined {
  const command = stringValue(value);
  if (command) return command;
  if (!Array.isArray(value)) return undefined;
  const parts = value.map((item) => stringValue(item));
  return parts.every(Boolean) ? parts.join(" ") : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function riskyCommand(command: string): boolean {
  return /(^|\s)(sudo|rm|chmod|chown|mv|dd|mkfs|diskutil)(\s|$)/.test(command);
}
