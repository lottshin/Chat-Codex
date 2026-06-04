import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import type { BridgeChannelCapabilityController } from "../bridge-types.js";
import type { BridgeDelivery } from "../delivery.js";

export interface GroupReceiveCommandDeps {
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  channelCapabilities?: BridgeChannelCapabilityController;
}

export async function handleGroupReceiveCommand(
  deps: GroupReceiveCommandDeps,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  commandName: string,
): Promise<void> {
  if (!isFeishuChannelId(message.channelId)) {
    await deps.delivery.sendText(target, "当前渠道不支持 /group on/off。");
    return;
  }
  if (message.conversation.kind !== "direct") {
    await deps.delivery.sendText(target, "群聊接收开关只能在已配对的飞书私聊里操作。");
    return;
  }
  if (!deps.state.isRouteTrusted(message.routeKey)) {
    await deps.delivery.sendText(target, "当前飞书私聊还没有完成 Local Agent Bridge 配对，请先完成 /pair。");
    return;
  }
  const next = parseGroupReceiveMode(args[0]);
  if (next === undefined) {
    await deps.delivery.sendText(target, groupReceiveUsageText(commandName));
    return;
  }
  if (!deps.channelCapabilities) {
    await deps.delivery.sendText(target, "当前运行模式不支持修改飞书群聊接收开关。");
    return;
  }
  const result = await deps.channelCapabilities.setGroupEnabled(message.channelId, next);
  if (!result.ok) {
    await deps.delivery.sendText(target, result.message);
    return;
  }
  await deps.delivery.sendText(target, result.enabled ? groupReceiveEnabledText() : groupReceiveDisabledText());
}

function parseGroupReceiveMode(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "on" || normalized === "enable" || normalized === "enabled" || normalized === "open") return true;
  if (normalized === "off" || normalized === "disable" || normalized === "disabled" || normalized === "close") return false;
  return undefined;
}

function groupReceiveUsageText(commandName: string): string {
  return [
    "用法:",
    `/${commandName} on  开启飞书群聊接收`,
    `/${commandName} off 关闭飞书群聊接收`,
    "",
    "开启后，每个飞书群仍需单独配对；配对成功者会成为该群超级管理员。",
  ].join("\n");
}

function groupReceiveEnabledText(): string {
  return [
    "已开启飞书群聊接收。",
    "群里 @机器人 会进入 Local Agent Bridge 配对流程；每个群仍需单独配对。",
  ].join("\n");
}

function groupReceiveDisabledText(): string {
  return [
    "已关闭飞书群聊接收。",
    "Local Agent Bridge 会忽略飞书群聊消息；已有群 route、配对、权限和 session 绑定会保留。",
  ].join("\n");
}

function isFeishuChannelId(channelId: string): boolean {
  return channelId === "feishu"
    || channelId.startsWith("feishu-")
    || channelId === "lark"
    || channelId.startsWith("lark-");
}
