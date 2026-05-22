import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudePermissionIpcServer } from "../../src/claude/permission-ipc-server.js";
import { claudePermissionMcpConfig, handleClaudePermissionMcpRequest } from "../../src/claude/permission-mcp-transport.js";

test("ClaudePermissionIpcServer forwards authorized approval prompts", async () => {
  const calls: unknown[] = [];
  const server = new ClaudePermissionIpcServer({
    secret: "secret",
    mcp: {
      async handleApprovalPrompt(input) {
        calls.push(input);
        return { behavior: "allow" };
      },
    },
  });
  const info = await server.start();
  try {
    const response = await fetch(info.url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ context_token: "token-1", tool_name: "Bash", input: { command: "npm test" } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { behavior: "allow" });
    assert.deepEqual(calls, [{ context_token: "token-1", tool_name: "Bash", input: { command: "npm test" } }]);
  } finally {
    await server.stop();
  }
});

test("ClaudePermissionIpcServer denies unauthorized requests", async () => {
  const server = new ClaudePermissionIpcServer({
    secret: "secret",
    mcp: { async handleApprovalPrompt() { return { behavior: "allow" }; } },
  });
  const info = await server.start();
  try {
    const response = await fetch(info.url, { method: "POST", body: JSON.stringify({}) });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { behavior: "deny", message: "审批 IPC 未授权，已拒绝。" });
  } finally {
    await server.stop();
  }
});

test("claudePermissionMcpConfig builds stdio helper config", () => {
  assert.deepEqual(claudePermissionMcpConfig({
    helperCommand: "node",
    helperScript: "dist/src/claude-permission-mcp.js",
    ipcUrl: "http://127.0.0.1:1234/approval-prompt",
    secret: "secret",
  }), {
    mcpServers: {
      chat_codex: {
        command: "node",
        args: ["dist/src/claude-permission-mcp.js"],
        env: {
          CHAT_CODEX_PERMISSION_IPC_URL: "http://127.0.0.1:1234/approval-prompt",
          CHAT_CODEX_PERMISSION_IPC_SECRET: "secret",
        },
      },
    },
  });
});

test("handleClaudePermissionMcpRequest lists and calls approval_prompt", async () => {
  const ipcServer = new ClaudePermissionIpcServer({
    secret: "secret",
    mcp: { async handleApprovalPrompt() { return { behavior: "deny", message: "远程审批已拒绝。" }; } },
  });
  const info = await ipcServer.start();
  try {
    const initialized = await handleClaudePermissionMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, info);
    assert.equal((initialized?.result as { serverInfo?: { name?: string } }).serverInfo?.name, "chat_codex");

    const listed = await handleClaudePermissionMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, info);
    const tools = (listed?.result as { tools?: Array<{ name: string; outputSchema?: unknown }> }).tools;
    assert.equal(tools?.[0]?.name, "approval_prompt");
    assert.ok(tools?.[0]?.outputSchema);

    const called = await handleClaudePermissionMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "approval_prompt", arguments: { context_token: "token-1", tool_name: "Bash", input: { command: "npm test" } } },
    }, info);
    const content = (called?.result as { content?: Array<{ text: string }> }).content;
    assert.deepEqual(JSON.parse(content?.[0]?.text ?? "{}"), { behavior: "deny", message: "远程审批已拒绝。" });
  } finally {
    await ipcServer.stop();
  }
});

test("handleClaudePermissionMcpRequest fail-closes when IPC is unavailable", async () => {
  const called = await handleClaudePermissionMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "approval_prompt", arguments: { context_token: "token-1", tool_name: "Bash", input: { command: "npm test" } } },
  }, { url: "http://127.0.0.1:1/approval-prompt", secret: "secret" });

  const content = (called?.result as { content?: Array<{ text: string }> }).content;
  assert.deepEqual(JSON.parse(content?.[0]?.text ?? "{}"), { behavior: "deny", message: "审批 IPC 不可用，已拒绝。" });
});

test("handleClaudePermissionMcpRequest returns allow decisions as content JSON with updatedInput", async () => {
  const ipcServer = new ClaudePermissionIpcServer({
    secret: "secret",
    mcp: { async handleApprovalPrompt() { return { behavior: "allow" }; } },
  });
  const info = await ipcServer.start();
  try {
    const called = await handleClaudePermissionMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "approval_prompt", arguments: { tool_name: "Bash", input: { command: "npm test", timeout: 1000 } } },
    }, info);

    const content = (called?.result as { content?: Array<{ text: string }> }).content;
    assert.deepEqual(JSON.parse(content?.[0]?.text ?? "{}"), {
      behavior: "allow",
      updatedInput: { command: "npm test", timeout: 1000 },
    });
  } finally {
    await ipcServer.stop();
  }
});

test("stdio MCP helper responds before stdin closes", async () => {
  const ipcServer = new ClaudePermissionIpcServer({
    secret: "secret",
    mcp: { async handleApprovalPrompt() { return { behavior: "allow" }; } },
  });
  const info = await ipcServer.start();
  const child = spawn(process.execPath, ["dist/src/claude-permission-mcp.js"], {
    env: {
      ...process.env,
      CHAT_CODEX_PERMISSION_IPC_URL: info.url,
      CHAT_CODEX_PERMISSION_IPC_SECRET: info.secret,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const firstLine = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for MCP response")), 2000);
      child.stdout?.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(String(chunk).trim());
      });
      child.once("error", reject);
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);

    const parsed = JSON.parse(await firstLine) as { result?: { tools?: Array<{ name: string }> } };
    assert.equal(parsed.result?.tools?.[0]?.name, "approval_prompt");
  } finally {
    child.kill();
    await ipcServer.stop();
  }
});

