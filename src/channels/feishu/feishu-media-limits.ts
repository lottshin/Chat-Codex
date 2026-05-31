import type { ChannelMedia } from "../../protocol/channel.js";

export const FEISHU_IMAGE_MESSAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MESSAGE_MAX_BYTES = 30 * 1024 * 1024;

export type FeishuMediaDeliveryKind = "image" | "file" | "drive";

export interface FeishuMediaDeliveryDecision {
  kind: FeishuMediaDeliveryKind;
  reason:
    | "image_message"
    | "large_image_as_file"
    | "file_message"
    | "drive_large_file";
}

export function decideFeishuMediaDelivery(media: Pick<ChannelMedia, "type">, sizeBytes: number): FeishuMediaDeliveryDecision {
  if (media.type === "image" && sizeBytes <= FEISHU_IMAGE_MESSAGE_MAX_BYTES) {
    return { kind: "image", reason: "image_message" };
  }
  if (media.type === "image" && sizeBytes <= FEISHU_FILE_MESSAGE_MAX_BYTES) {
    return { kind: "file", reason: "large_image_as_file" };
  }
  if (sizeBytes <= FEISHU_FILE_MESSAGE_MAX_BYTES) {
    return { kind: "file", reason: "file_message" };
  }
  return { kind: "drive", reason: "drive_large_file" };
}
