import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalManager } from "../approvals/approval-manager.js";
import { BridgeDelivery } from "../bridge/delivery.js";
import type { ChannelRegistry } from "../channels/registry.js";
import { SilentLogger, type Logger } from "../logging/logger.js";
import { ClaudeApprovalService } from "./approval-service.js";
import { ClaudePermissionIpcServer } from "./permission-ipc-server.js";
import { ClaudePermissionMcpServer } from "./permission-mcp-server.js";
import { claudePermissionMcpConfig } from "./permission-mcp-transport.js";
import { ClaudeExecAdapter } from "./claude-exec-adapter.js";
import type { ClaudeCommandResolution } from "./claude-process.js";
import type { CodexRunPolicy } from "../codex/codex-cli.js";

export interface ClaudeApprovalRuntimeOptions {
  channels: ChannelRegistry;
  approvals: ApprovalManager;
  logger?: Logger;
  approvalSendRetryDelayMs: number;
  runPolicy?: CodexRunPolicy;
  claudeCommand?: ClaudeCommandResolution;
}

export interface ClaudeApprovalRuntime {
  adapter: ClaudeExecAdapter;
  mcpConfigPath?: string;
  stop(): Promise<void>;
}

export async function createClaudeApprovalRuntime(options: ClaudeApprovalRuntimeOptions): Promise<ClaudeApprovalRuntime> {
  const logger = options.logger ?? new SilentLogger();
  const delivery = new BridgeDelivery({
    channels: options.channels,
    approvals: options.approvals,
    logger,
    approvalSendRetryDelayMs: options.approvalSendRetryDelayMs,
    backend: "claude",
  });
  let adapter: ClaudeExecAdapter | undefined;
  const approvalService = new ClaudeApprovalService({ approvals: options.approvals, delivery, logger });
  const mcp = new ClaudePermissionMcpServer({
    approvals: approvalService,
    contexts: {
      get: (token) => adapter?.getApprovalContext(token),
      getOnlyActive: () => adapter?.getOnlyActiveApprovalContext(),
      activeCount: () => adapter?.activeApprovalContextCount() ?? 0,
    },
  });
  const ipc = new ClaudePermissionIpcServer({ mcp });
  const ipcInfo = await ipc.start();
  const mcpConfigPath = await writeRuntimeMcpConfig(ipcInfo.url, ipcInfo.secret);
  adapter = new ClaudeExecAdapter({
    runPolicy: options.runPolicy,
    claudeCommand: options.claudeCommand,
    permissionPromptTool: "mcp__chat_codex__approval_prompt",
    mcpConfigPath,
    strictMcpConfig: true,
  });
  return {
    adapter,
    mcpConfigPath,
    stop: () => ipc.stop(),
  };
}

async function writeRuntimeMcpConfig(ipcUrl: string, secret: string): Promise<string> {
  await mkdir(join(tmpdir(), "chat-codex"), { recursive: true });
  const dir = join(tmpdir(), "chat-codex");
  const helperScript = resolve(fileURLToPath(new URL("../claude-permission-mcp.js", import.meta.url)));
  const configPath = join(dir, `claude-mcp-${process.pid}-${Date.now()}.json`);
  await writeFile(configPath, JSON.stringify(claudePermissionMcpConfig({
    helperCommand: process.execPath,
    helperScript,
    ipcUrl,
    secret,
  }), null, 2), "utf8");
  return configPath;
}
