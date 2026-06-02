import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

async function importDiagnostics(): Promise<{
  classifyApprovalSmokeFailure(input: {
    sdkMessages: unknown[];
    approvalRequestCount?: number;
    approvalPromptSeen?: boolean;
    markerFileExists?: boolean;
  }): { code: string; detail: string; hints: string[] };
  summarizeSdkMessageForLog(message: unknown): string;
}> {
  return await import(pathToFileURL(path.join(repoRoot, "scripts", "smoke-claude-sdk-diagnostics.mjs")).href);
}

test("classifies SDK runs that never produce assistant or tool messages", async () => {
  const diagnostics = await importDiagnostics();

  const result = diagnostics.classifyApprovalSmokeFailure({
    sdkMessages: [
      { type: "system", subtype: "init", tools: ["PowerShell"], model: "claude-sonnet-4-6", permissionMode: "default" },
      { type: "system", subtype: "status", status: "requesting" },
    ],
  });

  assert.equal(result.code, "sdk_no_assistant_message");
  assert.match(result.detail, /assistant|tool_use/i);
  assert.ok(result.hints.some((hint) => /Claude Agent SDK|Claude Code/i.test(hint)));
});

test("classifies assistant replies that complete without requesting a tool", async () => {
  const diagnostics = await importDiagnostics();

  const result = diagnostics.classifyApprovalSmokeFailure({
    sdkMessages: [
      { type: "system", subtype: "init", tools: ["PowerShell"], model: "claude-sonnet-4-6", permissionMode: "default" },
      { type: "assistant", message: { content: [{ type: "text", text: "I cannot run that here." }] } },
      { type: "result", subtype: "success", result: "I cannot run that here." },
    ],
  });

  assert.equal(result.code, "sdk_assistant_without_tool_use");
  assert.match(result.detail, /没有产生 tool_use/);
});

test("classifies provider replies that say built-in tools are unavailable", async () => {
  const diagnostics = await importDiagnostics();

  const result = diagnostics.classifyApprovalSmokeFailure({
    sdkMessages: [
      { type: "system", subtype: "init", tools: ["Bash"], model: "claude-sonnet-4-6", permissionMode: "default" },
      { type: "assistant", message: { content: [{ type: "text", text: "I don't have a Bash tool available in this setup." }] } },
      { type: "result", subtype: "success", result: "I don't have a Bash tool available in this setup." },
    ],
  });

  assert.equal(result.code, "provider_tool_protocol_unsupported");
  assert.match(result.detail, /provider|tool_use/i);
});

test("classifies provider result text that says the Bash tool is unavailable", async () => {
  const diagnostics = await importDiagnostics();

  const result = diagnostics.classifyApprovalSmokeFailure({
    sdkMessages: [
      { type: "system", subtype: "init", tools: ["Bash"], model: "claude-sonnet-4-6", permissionMode: "default" },
      { type: "result", subtype: "success", result: "The Bash tool is unavailable in this environment." },
    ],
  });

  assert.equal(result.code, "provider_tool_protocol_unsupported");
});

test("classifies provider replies that mimic tool calls as plain text", async () => {
  const diagnostics = await importDiagnostics();

  const result = diagnostics.classifyApprovalSmokeFailure({
    sdkMessages: [
      { type: "system", subtype: "init", tools: ["probe_tool"], model: "claude-sonnet-4-6", permissionMode: "default" },
      { type: "assistant", message: { content: [{ type: "text", text: "invoke tool probe_tool with value is tool-ok" }] } },
      { type: "result", subtype: "success", result: "invoke tool probe_tool with value is tool-ok" },
    ],
  });

  assert.equal(result.code, "provider_tool_protocol_unsupported");
  assert.ok(result.hints.some((hint) => /provider|tool_use/i.test(hint)));
});

test("formats SDK init messages with tool, model, permission, and Claude Code metadata", async () => {
  const diagnostics = await importDiagnostics();

  const line = diagnostics.summarizeSdkMessageForLog({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    tools: ["PowerShell", "Read", "Write"],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    claude_code_version: "2.1.150",
  });

  assert.match(line, /tools=PowerShell,Read,Write/);
  assert.match(line, /model=claude-sonnet-4-6/);
  assert.match(line, /permissionMode=default/);
  assert.match(line, /claudeCode=2\.1\.150/);
});

test("strips ANSI control sequences from formatted SDK fields", async () => {
  const diagnostics = await importDiagnostics();

  const line = diagnostics.summarizeSdkMessageForLog({
    type: "system",
    subtype: "init",
    model: "\x1B[1mclaude-sonnet-4-6\x1B[22m",
  });

  assert.match(line, /model=claude-sonnet-4-6/);
  assert.doesNotMatch(line, /\x1B|\[1m|\[22m/);
});

test("strips orphaned SGR fragments from formatted SDK fields", async () => {
  const diagnostics = await importDiagnostics();

  const line = diagnostics.summarizeSdkMessageForLog({
    type: "system",
    subtype: "init",
    model: "[1m]claude-sonnet-4-6[22m]",
  });

  assert.match(line, /model=claude-sonnet-4-6/);
  assert.doesNotMatch(line, /\[1m|\[22m|model=.*\]/);
});
