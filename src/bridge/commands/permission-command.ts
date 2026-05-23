import type { ClaudePermissionMode, CodexRunPolicy } from "../../codex/codex-cli.js";
import type { CodexAdapter } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import type { BridgeStatusText } from "../status-text.js";
import { isConfirmed } from "../formatters.js";

export interface PermissionCommandOptions {
  codex: CodexAdapter;
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
  statusText: BridgeStatusText;
  runPolicyStatus(sessionId?: string): ReturnType<NonNullable<CodexAdapter["getRunPolicyStatus"]>> | undefined;
}

export async function handlePermissionCommand(
  options: PermissionCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
): Promise<void> {
  if (!options.codex.getRunPolicy || !options.codex.setRunPolicy) {
    await options.delivery.sendText(target, "当前后端不支持运行时切换权限模式。");
    return;
  }
  const binding = options.state.getBinding(message.routeKey);
  const sessionId = binding?.sessionId;
  const rawMode = args[0]?.toLowerCase();
  if (!rawMode) {
    await options.delivery.sendText(target, options.statusText.permissionText(sessionId));
    return;
  }
  if (rawMode === "approval" || rawMode === "approve" || rawMode === "safe" || rawMode === "审批") {
    const policy: CodexRunPolicy = { permissionMode: "approval", sandbox: "workspace-write" };
    options.codex.setRunPolicy(policy, sessionId);
    if (sessionId) options.state.setSessionRunPolicy(sessionId, policy);
    const policyStatus = options.runPolicyStatus(sessionId);
    await options.delivery.sendText(target, [
      "已切换到审批模式。",
      sessionId ? `作用范围: 当前会话 \`${sessionId}\`` : "作用范围: 默认策略（后续新会话）",
      "后续任务将使用 workspace-write sandbox。",
      policyStatus && !policyStatus.interactiveApprovals
        ? "注意：当前后端不支持交互审批；真实生效的 approval_policy 仍是 never。"
        : "后续如需审批，会继续通过当前后端处理。",
      policyStatus?.note ? `说明: ${policyStatus.note}` : undefined,
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  if (rawMode === "full" || rawMode === "danger" || rawMode === "完全权限") {
    if (!isConfirmed(args.slice(1))) {
      await options.delivery.sendText(target, [
        "完全权限会跳过审批或权限检查，当前后端可以直接执行命令并修改文件，风险很高。",
        "确认切换请直接发送:",
        "/permission full confirm",
      ].join("\n"));
      return;
    }
    const policy: CodexRunPolicy = { permissionMode: "full" };
    options.codex.setRunPolicy(policy, sessionId);
    if (sessionId) options.state.setSessionRunPolicy(sessionId, policy);
    await options.delivery.sendText(target, [
      "已切换到完全权限。",
      sessionId ? `作用范围: 当前会话 \`${sessionId}\`` : "作用范围: 默认策略（后续新会话）",
      "后续任务将跳过审批或权限检查。建议完成高权限任务后发送 /permission approval 切回安全模式。",
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  const claudeMode = parseClaudePermissionMode(rawMode);
  if (claudeMode) {
    if (claudeMode === "bypassPermissions" && !isConfirmed(args.slice(1))) {
      await options.delivery.sendText(target, [
        "Claude Code bypassPermissions 会跳过权限检查，风险很高。",
        "确认切换请直接发送:",
        `/permission ${rawMode} confirm`,
      ].join("\n"));
      return;
    }
    const policy: CodexRunPolicy = claudeMode === "bypassPermissions"
      ? { permissionMode: "full", claudePermissionMode: claudeMode }
      : { permissionMode: "approval", sandbox: "workspace-write", claudePermissionMode: claudeMode };
    options.codex.setRunPolicy(policy, sessionId);
    if (sessionId) options.state.setSessionRunPolicy(sessionId, policy);
    await options.delivery.sendText(target, [
      `已切换 Claude Code 权限模式: ${claudeMode}`,
      sessionId ? `作用范围: 当前会话 \`${sessionId}\`` : "作用范围: 默认策略（后续新会话）",
      `后续 Claude Code 任务将使用 \`--permission-mode ${claudeMode}\`。`,
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  await options.delivery.sendText(target, "未知权限模式。可用命令: /permission、/permission approval、/permission full confirm、/permission default、/permission auto、/permission acceptEdits、/permission dontAsk、/permission plan。");
}

function parseClaudePermissionMode(rawMode: string): ClaudePermissionMode | undefined {
  switch (rawMode) {
    case "default":
      return "default";
    case "auto":
      return "auto";
    case "acceptedits":
    case "accept-edits":
    case "accept_edits":
      return "acceptEdits";
    case "dontask":
    case "dont-ask":
    case "dont_ask":
      return "dontAsk";
    case "plan":
      return "plan";
    case "bypasspermissions":
    case "bypass-permissions":
    case "bypass_permissions":
      return "bypassPermissions";
  }
  return undefined;
}
