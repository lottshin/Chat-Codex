export interface FileDeliveryIntentDecision {
  enabled: boolean;
  reason: "send_to_current_user" | "not_delivery" | "third_party_target" | "ambiguous";
}

const THIRD_PARTY_TARGET_PATTERN = /(发给|发送给|传给|转给|发到|发送到).{0,16}(张三|李四|别人|其他人|他人|同事|群|群里|群聊|邮箱|email|mail)/i;
const DELIVERY_ACTION_PATTERN = /(发给我|发送给我|传给我|发我|发来|发过来|发一下|发送一下|作为附件|附件发|打包发|打包.*发|传一下|把.+发过来)/i;
const DELIVERABLE_PATTERN = /([a-zA-Z]:\\[^ \n\r\t]+|\/[^ \n\r\t]+|刚才生成|生成.*(报告|文件|压缩包|zip|图片|截图|pdf)|打包.*(zip|压缩包)|作为附件)/i;

export function detectFileDeliveryIntent(text: string | undefined): FileDeliveryIntentDecision {
  const normalized = text?.trim();
  if (!normalized) return { enabled: false, reason: "ambiguous" };
  if (THIRD_PARTY_TARGET_PATTERN.test(normalized)) {
    return { enabled: false, reason: "third_party_target" };
  }
  if (DELIVERY_ACTION_PATTERN.test(normalized) && DELIVERABLE_PATTERN.test(normalized)) {
    return { enabled: true, reason: "send_to_current_user" };
  }
  return { enabled: false, reason: "not_delivery" };
}
