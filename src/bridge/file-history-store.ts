import fs from "node:fs";
import path from "node:path";
import type { ChannelAttachment, ChannelMedia } from "../protocol/channel.js";
import type { BridgeSendFileExtraction } from "./media-extractor.js";

export type FileHistorySource = "agent_local" | "inbound_attachment" | "feishu_drive" | "feishu_drive_download";
export type FileHistoryKind = "image" | "file" | "video" | "voice" | "unknown";

export interface FileHistoryItem {
  id: string;
  routeKey: string;
  source: FileHistorySource;
  kind: FileHistoryKind;
  name: string;
  sizeBytes?: number;
  localPath?: string;
  url?: string;
  feishuFileToken?: string;
  feishuDriveType?: string;
  createdAt: number;
  expiresAt: number;
  messageId?: string;
  mimeType?: string;
}

export interface FileHistoryStoreOptions {
  ttlMs?: number;
  maxItemsPerRoute?: number;
  now?: () => number;
}

export interface FileHistoryRecordOptions {
  messageId?: string;
}

export interface FileHistoryFeishuDriveItemInput {
  token: string;
  name: string;
  type: string;
  url?: string;
}

export type FileHistoryReferenceAction = "send_to_chat" | "download_to_local";

export interface FileHistoryReferenceOptions {
  action: FileHistoryReferenceAction;
}

export type FileHistoryReferenceResolution =
  | { kind: "none" }
  | { kind: "local_media"; items: FileHistoryItem[] }
  | { kind: "feishu_drive_file"; item: FileHistoryItem }
  | { kind: "ambiguous"; items: FileHistoryItem[] }
  | { kind: "unsupported"; item: FileHistoryItem };

export interface FileHistoryDriveDownloadRequest {
  fileToken: string;
  fileName: string;
  sourceUrl: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ITEMS_PER_ROUTE = 50;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const VOICE_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

export class FileHistoryStore {
  private readonly records = new Map<string, FileHistoryItem[]>();
  private readonly ttlMs: number;
  private readonly maxItemsPerRoute: number;
  private readonly now: () => number;
  private nextId = 1;

  constructor(options: FileHistoryStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxItemsPerRoute = options.maxItemsPerRoute ?? DEFAULT_MAX_ITEMS_PER_ROUTE;
    this.now = options.now ?? Date.now;
  }

  recordLocalDeliverables(routeKey: string, media: readonly ChannelMedia[], options: FileHistoryRecordOptions = {}): void {
    for (const item of media) {
      if (!item.path) continue;
      this.prepend(routeKey, this.itemFromLocalMedia(routeKey, "agent_local", item, options));
    }
  }

  recordInboundAttachments(routeKey: string, attachments: readonly ChannelAttachment[], options: FileHistoryRecordOptions = {}): void {
    for (const attachment of attachments) {
      if (!isUsableAttachment(attachment)) continue;
      this.prepend(routeKey, this.itemFromAttachment(routeKey, attachment, options));
    }
  }

  recordFeishuDriveListing(routeKey: string, files: readonly FileHistoryFeishuDriveItemInput[], options: FileHistoryRecordOptions = {}): void {
    const items = files.map((file) => this.itemFromFeishuDriveFile(routeKey, file, options));
    for (const item of [...items].reverse()) {
      this.prepend(routeKey, item);
    }
  }

  recordFeishuDriveDownload(routeKey: string, localPath: string, metadata: {
    name?: string;
    sizeBytes?: number;
    mimeType?: string;
    url?: string;
    feishuFileToken?: string;
    messageId?: string;
  } = {}): void {
    const media: ChannelMedia = {
      type: kindFromName(metadata.name ?? localPath) === "image" ? "image" : "file",
      path: localPath,
      name: metadata.name ?? path.basename(localPath),
      sizeBytes: metadata.sizeBytes,
      mimeType: metadata.mimeType,
    };
    this.prepend(routeKey, {
      ...this.itemFromLocalMedia(routeKey, "feishu_drive_download", media, { messageId: metadata.messageId }),
      url: metadata.url,
      feishuFileToken: metadata.feishuFileToken,
    });
  }

  list(routeKey: string): FileHistoryItem[] {
    const active = this.activeItems(routeKey);
    this.records.set(routeKey, active);
    return active.map((item) => ({ ...item }));
  }

  clearExpired(routeKey: string): void {
    this.records.set(routeKey, this.activeItems(routeKey));
  }

  resolveReference(routeKey: string, text: string | undefined, options: FileHistoryReferenceOptions): FileHistoryReferenceResolution {
    const normalized = text?.trim() ?? "";
    const active = this.activeItems(routeKey);
    this.records.set(routeKey, active);
    if (active.length === 0) return { kind: "none" };

    const sourceHint = sourceHintFromText(normalized);
    const requestedKind = requestedKindFromText(normalized);
    const ordinal = ordinalFromText(normalized);
    const nameQuery = fileNameQueryFromText(normalized);
    const base = baseCandidates(active, options.action, sourceHint);
    if (base.length === 0) return { kind: "none" };

    if (ordinal !== undefined) {
      const item = base[ordinal - 1];
      if (!item) return { kind: "none" };
      return resolutionForSingleItem(item, options.action);
    }

    let matches = base;
    if (requestedKind) {
      matches = matches.filter((item) => item.kind === requestedKind);
    }
    if (nameQuery) {
      matches = matches.filter((item) => itemMatchesQuery(item, nameQuery));
    }
    if (matches.length === 0) return { kind: "none" };

    const hasSpecificReference = Boolean(requestedKind || nameQuery || sourceHint);
    if (matches.length > 1 && hasSpecificReference) {
      return { kind: "ambiguous", items: cloneItems(matches) };
    }
    if (options.action === "send_to_chat") {
      return { kind: "local_media", items: cloneItems(matches.filter((item) => Boolean(item.localPath))) };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", items: cloneItems(matches) };
    }
    return resolutionForSingleItem(matches[0], options.action);
  }

  private prepend(routeKey: string, item: FileHistoryItem): void {
    const active = this.activeItems(routeKey);
    const deduped = active.filter((existing) => itemKey(existing) !== itemKey(item));
    this.records.set(routeKey, [item, ...deduped].slice(0, this.maxItemsPerRoute));
  }

  private activeItems(routeKey: string): FileHistoryItem[] {
    const now = this.now();
    return (this.records.get(routeKey) ?? []).filter((item) => item.expiresAt > now);
  }

  private itemFromLocalMedia(
    routeKey: string,
    source: Extract<FileHistorySource, "agent_local" | "feishu_drive_download">,
    media: ChannelMedia,
    options: FileHistoryRecordOptions,
  ): FileHistoryItem {
    const createdAt = this.now();
    const name = media.name ?? (media.path ? path.basename(media.path) : undefined) ?? "file";
    return {
      id: this.nextItemId(),
      routeKey,
      source,
      kind: kindFromChannelMedia(media),
      name,
      sizeBytes: media.sizeBytes,
      localPath: media.path,
      url: media.url,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      messageId: options.messageId,
      mimeType: media.mimeType,
    };
  }

  private itemFromAttachment(routeKey: string, attachment: ChannelAttachment, options: FileHistoryRecordOptions): FileHistoryItem {
    const createdAt = this.now();
    const name = attachment.name ?? (attachment.localPath ? path.basename(attachment.localPath) : undefined) ?? "attachment";
    return {
      id: this.nextItemId(),
      routeKey,
      source: "inbound_attachment",
      kind: kindFromAttachment(attachment),
      name,
      sizeBytes: attachment.sizeBytes,
      localPath: attachment.localPath,
      url: attachment.url,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      messageId: options.messageId,
      mimeType: attachment.mimeType,
    };
  }

  private itemFromFeishuDriveFile(routeKey: string, file: FileHistoryFeishuDriveItemInput, options: FileHistoryRecordOptions): FileHistoryItem {
    const createdAt = this.now();
    return {
      id: this.nextItemId(),
      routeKey,
      source: "feishu_drive",
      kind: file.type === "file" ? kindFromName(file.name) : "unknown",
      name: file.name,
      url: file.url,
      feishuFileToken: file.token,
      feishuDriveType: file.type,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      messageId: options.messageId,
    };
  }

  private nextItemId(): string {
    const id = `fh${String(this.nextId++).padStart(4, "0")}`;
    return id;
  }
}

export function formatFileHistoryList(items: readonly FileHistoryItem[]): string {
  if (items.length === 0) return "当前没有可引用的最近文件。";
  return [
    "最近文件：",
    ...items.map((item, index) => {
      const size = item.sizeBytes !== undefined ? `，${formatBytes(item.sizeBytes)}` : "";
      const location = item.localPath ?? item.url;
      return location
        ? `${index + 1}. [${sourceLabel(item.source)}] ${item.name}${size}\n   ${location}`
        : `${index + 1}. [${sourceLabel(item.source)}] ${item.name}${size}`;
    }),
  ].join("\n");
}

export function fileHistoryExtractionFromLocalItems(items: readonly FileHistoryItem[], maxFiles: number): BridgeSendFileExtraction {
  const media: ChannelMedia[] = [];
  const invalidRefs: string[] = [];
  let overflowCount = 0;
  for (const item of items) {
    if (media.length >= maxFiles) {
      overflowCount += 1;
      continue;
    }
    if (!item.localPath || !path.isAbsolute(item.localPath) || !isReadableFile(item.localPath)) {
      invalidRefs.push(item.localPath ?? item.name);
      continue;
    }
    media.push({
      type: channelMediaTypeFromKind(item.kind),
      path: item.localPath,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
    });
  }
  return {
    requestedCount: items.length,
    media,
    invalidRefs,
    overflowCount,
  };
}

export function fileHistoryDriveDownloadRequestFromItem(item: FileHistoryItem): FileHistoryDriveDownloadRequest | undefined {
  if (item.source !== "feishu_drive" || item.feishuDriveType !== "file" || !item.feishuFileToken) return undefined;
  return {
    fileToken: item.feishuFileToken,
    fileName: item.name,
    sourceUrl: item.url ?? `feishu-drive:file:${item.feishuFileToken}`,
  };
}

function isUsableAttachment(attachment: ChannelAttachment): boolean {
  return attachment.downloadState !== "failed"
    && attachment.downloadState !== "unsupported"
    && typeof attachment.localPath === "string"
    && attachment.localPath.length > 0
    && path.isAbsolute(attachment.localPath);
}

function baseCandidates(
  items: readonly FileHistoryItem[],
  action: FileHistoryReferenceAction,
  sourceHint: "cloud" | "local" | undefined,
): FileHistoryItem[] {
  if (sourceHint === "cloud") return items.filter((item) => item.source === "feishu_drive");
  if (sourceHint === "local") return items.filter((item) => item.source !== "feishu_drive" && Boolean(item.localPath));
  if (action === "download_to_local") return items.filter((item) => item.source === "feishu_drive");
  return items.filter((item) => item.source !== "feishu_drive" && Boolean(item.localPath));
}

function resolutionForSingleItem(item: FileHistoryItem, action: FileHistoryReferenceAction): FileHistoryReferenceResolution {
  if (action === "send_to_chat") {
    return item.localPath ? { kind: "local_media", items: [{ ...item }] } : { kind: "none" };
  }
  if (item.source === "feishu_drive") {
    if (item.feishuDriveType !== "file") return { kind: "unsupported", item: { ...item } };
    return { kind: "feishu_drive_file", item: { ...item } };
  }
  return { kind: "none" };
}

function sourceHintFromText(text: string): "cloud" | "local" | undefined {
  if (/(云盘|云空间|中转站|中转云盘|中转文件夹|中转目录|drive)/i.test(text)) return "cloud";
  if (/(本地|电脑|刚下载|下载好的)/i.test(text)) return "local";
  return undefined;
}

function requestedKindFromText(text: string): FileHistoryKind | undefined {
  if (/(图片|照片|截图|png|jpe?g|gif|webp|bmp|tiff?|svg)/i.test(text)) return "image";
  if (/(视频|mp4|mov|avi|mkv|webm)/i.test(text)) return "video";
  if (/(语音|音频|mp3|wav|m4a|aac|ogg|flac)/i.test(text)) return "voice";
  if (/(文件|附件|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|html?|zip|rar|7z|tar|gz)/i.test(text)) return "file";
  return undefined;
}

function ordinalFromText(text: string): number | undefined {
  const digitMatch = /(?:第\s*)?(\d+)\s*(?:个|项|号)?/.exec(text);
  if (digitMatch?.[1]) return Number.parseInt(digitMatch[1], 10);
  const chineseMatch = /第\s*([一二两三四五六七八九十]{1,3})\s*(?:个|项|号)?/.exec(text);
  if (!chineseMatch?.[1]) return undefined;
  return chineseOrdinalToNumber(chineseMatch[1]);
}

function chineseOrdinalToNumber(value: string): number | undefined {
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  if (value.startsWith("十")) {
    const ones = value.slice(1);
    return 10 + (ones ? digits[ones] ?? Number.NaN : 0);
  }
  if (value.endsWith("十")) {
    const tens = value.slice(0, -1);
    return (digits[tens] ?? Number.NaN) * 10;
  }
  const tenIndex = value.indexOf("十");
  if (tenIndex > 0) {
    const tens = value.slice(0, tenIndex);
    const ones = value.slice(tenIndex + 1);
    return (digits[tens] ?? Number.NaN) * 10 + (ones ? digits[ones] ?? Number.NaN : 0);
  }
  return digits[value];
}

function fileNameQueryFromText(text: string): string | undefined {
  const match = /([^\s，。！？；;:"'<>]+?\.[A-Za-z0-9]{1,8})/.exec(text);
  return match?.[1]?.toLowerCase();
}

function itemMatchesQuery(item: FileHistoryItem, query: string): boolean {
  const lowerName = item.name.toLowerCase();
  if (lowerName.includes(query)) return true;
  const ext = path.extname(lowerName);
  if (ext && query === ext.slice(1)) return true;
  return false;
}

function cloneItems(items: readonly FileHistoryItem[]): FileHistoryItem[] {
  return items.map((item) => ({ ...item }));
}

function itemKey(item: FileHistoryItem): string {
  return item.localPath ?? item.url ?? item.feishuFileToken ?? `${item.source}:${item.name}`;
}

function kindFromChannelMedia(media: ChannelMedia): FileHistoryKind {
  if (media.type === "image" || media.type === "video" || media.type === "voice") return media.type;
  return "file";
}

function kindFromAttachment(attachment: ChannelAttachment): FileHistoryKind {
  if (attachment.type === "image" || attachment.type === "video" || attachment.type === "voice" || attachment.type === "file") return attachment.type;
  return kindFromName(attachment.name ?? attachment.localPath ?? "");
}

function kindFromName(name: string): FileHistoryKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (VOICE_EXTENSIONS.has(ext)) return "voice";
  return "file";
}

function channelMediaTypeFromKind(kind: FileHistoryKind): ChannelMedia["type"] {
  if (kind === "image" || kind === "video" || kind === "voice") return kind;
  return "file";
}

function sourceLabel(source: FileHistorySource): string {
  switch (source) {
    case "agent_local":
    case "feishu_drive_download":
      return "本地";
    case "inbound_attachment":
      return "聊天附件";
    case "feishu_drive":
      return "飞书云盘";
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${formatByteNumber(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatByteNumber(mib)} MB`;
  return `${formatByteNumber(mib / 1024)} GB`;
}

function formatByteNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function isReadableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
