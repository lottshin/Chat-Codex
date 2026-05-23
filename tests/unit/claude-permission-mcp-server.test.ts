import test from "node:test";
import assert from "node:assert/strict";
import type { ClaudeApprovalContext, ClaudePermissionPromptResult } from "../../src/claude/approval-service.js";
import {
  CLAUDE_PERMISSION_MCP_FULL_TOOL_NAME,
  CLAUDE_PERMISSION_MCP_SERVER_NAME,
  CLAUDE_PERMISSION_MCP_TOOL_NAME,
  ClaudePermissionMcpServer,
} from "../../src/claude/permission-mcp-server.js";

const context = approvalContext();
const payload = {
  tool_name: "Bash",
  input: { command: "npm test" },
};

test("ClaudePermissionMcpServer exposes Claude permission prompt names", () => {
  assert.equal(CLAUDE_PERMISSION_MCP_SERVER_NAME, "chat_codex");
  assert.equal(CLAUDE_PERMISSION_MCP_TOOL_NAME, "approval_prompt");
  assert.equal(CLAUDE_PERMISSION_MCP_FULL_TOOL_NAME, "mcp__chat_codex__approval_prompt");
});

test("ClaudePermissionMcpServer forwards valid approval prompts", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const server = serverFixture({
    result: { behavior: "allow" },
    calls,
  });

  const result = await server.handleApprovalPrompt({ context_token: "token-1", payload });

  assert.deepEqual(result, { behavior: "allow" });
  assert.deepEqual(calls, [{ payload, context }]);
});

test("ClaudePermissionMcpServer supports direct Claude payloads with context token", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const server = serverFixture({
    result: { behavior: "deny", message: "远程审批已拒绝。" },
    calls,
  });

  const directPayload = { contextToken: "token-1", tool_name: "Bash", input: { command: "npm test" } };
  const result = await server.handleApprovalPrompt(directPayload);

  assert.deepEqual(result, { behavior: "deny", message: "远程审批已拒绝。" });
  assert.deepEqual(calls, [{ payload: directPayload, context }]);
});

test("ClaudePermissionMcpServer denies malformed tool input", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const server = serverFixture({ result: { behavior: "allow" }, calls });

  assert.deepEqual(await server.handleApprovalPrompt(null), { behavior: "deny", message: "审批请求格式无效，已拒绝。" });
  assert.deepEqual(await server.handleApprovalPrompt([]), { behavior: "deny", message: "审批请求格式无效，已拒绝。" });
  assert.equal(calls.length, 0);
});

test("ClaudePermissionMcpServer denies missing or unknown context tokens", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const server = serverFixture({ result: { behavior: "allow" }, calls });

  assert.deepEqual(await server.handleApprovalPrompt({ payload }), { behavior: "deny", message: "缺少远程审批上下文，已拒绝。" });
  assert.deepEqual(await server.handleApprovalPrompt({ context_token: "missing", payload }), { behavior: "deny", message: "远程审批上下文无效或已过期，已拒绝。" });
  assert.equal(calls.length, 0);
});

test("ClaudePermissionMcpServer denies when approval service throws", async () => {
  const server = serverFixture({ error: new Error("boom") });

  assert.deepEqual(await server.handleApprovalPrompt({ token: "token-1", payload }), { behavior: "deny", message: "审批服务异常，已拒绝。" });
});

test("ClaudePermissionMcpServer uses the single active context when token is absent", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const server = serverFixture({ result: { behavior: "allow" }, calls, activeContexts: [context] });

  const result = await server.handleApprovalPrompt(payload);

  assert.deepEqual(result, { behavior: "allow" });
  assert.deepEqual(calls, [{ payload, context }]);
});

test("ClaudePermissionMcpServer denies tokenless prompts when multiple contexts are active", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const server = serverFixture({ result: { behavior: "allow" }, calls, activeContexts: [context, { ...context, routeKey: "route-2" }] });

  assert.deepEqual(await server.handleApprovalPrompt(payload), { behavior: "deny", message: "存在多个远程审批上下文，已拒绝以避免串线。" });
  assert.equal(calls.length, 0);
});

test("ClaudePermissionMcpServer prefers explicit token over active fallback", async () => {
  const calls: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }> = [];
  const tokenContext = { ...context, routeKey: "token-route" };
  const server = serverFixture({ result: { behavior: "allow" }, calls, tokenContext, activeContexts: [context] });

  const request = { context_token: "token-1", payload };
  const result = await server.handleApprovalPrompt(request);

  assert.deepEqual(result, { behavior: "allow" });
  assert.deepEqual(calls, [{ payload, context: tokenContext }]);
});

function serverFixture(options: {
  result?: ClaudePermissionPromptResult;
  error?: Error;
  calls?: Array<{ payload: unknown; context: ClaudeApprovalContext | undefined }>;
  tokenContext?: ClaudeApprovalContext;
  activeContexts?: ClaudeApprovalContext[];
}) {
  return new ClaudePermissionMcpServer({
    contexts: {
      get: (token) => token === "token-1" ? options.tokenContext ?? context : undefined,
      getOnlyActive: () => options.activeContexts?.length === 1 ? options.activeContexts[0] : undefined,
      activeCount: () => options.activeContexts?.length ?? 0,
    },
    approvals: {
      async requestPermission(requestPayload, requestContext) {
        options.calls?.push({ payload: requestPayload, context: requestContext });
        if (options.error) throw options.error;
        return options.result ?? { behavior: "allow" };
      },
    },
  });
}

function approvalContext(): ClaudeApprovalContext {
  return {
    routeKey: "mock:default:direct:user",
    requestedBy: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/repo",
    target: {
      channelId: "mock",
      routeKey: "mock:default:direct:user",
      conversation: { id: "user", kind: "direct" },
      recipient: { id: "user" },
    },
  };
}
