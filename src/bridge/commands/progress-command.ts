import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { ProgressDeliveryMode } from "../bridge-types.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeStatusText } from "../status-text.js";
import { parseProgressDeliveryMode } from "../formatters.js";

export interface ProgressCommandOptions {
  delivery: BridgeDelivery;
  statusText: BridgeStatusText;
  setProgressMode(routeKey: string, mode: ProgressDeliveryMode): void;
}

export async function handleProgressModeCommand(
  options: ProgressCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  rawMode: string | undefined,
): Promise<void> {
  if (!rawMode) {
    await options.delivery.sendText(target, options.statusText.progressModeText(message.routeKey));
    return;
  }
  const mode = parseProgressDeliveryMode(rawMode);
  if (!mode) {
    await options.delivery.sendText(target, options.statusText.invalidProgressModeText(rawMode));
    return;
  }
  options.setProgressMode(message.routeKey, mode);
  await options.delivery.sendText(target, options.statusText.progressModeText(message.routeKey));
}
