import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInboundMediaUploadRoot } from "../../bridge/inbound-media-store.js";
import { ChannelMediaDeliveryError } from "../../protocol/media-delivery-error.js";

export type FeishuDriveDownloadDirectoryKind = "default" | "desktop" | "absolute";

export interface FeishuDriveFileLink {
  fileToken: string;
  sourceUrl: string;
  matchedText: string;
}

export interface FeishuDriveDownloadIntent {
  fileToken: string;
  sourceUrl: string;
  directory: string;
  directoryKind: FeishuDriveDownloadDirectoryKind;
}

export interface ResolveFeishuDriveDownloadIntentOptions {
  defaultRootDir?: string;
  desktopDir?: string;
  startCwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function resolveFeishuDriveDownloadIntent(
  text: string | undefined,
  options: ResolveFeishuDriveDownloadIntentOptions = {},
): FeishuDriveDownloadIntent | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const link = extractFeishuDriveFileLink(trimmed);
  if (!link) return undefined;
  const textWithoutLink = trimmed.replace(link.matchedText, " ");
  if (!hasFeishuDriveDownloadIntent(textWithoutLink)) return undefined;
  const destination = resolveFeishuDriveDownloadDirectory(textWithoutLink, options);
  return {
    fileToken: link.fileToken,
    sourceUrl: link.sourceUrl,
    ...destination,
  };
}

export function extractFeishuDriveFileLink(text: string | undefined): FeishuDriveFileLink | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const urlMatch = /(https?:\/\/[^\s<>"']*(?:\/drive\/file\/|\/file\/)([A-Za-z0-9_-]+)[^\s<>"']*)/i.exec(trimmed);
  if (urlMatch?.[1] && urlMatch[2]) {
    return {
      fileToken: urlMatch[2],
      sourceUrl: urlMatch[1],
      matchedText: urlMatch[1],
    };
  }
  const pathMatch = /(^|\s)((?:\/drive\/file\/|\/file\/)([A-Za-z0-9_-]+)(?:[/?#][^\s<>"']*)?)/i.exec(trimmed);
  if (!pathMatch?.[2] || !pathMatch[3]) return undefined;
  return {
    fileToken: pathMatch[3],
    sourceUrl: pathMatch[2],
    matchedText: pathMatch[2],
  };
}

export function hasFeishuDriveDownloadIntent(text: string | undefined): boolean {
  const normalized = text?.trim();
  if (!normalized) return false;
  return /(下载|保存|存到|拉到本地|下载到桌面|保存到桌面|拷贝到|复制到)/i.test(normalized);
}

export function resolveFeishuDriveDownloadDirectory(
  textWithoutLink: string,
  options: ResolveFeishuDriveDownloadIntentOptions = {},
): { directory: string; directoryKind: FeishuDriveDownloadDirectoryKind } {
  if (/(桌面|Desktop)/i.test(textWithoutLink)) {
    return {
      directory: options.desktopDir ?? resolveCurrentUserDesktopDir(options),
      directoryKind: "desktop",
    };
  }
  const explicit = explicitAbsoluteDirectoryFromText(textWithoutLink);
  if (explicit) {
    return {
      directory: explicit,
      directoryKind: "absolute",
    };
  }
  return {
    directory: options.defaultRootDir ?? resolveInboundMediaUploadRoot({
      startCwd: options.startCwd,
      env: options.env,
      homeDir: options.homeDir,
    }),
    directoryKind: "default",
  };
}

export function resolveCurrentUserDesktopDir(options: {
  desktopDir?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execFileSync?: typeof execFileSync;
} = {}): string {
  if (options.desktopDir?.trim()) return options.desktopDir.trim();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const exec = options.execFileSync ?? execFileSync;
    try {
      const desktop = exec("powershell.exe", [
        "-NoProfile",
        "-Command",
        "[Environment]::GetFolderPath('Desktop')",
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      if (desktop) return desktop;
    } catch {
      // Fall through to the conventional Desktop path.
    }
  }
  return path.join(options.homeDir ?? os.homedir(), "Desktop");
}

export async function ensureFeishuDriveDownloadDirectory(
  directory: string,
  kind: FeishuDriveDownloadDirectoryKind,
): Promise<void> {
  if (kind === "default") {
    await fs.mkdir(directory, { recursive: true });
    return;
  }
  let stats;
  try {
    stats = await fs.stat(directory);
  } catch (error) {
    throw new ChannelMediaDeliveryError(`目录不存在：${directory}`, {
      stage: "validate",
      reasonCode: "feishu_drive_download_directory_missing",
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw new ChannelMediaDeliveryError(`目标不是目录：${directory}`, {
      stage: "validate",
      reasonCode: "feishu_drive_download_target_not_directory",
    });
  }
}

export async function uniqueFeishuDriveDownloadPath(directory: string, fileName: string): Promise<string> {
  const sanitized = sanitizeFeishuDriveDownloadFileName(fileName);
  const ext = path.extname(sanitized);
  const stem = ext.length >= sanitized.length ? sanitized : sanitized.slice(0, -ext.length);
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? sanitized : `${stem || "file"} (${index})${ext}`;
    const candidatePath = path.join(directory, candidateName);
    if (!(await pathExists(candidatePath))) return candidatePath;
  }
  throw new ChannelMediaDeliveryError(`无法为文件生成可用路径：${sanitized}`, {
    stage: "validate",
    reasonCode: "feishu_drive_download_unique_path_failed",
  });
}

export function sanitizeFeishuDriveDownloadFileName(fileName: string | undefined, fallback = "feishu-drive-file"): string {
  const leaf = (fileName ?? "").split(/[\\/]/).at(-1) ?? "";
  const sanitized = leaf
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "");
  return sanitized || fallback;
}

function explicitAbsoluteDirectoryFromText(text: string): string | undefined {
  const match = /(?:下载到|保存到|存到|放到|拉到|复制到|拷贝到)\s*([^，,。；;\r\n]+)/i.exec(text);
  const candidate = match?.[1]?.trim();
  if (!candidate || /^(桌面|Desktop)$/i.test(candidate)) return undefined;
  return isAbsoluteUserPath(candidate) ? candidate : undefined;
}

function isAbsoluteUserPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
