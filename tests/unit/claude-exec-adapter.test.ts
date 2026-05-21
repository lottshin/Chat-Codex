import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeExecAdapter, parseClaudeJsonLine } from "../../src/claude/claude-exec-adapter.js";

test("parseClaudeJsonLine captures session id from system events", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }),
    "local-session",
    "turn-1",
  );

  assert.equal(parsed?.actualSessionId, "claude-session");
  assert.deepEqual(parsed?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "Claude Code: init",
    kind: "other",
  });
});

test("parseClaudeJsonLine maps assistant text to delta", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({
      type: "assistant",
      session_id: "claude-session",
      message: { content: [{ type: "text", text: "hello" }] },
    }),
    "local-session",
    "turn-1",
  );

  assert.equal(parsed?.actualSessionId, "claude-session");
  assert.equal(parsed?.text, "hello");
  assert.deepEqual(parsed?.event, {
    type: "assistant.delta",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "hello",
  });
});

test("parseClaudeJsonLine maps result to assistant completion", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({ type: "result", session_id: "claude-session", result: "done" }),
    "local-session",
    "turn-1",
  );

  assert.deepEqual(parsed?.event, {
    type: "assistant.completed",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "done",
  });
});

test("parseClaudeJsonLine maps tool use to progress", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }),
    "local-session",
    "turn-1",
  );

  assert.deepEqual(parsed?.event, {
    type: "assistant.progress",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "正在调用工具: Bash",
    kind: "command",
  });
});

test("ClaudeExecAdapter reports non-interactive approval support", () => {
  const adapter = new ClaudeExecAdapter();

  const status = adapter.getRunPolicyStatus();

  assert.equal(status.policy.permissionMode, "approval");
  assert.equal(status.interactiveApprovals, false);
  assert.equal(status.effectiveApprovalPolicy, "never");
  assert.match(status.note ?? "", /Claude Code print 模式/);
});

test("parseClaudeJsonLine preserves malformed output as plain text", () => {
  const parsed = parseClaudeJsonLine("plain output", "local-session", "turn-1");

  assert.deepEqual(parsed, { text: "plain output" });
});

test("parseClaudeJsonLine maps error events to failed turns", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({ type: "error", error: { message: "boom" } }),
    "local-session",
    "turn-1",
  );

  assert.deepEqual(parsed?.event, {
    type: "turn.failed",
    sessionId: "local-session",
    turnId: "turn-1",
    error: "boom",
  });
});

test("ClaudeExecAdapter builds full-permission args for local sessions", async () => {
  const adapter = new ClaudeExecAdapter();
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  adapter.setRunPolicy({ permissionMode: "full" }, session.id);

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.deepEqual(args.slice(0, 3), ["-p", "hello", "--output-format"]);
  assert.equal(args.includes("--permission-mode"), true);
  assert.equal(args.at(args.indexOf("--permission-mode") + 1), "bypassPermissions");
  assert.equal(args.includes("--allow-dangerously-skip-permissions"), true);
});

test("ClaudeExecAdapter builds resume args for assumed Claude session ids", async () => {
  const adapter = new ClaudeExecAdapter();
  await adapter.resumeSession("actual-claude-session");

  const args = adapter.buildArgsForTest("actual-claude-session", "hello");

  assert.deepEqual(args.slice(0, 3), ["--resume", "actual-claude-session", "-p"]);
});

test("ClaudeExecAdapter scopes run policy per session", async () => {
  const adapter = new ClaudeExecAdapter();
  const first = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  const second = await adapter.startSession({ routeKey: "route-2", cwd: process.cwd() });

  adapter.setRunPolicy({ permissionMode: "full" }, first.id);

  assert.equal(adapter.getRunPolicy(first.id).permissionMode, "full");
  assert.equal(adapter.getRunPolicy(second.id).permissionMode, "approval");
});

test("ClaudeExecAdapter adds model and plan-mode args", async () => {
  const adapter = new ClaudeExecAdapter();
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  adapter.setModelPolicy({ model: "sonnet", claudeEffort: "max" }, session.id);
  adapter.setCollaborationMode("plan", session.id);

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.equal(args.at(args.indexOf("--model") + 1), "sonnet");
  assert.equal(args.at(args.indexOf("--effort") + 1), "max");
  assert.equal(args.at(args.indexOf("--permission-mode") + 1), "plan");
});

test("ClaudeExecAdapter exposes compact support", async () => {
  const adapter = new ClaudeExecAdapter();
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  assert.equal(typeof adapter.compactSession, "function");
  assert.equal((await adapter.listSessions()).some((item) => item.id === session.id), true);
});

test("ClaudeExecAdapter maps Claude permission mode args", async () => {
  const adapter = new ClaudeExecAdapter();
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  adapter.setRunPolicy({ permissionMode: "approval", sandbox: "workspace-write", claudePermissionMode: "auto" }, session.id);

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.equal(args.at(args.indexOf("--permission-mode") + 1), "auto");
});
