import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ClaudePermissionMcpToolResult } from "./permission-mcp-server.js";

export interface ClaudePermissionMcpConfigOptions {
  helperCommand: string;
  helperScript: string;
  ipcUrl: string;
  secret: string;
}

export function claudePermissionMcpConfig(options: ClaudePermissionMcpConfigOptions): Record<string, unknown> {
  return {
    mcpServers: {
      chat_codex: {
        command: options.helperCommand,
        args: [options.helperScript],
        env: {
          CHAT_CODEX_PERMISSION_IPC_URL: options.ipcUrl,
          CHAT_CODEX_PERMISSION_IPC_SECRET: options.secret,
        },
      },
    },
  };
}

export async function handleClaudePermissionMcpRequest(
  request: unknown,
  ipc: { url: string; secret: string },
): Promise<Record<string, unknown> | undefined> {
  const message = objectValue(request);
  if (!message) return undefined;
  const id = message.id;
  const method = stringValue(message.method);
  if (!method) return undefined;

  if (method === "initialize") {
    return response(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "chat_codex", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") return undefined;
  if (method === "tools/list") {
    return response(id, {
      tools: [{
        name: "approval_prompt",
        description: "Ask Local Agent Bridge remote channels to approve or deny a Claude Code tool request.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: { type: "object" },
            tool_use_id: { type: "string" },
          },
          required: ["tool_name", "input"],
          additionalProperties: true,
        },
        outputSchema: {
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: {
                behavior: { const: "allow" },
                updatedInput: { type: "object" },
              },
              required: ["behavior", "updatedInput"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                behavior: { const: "deny" },
                message: { type: "string" },
              },
              required: ["behavior", "message"],
              additionalProperties: false,
            },
          ],
        },
      }],
    });
  }
  if (method === "tools/call") {
    const params = objectValue(message.params);
    if (stringValue(params?.name) !== "approval_prompt") return response(id, toolResult(deny("未知 MCP 工具，已拒绝。"), params?.arguments));
    return response(id, toolResult(await forwardApprovalPrompt(params?.arguments, ipc), params?.arguments));
  }
  return response(id, {}, -32601, "Method not found");
}

export async function runClaudePermissionMcpStdio(): Promise<void> {
  const ipcUrl = process.env.CHAT_CODEX_PERMISSION_IPC_URL;
  const secret = process.env.CHAT_CODEX_PERMISSION_IPC_SECRET;
  if (!ipcUrl || !secret) throw new Error("missing Local Agent Bridge permission IPC config");

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as unknown;
    const result = await handleClaudePermissionMcpRequest(request, { url: ipcUrl, secret });
    await debugLog({ direction: "in", message: request });
    if (result) {
      await debugLog({ direction: "out", message: result });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
}

async function debugLog(entry: Record<string, unknown>): Promise<void> {
  const path = process.env.CHAT_CODEX_PERMISSION_MCP_DEBUG_LOG;
  if (!path) return;
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

async function forwardApprovalPrompt(payload: unknown, ipc: { url: string; secret: string }): Promise<ClaudePermissionMcpToolResult> {
  try {
    const response = await fetch(ipc.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ipc.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload ?? null),
    });
    const parsed = await response.json() as ClaudePermissionMcpToolResult;
    if (parsed.behavior === "allow" || parsed.behavior === "deny") return parsed;
    return deny("审批 IPC 返回无效，已拒绝。");
  } catch {
    return deny("审批 IPC 不可用，已拒绝。");
  }
}

function toolResult(result: ClaudePermissionMcpToolResult, originalArguments: unknown): Record<string, unknown> {
  const permissionResult = result.behavior === "allow"
    ? {
        behavior: "allow" as const,
        updatedInput: objectValue(objectValue(originalArguments)?.input) ?? {},
      }
    : result;
  return { content: [{ type: "text", text: JSON.stringify(permissionResult) }] };
}

function response(id: unknown, result: Record<string, unknown>, errorCode?: number, errorMessage?: string): Record<string, unknown> {
  return errorCode === undefined
    ? { jsonrpc: "2.0", id, result }
    : { jsonrpc: "2.0", id, error: { code: errorCode, message: errorMessage ?? "Error" } };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
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
