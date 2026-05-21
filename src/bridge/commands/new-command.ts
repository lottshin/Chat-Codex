import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import {
  extractNewAppChatPrompt,
  isNewAppChatCommand,
} from "../app-conversation.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import type { BridgeRouteSteering } from "../route-steering.js";
import type { BridgeSessionFlow } from "../session-flow.js";
import type { BridgeDelivery } from "../delivery.js";
import { isConfirmed } from "../formatters.js";

export interface NewSessionCommandOptions {
  sessionFlow: BridgeSessionFlow;
  routeQueue: BridgeRouteQueue;
  routeSteering: BridgeRouteSteering;
  delivery: BridgeDelivery;
}

export async function handleNewSessionCommand(
  options: NewSessionCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  rawText: string,
): Promise<void> {
  if (args[0]?.toLowerCase() === "clear") {
    if (!isConfirmed(args.slice(1))) {
      await options.delivery.sendText(target, [
        "清空当前聊天上下文会创建并绑定一个新会话，原会话不会删除，但后续消息会从新上下文开始。",
        "确认清空请发送:",
        "/clear confirm",
      ].join("\n"));
      return;
    }
    await options.sessionFlow.createNewSession(message, target);
    return;
  }
  if (!isNewAppChatCommand(args)) {
    await options.sessionFlow.createNewSession(message, target);
    return;
  }

  const firstPrompt = extractNewAppChatPrompt(rawText);
  await options.sessionFlow.createNewAppChatSession(message, target, {
    firstPrompt: firstPrompt || undefined,
  });
  if (!firstPrompt) return;

  if (await options.routeSteering.tryEnqueue(message, target, firstPrompt)) return;
  await options.routeQueue.enqueuePrompt(message, target, firstPrompt);
}
