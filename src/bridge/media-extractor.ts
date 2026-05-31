import fs from "node:fs";
import path from "node:path";
import type { ChannelMedia } from "../protocol/channel.js";

export const BRIDGE_SEND_FILE_PREFIX = "BRIDGE_SEND_FILE:";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg"]);
const IMAGE_EXTENSION_PATTERN = "png|jpe?g|gif|webp|bmp|tiff?|svg";
const KNOWN_FILE_EXTENSION_PATTERN = "png|jpe?g|gif|webp|bmp|tiff?|svg|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|html?|xml|log|rtf|zip|tar|gz|tgz|7z|rar";
const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".log": "text/plain",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
};

interface MediaCandidate {
  value: string;
  caption?: string;
  explicit?: boolean;
  markdownLink?: boolean;
}

export interface BridgeSendFileExtraction {
  requestedCount: number;
  media: ChannelMedia[];
  invalidRefs: string[];
  overflowCount: number;
}

export function extractMediaRefs(text: string, cwd = process.cwd()): ChannelMedia[] {
  const candidates = [
    ...markdownMediaRefs(text),
    ...mediaDirectiveRefs(text),
    ...labeledFileRefs(text),
    ...bareImageRefs(text),
  ];
  const media: ChannelMedia[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const item = mediaFromCandidate(candidate, cwd);
    if (!item) continue;
    const key = item.path ?? item.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    media.push(item);
  }
  return media;
}

export function extractLocalImageMedia(text: string, cwd: string): ChannelMedia[] {
  return extractMediaRefs(text, cwd).filter((media) => media.type === "image" && Boolean(media.path));
}

export function extractLocalDeliverableRefs(text: string, cwd = process.cwd(), maxFiles = Number.POSITIVE_INFINITY): ChannelMedia[] {
  const candidates = [
    ...markdownMediaRefs(text),
    ...mediaDirectiveRefs(text),
    ...labeledFileRefs(text),
    ...bareLocalKnownFileRefs(text),
  ];
  const media: ChannelMedia[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (media.length >= maxFiles) break;
    const item = mediaFromCandidate({ ...candidate, explicit: true }, cwd);
    if (!item?.path) continue;
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    media.push(item);
  }
  return media;
}

export function extractBridgeSendFileRefs(text: string, cwd: string, maxFiles: number): BridgeSendFileExtraction {
  const refs = bridgeSendFileRefs(text);
  const media: ChannelMedia[] = [];
  const invalidRefs: string[] = [];
  let overflowCount = 0;
  const seen = new Set<string>();

  for (const ref of refs) {
    if (media.length >= maxFiles) {
      overflowCount += 1;
      continue;
    }
    if (!path.isAbsolute(ref)) {
      invalidRefs.push(ref);
      continue;
    }
    const item = mediaFromCandidate({ value: ref, explicit: true }, cwd);
    if (!item?.path || !path.isAbsolute(item.path)) {
      invalidRefs.push(ref);
      continue;
    }
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    media.push(item);
  }

  return {
    requestedCount: refs.length,
    media,
    invalidRefs,
    overflowCount,
  };
}

export function stripBridgeSendFileRefs(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !lineContainsBridgeSendFileRef(line))
    .join("\n")
    .trim();
}

export function hasBridgeSendFileRefs(text: string): boolean {
  return text.split(/\r?\n/).some((line) => bridgeSendFileRefFromLine(line) !== undefined);
}

function markdownMediaRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const pattern = /(!?)\[([^\]]*)]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[3]);
    const isImage = match[1] === "!";
    if (cleaned) refs.push({
      value: cleaned,
      caption: match[2]?.trim() || undefined,
      explicit: isImage,
      markdownLink: !isImage,
    });
  }
  return refs;
}

function bridgeSendFileRefs(text: string): string[] {
  const refs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = bridgeSendFileRefFromLine(line);
    if (cleaned) refs.push(cleaned);
  }
  return refs;
}

function lineContainsBridgeSendFileRef(line: string): boolean {
  return /BRIDGE_SEND_FILE\s*[:：]/i.test(normalizeBridgeProtocolLine(line));
}

function bridgeSendFileRefFromLine(line: string): string | undefined {
  const normalized = normalizeBridgeProtocolLine(line);
  const match = normalized.match(/BRIDGE_SEND_FILE\s*[:：]\s*(.+?)\s*$/i);
  return match ? cleanRef(match[1]) : undefined;
}

function normalizeBridgeProtocolLine(line: string): string {
  return line
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function mediaDirectiveRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const pattern = /^\s*(?:MEDIA|FILE)\s*:\s*(.+?)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push({ value: cleaned, explicit: true });
  }
  return refs;
}

function labeledFileRefs(text: string): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  const pattern = new RegExp(`(?:文件|附件|下载|File|Attachment|Download)\\s*[:：]\\s*(<[^>]+>|[^\\s"'<>]+?\\.(?:${KNOWN_FILE_EXTENSION_PATTERN})\\b)`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) refs.push({ value: cleaned, explicit: true });
  }
  return refs;
}

function bareImageRefs(text: string): MediaCandidate[] {
  return refsFromPatterns(text, [
    new RegExp(`https?://[^\\s"'<>)]*\\.(?:${IMAGE_EXTENSION_PATTERN})(?:\\?[^\\s"'<>)]*)?`, "gi"),
    new RegExp(`file://[^\\s"'<>)]*\\.(?:${IMAGE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`[A-Za-z]:\\\\[^\\r\\n"'<>|?*]+\\.(?:${IMAGE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`/(?!/)[^\\s"'<>)]*\\.(?:${IMAGE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`\\.\\.?/[^\\s"'<>)]*\\.(?:${IMAGE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`(?:[A-Za-z0-9_@%+=:,.-]+/)+[A-Za-z0-9_@%+=:,.-]+\\.(?:${IMAGE_EXTENSION_PATTERN})\\b`, "gi"),
  ]);
}

function bareLocalKnownFileRefs(text: string): MediaCandidate[] {
  return refsFromPatterns(text, [
    new RegExp(`[A-Za-z]:\\\\[^\\r\\n"'<>|?*]+\\.(?:${KNOWN_FILE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`/(?!/)[^\\s"'<>)]*\\.(?:${KNOWN_FILE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`\\.\\.?/[^\\s"'<>)]*\\.(?:${KNOWN_FILE_EXTENSION_PATTERN})\\b`, "gi"),
    new RegExp(`(?:[A-Za-z0-9_@%+=:,.-]+/)+[A-Za-z0-9_@%+=:,.-]+\\.(?:${KNOWN_FILE_EXTENSION_PATTERN})\\b`, "gi"),
  ], true);
}

function refsFromPatterns(text: string, patterns: RegExp[], explicit?: boolean): MediaCandidate[] {
  const refs: MediaCandidate[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (isInsideUrlToken(text, match.index)) continue;
      const cleaned = cleanRef(match[0]);
      if (cleaned) refs.push({ value: cleaned, explicit });
    }
  }
  return refs;
}

function isInsideUrlToken(text: string, index: number): boolean {
  let tokenStart = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (/[\s"'<>()[\]]/.test(text[i])) {
      tokenStart = i + 1;
      break;
    }
  }
  return /(?:https?|file):\/\//i.test(text.slice(tokenStart, index + 1));
}

function cleanRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
    .replace(/^<|>$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[),.;!?]+$/g, "");
  if (!trimmed) return undefined;
  if (trimmed.startsWith("file://")) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function mediaFromCandidate(candidate: MediaCandidate, cwd: string): ChannelMedia | undefined {
  if (/^https?:\/\//i.test(candidate.value)) {
    return remoteMediaFromUrl(candidate);
  }
  const filePath = resolveMediaPath(candidate.value, cwd);
  if (!filePath) return undefined;
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const knownFile = Boolean(EXTENSION_MIME[ext]);
  if (!isImage && !candidate.explicit && !(candidate.markdownLink && knownFile)) return undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    return {
      type: isImage ? "image" : "file",
      path: filePath,
      name: path.basename(filePath),
      mimeType: EXTENSION_MIME[ext] ?? "application/octet-stream",
      sizeBytes: stat.size,
      caption: candidate.caption,
    };
  } catch {
    return undefined;
  }
}

function remoteMediaFromUrl(candidate: MediaCandidate): ChannelMedia | undefined {
  try {
    const url = new URL(candidate.value);
    const ext = path.extname(url.pathname).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const knownFile = Boolean(EXTENSION_MIME[ext]);
    if (!isImage && !candidate.explicit) return undefined;
    if (!isImage && !knownFile) return undefined;
    return {
      type: isImage ? "image" : "file",
      url: url.toString(),
      name: decodeURIComponent(path.basename(url.pathname)),
      mimeType: EXTENSION_MIME[ext] ?? "application/octet-stream",
      caption: candidate.caption,
    };
  } catch {
    return undefined;
  }
}

function resolveMediaPath(value: string, cwd: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || decoded.startsWith("\\\\")) return undefined;
    return path.isAbsolute(decoded) ? path.normalize(decoded) : path.resolve(cwd, decoded);
  } catch {
    return undefined;
  }
}
