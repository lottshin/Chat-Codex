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

test("parseClaudeJsonLine captures slash commands and skills from init events", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-session",
      slash_commands: ["/help", { name: "review" }, { command: "/security-review" }, { name: "" }],
      skills: [{ name: "simplify" }, { name: "/claude-api" }, "frontend-design"],
    }),
    "local-session",
    "turn-1",
  );

  assert.deepEqual(parsed?.promptSlashCommands, [
    "claude-api",
    "frontend-design",
    "help",
    "review",
    "security-review",
    "simplify",
  ]);
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

test("parseClaudeJsonLine maps ExitPlanMode tool use to plan event", () => {
  const parsed = parseClaudeJsonLine(
    JSON.stringify({
      type: "assistant",
      session_id: "claude-session",
      message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "# Plan\n- Do it" } }] },
    }),
    "local-session",
    "turn-1",
  );

  assert.equal(parsed?.actualSessionId, "claude-session");
  assert.equal(parsed?.text, "# Plan\n- Do it");
  assert.deepEqual(parsed?.event, {
    type: "assistant.plan",
    sessionId: "local-session",
    turnId: "turn-1",
    text: "# Plan\n- Do it",
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

test("ClaudeExecAdapter uses per-turn collaboration mode for plan args", async () => {
  const adapter = new ClaudeExecAdapter();
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const args = adapter.buildArgsForTest(session.id, "hello", { collaborationMode: "plan" });

  assert.equal(args.at(args.indexOf("--permission-mode") + 1), "plan");
});

test("ClaudeExecAdapter preserves slash prompts in print args", async () => {
  const adapter = new ClaudeExecAdapter();
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const args = adapter.buildArgsForTest(session.id, "/simplify Keep CASE");

  assert.deepEqual(args.slice(0, 3), ["-p", "/simplify Keep CASE", "--output-format"]);
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

test("ClaudeExecAdapter adds permission prompt tool when configured", async () => {
  const adapter = new ClaudeExecAdapter({ permissionPromptTool: "mcp__chat_codex__approval_prompt" });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.equal(args.at(args.indexOf("--permission-prompt-tool") + 1), "mcp__chat_codex__approval_prompt");
});

test("ClaudeExecAdapter omits permission prompt tool in full permission mode", async () => {
  const adapter = new ClaudeExecAdapter({ permissionPromptTool: "mcp__chat_codex__approval_prompt" });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  adapter.setRunPolicy({ permissionMode: "full" }, session.id);

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.equal(args.includes("--permission-prompt-tool"), false);
});

test("ClaudeExecAdapter adds MCP config args when configured", async () => {
  const adapter = new ClaudeExecAdapter({
    permissionPromptTool: "mcp__chat_codex__approval_prompt",
    mcpConfigPath: "D:/tmp/chat-codex-mcp.json",
    strictMcpConfig: true,
  });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.equal(args.at(args.indexOf("--mcp-config") + 1), "D:/tmp/chat-codex-mcp.json");
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.at(args.indexOf("--permission-prompt-tool") + 1), "mcp__chat_codex__approval_prompt");
});

test("ClaudeExecAdapter omits MCP config args in full permission mode", async () => {
  const adapter = new ClaudeExecAdapter({
    permissionPromptTool: "mcp__chat_codex__approval_prompt",
    mcpConfigPath: "D:/tmp/chat-codex-mcp.json",
    strictMcpConfig: true,
  });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  adapter.setRunPolicy({ permissionMode: "full" }, session.id);

  const args = adapter.buildArgsForTest(session.id, "hello");

  assert.equal(args.includes("--mcp-config"), false);
  assert.equal(args.includes("--strict-mcp-config"), false);
});

test("ClaudeExecAdapter registers tokenized approval contexts", () => {
  const adapter = new ClaudeExecAdapter();
  const target = {
    channelId: "mock",
    routeKey: "route-1",
    conversation: { id: "user", kind: "direct" as const },
    recipient: { id: "user" },
  };

  const registration = adapter.registerRunApprovalContext({
    routeKey: "route-1",
    requestedBy: "user",
    target,
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/repo",
  });

  assert.equal(typeof registration.token, "string");
  assert.equal(adapter.activeApprovalContextCount(), 1);
  assert.deepEqual(adapter.getOnlyActiveApprovalContext(), {
    routeKey: "route-1",
    requestedBy: "user",
    target,
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/repo",
  });
  assert.deepEqual(adapter.getApprovalContext(registration.token ?? ""), {
    routeKey: "route-1",
    requestedBy: "user",
    target,
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/repo",
  });
  registration.dispose();
  assert.equal(adapter.activeApprovalContextCount(), 0);
  assert.equal(adapter.getOnlyActiveApprovalContext(), undefined);
  assert.equal(adapter.getApprovalContext(registration.token ?? ""), undefined);
});
