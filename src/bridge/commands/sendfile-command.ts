import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import { commandBody } from "../formatters.js";

export interface SendFileCommandOptions {
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
}

export async function handleSendFileCommand(
  options: SendFileCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  rawText: string,
  commandName = "sendfile",
): Promise<void> {
  const prompt = commandBody(rawText, commandName);
  const usageCommand = `/${commandName}`;
  if (!prompt) {
    await options.delivery.sendText(target, [
      "缺少任务内容。",
      `用法: \`${usageCommand} <你要当前后端做什么，并在最终结果里发文件>\``,
      "需要用这个命令开启本轮文件发送；普通消息里的本地路径不会自动作为附件发送。",
    ].join("\n"));
    return;
  }
  await options.routeQueue.enqueuePrompt(message, target, prompt, { sendFile: true });
}
