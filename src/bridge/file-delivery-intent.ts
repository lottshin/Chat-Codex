export interface FileDeliveryIntentDecision {
  enabled: boolean;
  reason: "send_to_current_user" | "not_delivery" | "third_party_target" | "ambiguous";
}

const THIRD_PARTY_TARGET_PATTERN = /(发给|发送给|传给|转给|发到|发送到).{0,16}(张三|李四|别人|其他人|他人|同事|群|群里|群聊|邮箱|email|mail)/i;
const DELIVERY_ACTION_PATTERN = /(发给我|发送给我|传给我|发我|发来|发过来|发一下|发送一下|作为附件|附件发|传一下|把.+发过来)/i;
const KNOWN_FILE_EXTENSION_PATTERN = "(?:png|jpe?g|gif|webp|bmp|tiff?|svg|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|html?|xml|log|rtf|zip|tar|gz|tgz|7z|rar)";
const WINDOWS_LOCAL_PATH_PATTERN = new RegExp(`[a-zA-Z]:\\\\[^\\n\\r\\t"'<>|?*]+\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b`, "i");
const POSIX_LOCAL_PATH_PATTERN = new RegExp(`(?:^|[\\s"'(（])/(?!/)[^\\s"'<>)]*\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b`, "i");
const RELATIVE_LOCAL_PATH_PATTERN = new RegExp(`(?:^|[\\s"'(（])\\.{1,2}[\\\\/][^\\s"'<>)]*\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b`, "i");
const LOCAL_LOCATION_FILE_PATTERN = new RegExp(`(桌面|下载目录|下载文件夹|Downloads?|Desktop|当前目录|当前文件夹|项目目录|本地|电脑|本机|磁盘|文件夹|目录).{0,40}(?:\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b|文件|附件)`, "i");
const GENERATED_DELIVERABLE_PATTERN = /(刚才生成|生成|导出|保存为|另存为|下载(?:下来)?|打包|压缩|转换成|转成|写成).{0,32}(报告|文件|附件|压缩包|zip|图片|截图|pdf|文档|表格|pptx?|xlsx?|docx?|csv|json|html?|网页|页面)/i;
const SCREENSHOT_DELIVERABLE_PATTERN = /(截图|截屏|截一张|截个图|重新截|二维码|登录码|登录二维码|页面截图|网页截图)/i;
const REMOTE_REFERENCE_PATTERN = /(https?:\/\/|www\.|网页链接|链接|网址|互联网上|网上|网页内容|网页|页面)/i;
const REMOTE_MATERIALIZE_PATTERN = /(下载(?:下来)?|保存为|另存为|导出|截图|截屏|生成|转换成|转成).{0,24}(文件|附件|pdf|图片|截图|网页|页面|html?|压缩包|zip)|(文件|附件|pdf|图片|截图|网页|页面|html?|压缩包|zip).{0,16}(下载(?:下来)?|保存|导出|生成|转换|转成)|(?:网页|页面).{0,12}(截图|截屏)/i;
const RECENT_FILE_DELIVERY_PATTERN = /^(?:请\s*)?(?:(?:把|将)\s*)?(?:(?:这个|这张|该|它|刚才(?:那个|的)?|上面(?:那个|的)?|上一条(?:里的)?|文件|图片|截图|报告|附件)\s*)?(?:发给我|发送给我|传给我|发我|发来|发过来|发一下|发送一下|传一下)(?:\s*(?:吧|谢谢|可以吗)?[。.!！?？]*)?$/i;

export function detectFileDeliveryIntent(text: string | undefined): FileDeliveryIntentDecision {
  const normalized = text?.trim();
  if (!normalized) return { enabled: false, reason: "ambiguous" };
  if (THIRD_PARTY_TARGET_PATTERN.test(normalized)) {
    return { enabled: false, reason: "third_party_target" };
  }
  if (!DELIVERY_ACTION_PATTERN.test(normalized)) {
    return { enabled: false, reason: "not_delivery" };
  }
  if (hasRemoteReference(normalized) && !hasRemoteMaterialization(normalized)) {
    return { enabled: false, reason: "not_delivery" };
  }
  if (hasLocalFileReference(normalized) || hasGeneratedDeliverable(normalized) || hasScreenshotDeliverable(normalized) || hasRemoteMaterialization(normalized)) {
    return { enabled: true, reason: "send_to_current_user" };
  }
  return { enabled: false, reason: "not_delivery" };
}

export function detectRecentFileDeliveryIntent(text: string | undefined): FileDeliveryIntentDecision {
  const normalized = text?.trim();
  if (!normalized) return { enabled: false, reason: "ambiguous" };
  if (THIRD_PARTY_TARGET_PATTERN.test(normalized)) {
    return { enabled: false, reason: "third_party_target" };
  }
  if (RECENT_FILE_DELIVERY_PATTERN.test(normalized)) {
    return { enabled: true, reason: "send_to_current_user" };
  }
  return { enabled: false, reason: "not_delivery" };
}

function hasLocalFileReference(text: string): boolean {
  const withoutRemoteUrls = stripRemoteUrls(text);
  return WINDOWS_LOCAL_PATH_PATTERN.test(withoutRemoteUrls)
    || POSIX_LOCAL_PATH_PATTERN.test(withoutRemoteUrls)
    || RELATIVE_LOCAL_PATH_PATTERN.test(withoutRemoteUrls)
    || LOCAL_LOCATION_FILE_PATTERN.test(withoutRemoteUrls);
}

function hasGeneratedDeliverable(text: string): boolean {
  return GENERATED_DELIVERABLE_PATTERN.test(text);
}

function hasScreenshotDeliverable(text: string): boolean {
  return SCREENSHOT_DELIVERABLE_PATTERN.test(text);
}

function hasRemoteReference(text: string): boolean {
  return REMOTE_REFERENCE_PATTERN.test(text);
}

function hasRemoteMaterialization(text: string): boolean {
  return REMOTE_MATERIALIZE_PATTERN.test(text) || hasScreenshotDeliverable(text);
}

function stripRemoteUrls(text: string): string {
  return text.replace(/https?:\/\/\S+|www\.\S+/gi, " ");
}
