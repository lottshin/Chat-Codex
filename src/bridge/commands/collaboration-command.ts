import type { CodexAdapter, CodexCollaborationMode } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import { commandBody } from "../formatters.js";

export interface CollaborationCommandOptions {
  codex: CodexAdapter;
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
  setRouteCollaborationMode(routeKey: string, mode: CodexCollaborationMode): void;
}

export async function handleCollaborationModeCommand(
  options: CollaborationCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  mode: CodexCollaborationMode,
  rawText: string,
  commandName: string,
): Promise<void> {
  if (!options.codex.setCollaborationMode || !options.codex.getCollaborationMode) {
    await options.delivery.sendText(target, "当前后端不支持 Plan mode 切换。");
    return;
  }
  const prompt = commandBody(rawText, commandName);
  options.setRouteCollaborationMode(message.routeKey, mode);
  const messageLines = mode === "plan"
    ? [
        "已进入 Plan mode。后续消息只做计划，不执行代码修改。",
        "发送 /code 切回默认执行模式。",
      ]
    : [
        "已切回默认执行模式。后续消息可按当前后端默认行为执行。",
        "发送 /plan 切回计划模式。",
      ];
  await options.delivery.sendText(target, [
    ...messageLines,
    options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；新模式只影响后续任务。" : undefined,
    prompt ? `已用 ${mode} mode 加入任务。` : undefined,
  ].filter(Boolean).join("\n"));
  if (prompt) {
    await options.routeQueue.enqueuePrompt(message, target, prompt, { collaborationMode: mode });
  }
}
