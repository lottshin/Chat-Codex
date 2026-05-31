export type FileActionIntentAction = "send_to_chat" | "download_to_local" | "blocked" | "none";
export type FileActionIntentTarget = "current_user" | "local_computer" | "third_party" | "none";
export type FileActionIntentSource = "local" | "generated" | "remote_materialized" | "cloud" | "remote" | "unspecified";
export type FileActionIntentReason = "empty" | "not_delivery" | "third_party_target" | "plain_remote_reference";

export interface FileActionIntent {
  action: FileActionIntentAction;
  target: FileActionIntentTarget;
  source: FileActionIntentSource;
  reason?: FileActionIntentReason;
}

const KNOWN_FILE_EXTENSION_PATTERN = "(?:png|jpe?g|gif|webp|bmp|tiff?|svg|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|html?|xml|log|rtf|zip|tar|gz|tgz|7z|rar)";
const WINDOWS_LOCAL_PATH_PATTERN = new RegExp(`[a-zA-Z]:\\\\[^\\n\\r\\t"'<>|?*]+\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b`, "i");
const POSIX_LOCAL_PATH_PATTERN = new RegExp(`(?:^|[\\s"'(（])/(?!/)[^\\s"'<>)]*\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b`, "i");
const RELATIVE_LOCAL_PATH_PATTERN = new RegExp(`(?:^|[\\s"'(（])\\.{1,2}[\\\\/][^\\s"'<>)]*\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b`, "i");
const LOCAL_LOCATION_FILE_PATTERN = new RegExp(`(桌面|下载目录|下载文件夹|Downloads?|Desktop|当前目录|当前文件夹|项目目录|本地|电脑|本机|磁盘|文件夹|目录).{0,40}(?:\\.${KNOWN_FILE_EXTENSION_PATTERN}\\b|文件|附件)`, "i");
const GENERATED_DELIVERABLE_PATTERN = /(刚才生成|生成|导出|保存为|另存为|打包|压缩|转换成|转成|写成).{0,32}(报告|文件|附件|压缩包|zip|图片|截图|pdf|文档|表格|pptx?|xlsx?|docx?|csv|json|html?|网页|页面)/i;
const SCREENSHOT_DELIVERABLE_PATTERN = /(截图|截屏|截一张|截个图|重新截|二维码|登录码|登录二维码|页面截图|网页截图)/i;
const REMOTE_REFERENCE_PATTERN = /(https?:\/\/|www\.|网页链接|链接|网址|互联网上|网上|网页内容|网页|页面)/i;
const REMOTE_MATERIALIZE_PATTERN = /(下载(?:下来)?|保存为|另存为|导出|截图|截屏|生成|转换成|转成).{0,24}(文件|附件|pdf|图片|截图|网页|页面|html?|压缩包|zip)|(文件|附件|pdf|图片|截图|网页|页面|html?|压缩包|zip).{0,16}(下载(?:下来)?|保存|导出|生成|转换|转成)|(?:网页|页面).{0,12}(截图|截屏)/i;
const DELIVERY_ACTION_PATTERN = /(发给我|发送给我|传给我|发我|发来|发过来|发一下|发送一下|作为附件|附件发|传一下|把.+发过来)/i;
const LOCAL_DOWNLOAD_ACTION_PATTERN = /(下载|保存|存到|拉到本地|下载到桌面|保存到桌面|拷贝到|复制到)/i;
const CLOUD_REFERENCE_PATTERN = /(云盘|云空间|中转站|中转云盘|中转文件夹|中转目录|飞书云空间|drive\s*(?:file|folder)?)/i;
const THIRD_PARTY_TARGET_PATTERN = /(发给|发送给|传给|转给|发到|发送到).{0,16}(张三|李四|别人|其他人|他人|同事|群|群里|群聊|邮箱|email|mail)/i;

export function classifyFileActionIntent(text: string | undefined): FileActionIntent {
  const normalized = text?.trim();
  if (!normalized) {
    return { action: "none", target: "none", source: "unspecified", reason: "empty" };
  }

  const source = classifyFileActionSource(normalized);
  if (isThirdPartyFileTarget(normalized)) {
    return { action: "blocked", target: "third_party", source, reason: "third_party_target" };
  }

  const sendsToCurrentUser = DELIVERY_ACTION_PATTERN.test(normalized);
  const downloadsToLocal = LOCAL_DOWNLOAD_ACTION_PATTERN.test(normalized);
  const remoteReference = hasRemoteReference(normalized);
  const remoteMaterialization = hasRemoteMaterialization(normalized);

  if (sendsToCurrentUser) {
    if (remoteReference && !remoteMaterialization) {
      return { action: "none", target: "none", source: "remote", reason: "plain_remote_reference" };
    }
    if (source === "local" || source === "generated" || source === "remote_materialized") {
      return { action: "send_to_chat", target: "current_user", source };
    }
    return { action: "none", target: "none", source, reason: "not_delivery" };
  }

  if (downloadsToLocal) {
    return { action: "download_to_local", target: "local_computer", source };
  }

  return { action: "none", target: "none", source, reason: "not_delivery" };
}

export function isThirdPartyFileTarget(text: string): boolean {
  return THIRD_PARTY_TARGET_PATTERN.test(text);
}

function classifyFileActionSource(text: string): FileActionIntentSource {
  if (hasLocalFileReference(text)) return "local";
  if (hasRemoteReference(text)) return hasRemoteMaterialization(text) ? "remote_materialized" : "remote";
  if (hasCloudReference(text)) return "cloud";
  if (hasGeneratedDeliverable(text)) return "generated";
  if (hasScreenshotDeliverable(text)) return "generated";
  return "unspecified";
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

function hasCloudReference(text: string): boolean {
  return CLOUD_REFERENCE_PATTERN.test(text);
}

function stripRemoteUrls(text: string): string {
  return text.replace(/https?:\/\/\S+|www\.\S+/gi, " ");
}
