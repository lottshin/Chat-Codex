import { backendDisplayName, type AiBackend } from "../../backend/metadata.js";
import type { Logger } from "../../logging/logger.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import type { CodexAdapter, CodexSessionContextUsage } from "../../codex/types.js";
import type { BridgeDelivery } from "../delivery.js";
import type { CompactState } from "../bridge-types.js";
import { ROUTE_BUSY_MUTATION_REJECT_TEXT } from "../bridge-types.js";
import { formatNumber, formatPercent } from "../formatters.js";

export interface CompactCommandOptions {
  backend?: AiBackend;
  codex: CodexAdapter;
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  logger: Logger;
  compactStateForRoute(routeKey: string): CompactState;
  setCompactState(routeKey: string, state: CompactState): void;
  clearCompactState(routeKey: string): void;
  setSessionBackendSessionId?(sessionId: string, backend: "codex" | "claude", backendSessionId: string): void;
  isRouteExecutionBusy(routeKey: string): Promise<boolean>;
}

export async function handleCompactCommand(
  options: CompactCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
): Promise<void> {
  const binding = options.state.getBinding(message.routeKey);
  if (!binding) {
    await options.delivery.sendText(target, [
      "当前聊天还没有绑定会话。",
      "下一步：请先发送 /new 创建新会话，或发送 /resume 绑定已有会话。",
    ].join("\n"));
    return;
  }
  if (!options.codex.compactSession) {
    const assistantName = backendDisplayName(binding.backend ?? options.backend);
    await options.delivery.sendText(target, [
      `${assistantName} 暂不支持 /compact。`,
      `这只表示 ${assistantName} 不能压缩当前会话，不影响继续发送普通消息。`,
      `下一步：发送 /status 查看 ${assistantName} 会话状态，或直接发送普通消息继续任务。`,
    ].join("\n"));
    return;
  }

  const confirm = isCompactConfirm(args);
  if (!confirm) {
    const status = await options.codex.getStatus(binding.sessionId).catch(() => undefined);
    options.setCompactState(message.routeKey, {
      type: "confirming",
      sessionId: binding.sessionId,
      requestedAt: new Date().toISOString(),
    });
    options.logger.info("compact confirmation created", {
      routeKey: message.routeKey,
      sessionId: binding.sessionId,
    });
    await options.delivery.sendText(target, compactConfirmationText(binding.sessionId, status?.context));
    return;
  }

  const compactState = options.compactStateForRoute(message.routeKey);
  if (compactState.type !== "confirming") {
    await options.delivery.sendText(target, [
      "当前没有待确认的上下文压缩。",
      "下一步：请先发送 /compact 发起确认，再发送 /compact confirm 开始压缩。",
    ].join("\n"));
    return;
  }
  if (compactState.sessionId !== binding.sessionId) {
    options.clearCompactState(message.routeKey);
    await options.delivery.sendText(target, [
      "本次上下文压缩确认已过期。",
      `确认时 session: ${compactState.sessionId}`,
      `当前 session: ${binding.sessionId}`,
      "下一步：请重新发送 /compact 获取新的确认提示。",
    ].join("\n"));
    return;
  }
  if (await options.isRouteExecutionBusy(message.routeKey)) {
    await options.delivery.sendText(target, ROUTE_BUSY_MUTATION_REJECT_TEXT);
    return;
  }

  options.setCompactState(message.routeKey, {
    type: "running",
    sessionId: binding.sessionId,
    startedAt: new Date().toISOString(),
  });
  options.logger.info("compact started", {
    routeKey: message.routeKey,
    sessionId: binding.sessionId,
  });
  await options.delivery.sendTyping(target, true);
  await options.delivery.sendText(target, [
    "已开始压缩当前会话上下文。完成后会通知你。",
    "压缩期间同一聊天的大多数操作会暂停；可发送 /status 查看进度。",
  ].join("\n"));
  try {
    const result = await options.codex.compactSession(binding.sessionId);
    if (result.backend === "codex" || result.backend === "claude") {
      if (result.backendSessionId) options.setSessionBackendSessionId?.(binding.sessionId, result.backend, result.backendSessionId);
    }
    const status = await options.codex.getStatus(binding.sessionId).catch(() => undefined);
    options.logger.info("compact completed", {
      routeKey: message.routeKey,
      sessionId: binding.sessionId,
    });
    await options.delivery.sendText(target, compactCompletedText(result.sessionId, result.message, status?.context, result.beforeTokens, result.afterTokens));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    options.logger.warn("compact failed", {
      routeKey: message.routeKey,
      sessionId: binding.sessionId,
      error: messageText,
    });
    await options.delivery.sendText(target, [
      `上下文压缩失败：${messageText}`,
      "",
      "当前 session 绑定未改变，项目文件未修改。",
      "下一步：可稍后重试 /compact，发送 /status 查看状态，或直接发送普通消息继续任务。",
    ].join("\n"));
  } finally {
    options.clearCompactState(message.routeKey);
    await options.delivery.sendTyping(target, false);
  }
}

export function isCompactConfirm(args: string[]): boolean {
  const normalized = args.join(" ").trim().toLowerCase();
  return normalized === "confirm" || normalized === "yes" || normalized === "确认" || normalized === "我确认";
}

export function compactConfirmationText(sessionId: string, context: CodexSessionContextUsage | undefined): string {
  return [
    "即将压缩当前绑定的会话历史上下文。",
    "不会修改项目文件、git 状态或工作目录。",
    "",
    `Session: ${sessionId}`,
    formatCompactContextLine("压缩前上下文", context),
    "说明: 压缩会把较早对话替换为摘要，释放上下文空间。当前绑定和工作目录不变。",
    "",
    "下一步：确认要压缩请发送 /compact confirm；不想压缩请发送 /cancel。",
  ].join("\n");
}

function compactCompletedText(
  sessionId: string,
  message: string | undefined,
  context: CodexSessionContextUsage | undefined,
  beforeTokens: number | undefined,
  afterTokens: number | undefined,
): string {
  return [
    "上下文压缩完成。",
    "",
    `Session: ${sessionId}`,
    message ?? "摘要已写回当前会话，后续消息会基于压缩后的上下文继续。",
    beforeTokens !== undefined ? `压缩前 token: ${beforeTokens}` : undefined,
    context ? formatCompactContextLine("压缩后上下文", context) : afterTokens !== undefined
      ? `压缩后上下文: \`${formatNumber(afterTokens)} token\``
      : "压缩后上下文: 暂无 token 数据。可发送 /status 查看后续状态。",
    "下一步：可以继续发送普通消息；如需确认当前状态，请发送 /status。",
  ].filter(Boolean).join("\n");
}

function formatCompactContextLine(label: string, context: CodexSessionContextUsage | undefined): string {
  if (!context) return `${label}: 暂无 token 数据。`;
  const current = context.last.totalTokens;
  const window = context.modelContextWindow;
  if (window && window > 0) {
    return `${label}: \`${formatNumber(current)} / ${formatNumber(window)} token\`（${formatPercent(current / window)}，剩余 ${formatNumber(Math.max(window - current, 0))}）`;
  }
  return `${label}: \`${formatNumber(current)} token\``;
}
