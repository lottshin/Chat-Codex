import type { ApprovalKind, ApprovalOption, ApprovalRequest } from "../approvals/types.js";

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
  const approvalOptions = permissionSuggestions ? approvalOptionsForPermissionSuggestions(permissionSuggestions) : undefined;
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
      ...(approvalOptions ? { approvalOptions } : {}),
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


function approvalOptionsForPermissionSuggestions(suggestions: unknown[]): ApprovalOption[] {
  const sessionOption = sessionApprovalOptionForPermissionSuggestions(suggestions);
  return [
    { id: "current", decision: "approve", label: "Yes", description: "Yes" },
    ...(sessionOption ? [sessionOption] : []),
    { id: "deny", decision: "deny", label: "No", description: "No" },
  ];
}

function sessionApprovalOptionForPermissionSuggestions(suggestions: unknown[]): ApprovalOption | undefined {
  const updates: Record<string, unknown>[] = [];
  for (const suggestion of suggestions) {
    const update = objectValue(suggestion);
    if (!update) return undefined;
    updates.push(update);
  }
  const acceptEdits = updates.some((suggestion) => stringValue(suggestion.type) === "setMode" && stringValue(suggestion.mode) === "acceptEdits");
  if (acceptEdits) {
    return {
      id: "mode-acceptEdits",
      decision: "approve-session",
      label: "Allow edits",
      description: "Yes, allow all edits during this session",
      updatedPermissions: suggestions,
    };
  }

  const ruleSuggestion = updates.find((suggestion) => stringValue(suggestion.type) === "addRules");
  if (!ruleSuggestion) return undefined;
  const ruleLabel = labelForRuleUpdate(ruleSuggestion) ?? "Yes, don't ask again for this session";
  return {
    id: optionIdForRuleUpdate(ruleSuggestion),
    decision: "approve-session",
    label: "Don't ask again",
    description: ruleLabel,
    updatedPermissions: suggestions,
  };
}

function optionIdForRuleUpdate(record: Record<string, unknown>): string {
  const rules = Array.isArray(record.rules) ? record.rules : [];
  const firstRule = objectValue(rules[0]);
  const toolName = stringValue(firstRule?.toolName);
  return toolName ? `remember-${toolName.toLowerCase()}` : "remember";
}

function labelForRuleUpdate(record: Record<string, unknown> | undefined): string | undefined {
  const rules = Array.isArray(record?.rules) ? record.rules : [];
  const firstRule = objectValue(rules[0]);
  const toolName = stringValue(firstRule?.toolName);
  const ruleContent = stringValue(firstRule?.ruleContent);
  if (toolName === "Bash") return `Yes, and don't ask again for: ${summarizeBashRule(ruleContent)}`;
  if (toolName === "Read") {
    const directory = summarizeReadDirectoryRule(ruleContent);
    return directory ? `Yes, allow reading from ${directory} during this session` : "Yes, allow reading during this session";
  }
  if (toolName) return `Yes, don't ask again for ${toolName}`;
  return undefined;
}

function summarizeBashRule(ruleContent: string | undefined): string {
  if (!ruleContent) return "this command";
  const parts = ruleContent.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? `${parts[0]} *` : ruleContent;
}

function summarizeReadDirectoryRule(ruleContent: string | undefined): string | undefined {
  if (!ruleContent) return undefined;
  const normalized = ruleContent.replace(/\\/g, "/").replace(/\/\*\*$/, "");
  const parts = normalized.split("/").filter(Boolean);
  const last = parts.at(-1);
  return last ? `${last}/` : undefined;
}
function riskyCommand(command: string): boolean {
  return /(^|\s)(sudo|rm|chmod|chown|mv|dd|mkfs|diskutil)(\s|$)/.test(command);
}
