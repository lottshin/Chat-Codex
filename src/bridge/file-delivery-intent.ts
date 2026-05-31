import { classifyFileActionIntent, isThirdPartyFileTarget } from "./file-action-intent.js";

export interface FileDeliveryIntentDecision {
  enabled: boolean;
  reason: "send_to_current_user" | "not_delivery" | "third_party_target" | "ambiguous";
}

const RECENT_FILE_DELIVERY_PATTERN = /^(?:请\s*)?(?:(?:把|将)\s*)?(?:(?:这个|这张|该|它|刚才(?:那个|的)?|上面(?:那个|的)?|上一条(?:里的)?|文件|图片|截图|报告|附件)\s*)?(?:发给我|发送给我|传给我|发我|发来|发过来|发一下|发送一下|传一下)(?:\s*(?:吧|谢谢|可以吗)?[。.!！?？]*)?$/i;

export function detectFileDeliveryIntent(text: string | undefined): FileDeliveryIntentDecision {
  const normalized = text?.trim();
  if (!normalized) return { enabled: false, reason: "ambiguous" };
  const intent = classifyFileActionIntent(normalized);
  if (intent.action === "blocked" && intent.reason === "third_party_target") {
    return { enabled: false, reason: "third_party_target" };
  }
  if (intent.action === "send_to_chat" && intent.target === "current_user") {
    return { enabled: true, reason: "send_to_current_user" };
  }
  return { enabled: false, reason: "not_delivery" };
}

export function detectRecentFileDeliveryIntent(text: string | undefined): FileDeliveryIntentDecision {
  const normalized = text?.trim();
  if (!normalized) return { enabled: false, reason: "ambiguous" };
  if (isThirdPartyFileTarget(normalized)) {
    return { enabled: false, reason: "third_party_target" };
  }
  if (RECENT_FILE_DELIVERY_PATTERN.test(normalized)) {
    return { enabled: true, reason: "send_to_current_user" };
  }
  return { enabled: false, reason: "not_delivery" };
}
