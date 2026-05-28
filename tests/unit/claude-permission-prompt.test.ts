import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudePermissionPrompt } from "../../src/claude/permission-prompt.js";

const context = {
  sessionId: "session-1",
  turnId: "turn-1",
  cwd: "/repo",
};

test("normalizeClaudePermissionPrompt maps Bash payloads to command approvals", () => {
  const payload = {
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    input: {
      command: "sudo rm -rf /tmp/x",
      description: "cleanup",
    },
  };

  const result = normalizeClaudePermissionPrompt(payload, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.approval, {
    kind: "command",
    adapterApprovalId: "toolu-1",
    sessionId: "session-1",
    turnId: "turn-1",
    itemId: "toolu-1",
    command: "sudo rm -rf /tmp/x",
    cwd: "/repo",
    reason: "cleanup",
    risk: "high",
    availableDecisions: ["approve", "deny"],
    raw: payload,
  });
});

test("normalizeClaudePermissionPrompt uses active context over payload context", () => {
  const result = normalizeClaudePermissionPrompt({
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    sessionId: "spoofed-session",
    turnId: "spoofed-turn",
    cwd: "/spoofed",
    input: { command: "npm test" },
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.approval.sessionId, "session-1");
  assert.equal(result.approval.turnId, "turn-1");
  assert.equal(result.approval.cwd, "/repo");
});

test("normalizeClaudePermissionPrompt maps file tools to file_change approvals", () => {
  const result = normalizeClaudePermissionPrompt({
    tool_name: "Edit",
    tool_use_id: "toolu-2",
    input: { file_path: "src/a.ts" },
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.approval.kind, "file_change");
  assert.equal(result.approval.command, "Edit: src/a.ts");
});

test("normalizeClaudePermissionPrompt maps network tools to network approvals", () => {
  const result = normalizeClaudePermissionPrompt({
    tool_name: "WebFetch",
    input: { url: "https://example.com" },
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.approval.kind, "network");
  assert.equal(result.approval.itemId, "turn-1:WebFetch");
  assert.equal(result.approval.command, "WebFetch: https://example.com");
});

test("normalizeClaudePermissionPrompt maps unknown MCP tools to permission approvals", () => {
  const payload = {
    tool_name: "mcp__some_server__some_tool",
    input: { value: true },
  };

  const result = normalizeClaudePermissionPrompt(payload, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.approval.kind, "permissions");
  assert.equal(result.approval.command, "mcp__some_server__some_tool");
  assert.equal(result.approval.raw, payload);
});

test("normalizeClaudePermissionPrompt enables session approval when SDK suggestions are present", () => {
  const suggestions = [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read", ruleContent: "package.json" }] }];
  const payload = {
    tool_name: "Read",
    tool_use_id: "toolu-4",
    input: { file_path: "package.json" },
    suggestions,
  };

  const result = normalizeClaudePermissionPrompt(payload, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.approval.availableDecisions, ["approve", "approve-session", "deny"]);
  assert.deepEqual(result.approval.permissionSuggestions, suggestions);
});

test("normalizeClaudePermissionPrompt creates native-like approval options from SDK suggestions", () => {
  const addRule = { type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm test" }] };
  const addDirectory = { type: "addDirectories", destination: "session", directories: ["/repo/.claude"] };

  const result = normalizeClaudePermissionPrompt({
    tool_name: "Bash",
    tool_use_id: "toolu-options",
    input: { command: "npm test" },
    suggestions: [addRule, addDirectory],
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.approval.approvalOptions?.map((option) => ({ id: option.id, decision: option.decision, label: option.label, description: option.description, updatedPermissions: option.updatedPermissions })), [
    { id: "current", decision: "approve", label: "允许本次", description: "通过当前审批", updatedPermissions: undefined },
    { id: "remember-bash", decision: "approve-session", label: "不再询问", description: "允许此命令后续不再询问", updatedPermissions: [addRule, addDirectory] },
    { id: "deny", decision: "deny", label: "拒绝", description: "拒绝当前审批", updatedPermissions: undefined },
  ]);
});

test("normalizeClaudePermissionPrompt creates accept-edits approval option", () => {
  const acceptEdits = { type: "setMode", mode: "acceptEdits", destination: "session" };

  const result = normalizeClaudePermissionPrompt({
    tool_name: "Edit",
    tool_use_id: "toolu-edit-options",
    input: { file_path: "src/index.ts" },
    suggestions: [acceptEdits],
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.approval.approvalOptions?.map((option) => ({ id: option.id, decision: option.decision, label: option.label, description: option.description, updatedPermissions: option.updatedPermissions })), [
    { id: "current", decision: "approve", label: "允许本次", description: "通过当前审批", updatedPermissions: undefined },
    { id: "mode-acceptEdits", decision: "approve-session", label: "Accept edits", description: "自动接受后续编辑", updatedPermissions: [acceptEdits] },
    { id: "deny", decision: "deny", label: "拒绝", description: "拒绝当前审批", updatedPermissions: undefined },
  ]);
});

test("normalizeClaudePermissionPrompt ignores unrecognized SDK suggestions for options", () => {
  const result = normalizeClaudePermissionPrompt({
    tool_name: "Bash",
    tool_use_id: "toolu-options",
    input: { command: "npm test" },
    suggestions: [{ value: true }],
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.approval.approvalOptions?.map((option) => option.id), ["current", "deny"]);
});
test("normalizeClaudePermissionPrompt fails closed for malformed payloads", () => {
  for (const payload of [
    null,
    "bad",
    [],
    { input: {} },
    { tool_name: " ", input: {} },
    { tool_name: "Bash" },
    { tool_name: "Bash", input: "bad" },
  ]) {
    assert.deepEqual(normalizeClaudePermissionPrompt(payload, context), { ok: false, reason: "malformed_payload" });
  }
});

test("normalizeClaudePermissionPrompt fails closed for missing context", () => {
  const payload = { tool_name: "Bash", input: { command: "npm test" } };

  assert.deepEqual(normalizeClaudePermissionPrompt(payload, { turnId: "turn-1", cwd: "/repo" }), { ok: false, reason: "missing_context" });
  assert.deepEqual(normalizeClaudePermissionPrompt(payload, { sessionId: "session-1", cwd: "/repo" }), { ok: false, reason: "missing_context" });
  assert.deepEqual(normalizeClaudePermissionPrompt(payload, { sessionId: "session-1", turnId: "turn-1" }), { ok: false, reason: "missing_context" });
  assert.deepEqual(normalizeClaudePermissionPrompt(payload, { sessionId: " ", turnId: "turn-1", cwd: "/repo" }), { ok: false, reason: "missing_context" });
});

test("normalizeClaudePermissionPrompt supports camelCase payload aliases", () => {
  const result = normalizeClaudePermissionPrompt({
    toolName: "Bash",
    toolUseId: "toolu-3",
    toolInput: { command: ["npm", "test"] },
  }, context);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.approval.adapterApprovalId, "toolu-3");
  assert.equal(result.approval.itemId, "toolu-3");
  assert.equal(result.approval.command, "npm test");
  assert.equal(result.approval.risk, undefined);
});
