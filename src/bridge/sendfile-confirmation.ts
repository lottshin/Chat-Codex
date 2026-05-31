import path from "node:path";
import type { ChannelActionMessage, ChannelMedia, ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { BridgeSendFileExtraction } from "./media-extractor.js";

export type SendFileConfirmationDecision = "approve" | "deny";

export interface SendFileConfirmationRequest {
  message: ChannelMessage;
  target: ChannelTarget;
  extraction: BridgeSendFileExtraction;
}

export interface PendingSendFileDelivery {
  id: string;
  routeKey: string;
  requestedBy: string;
  target: ChannelTarget;
  extraction: BridgeSendFileExtraction;
  createdAt: string;
  actionMessageId?: string;
}

export class PendingSendFileDeliveryStore {
  private readonly pending = new Map<string, PendingSendFileDelivery>();
  private nextId = 1;

  create(request: SendFileConfirmationRequest): PendingSendFileDelivery {
    const id = `f${String(this.nextId++).padStart(3, "0")}`;
    const pending: PendingSendFileDelivery = {
      id,
      routeKey: request.message.routeKey,
      requestedBy: request.message.sender.id,
      target: request.target,
      extraction: request.extraction,
      createdAt: new Date().toISOString(),
    };
    this.pending.set(id, pending);
    return pending;
  }

  get(id: string | undefined): PendingSendFileDelivery | undefined {
    if (!id) return undefined;
    return this.pending.get(id);
  }

  setActionMessageId(id: string, messageId: string): void {
    const pending = this.pending.get(id);
    if (pending) pending.actionMessageId = messageId;
  }

  delete(id: string): boolean {
    return this.pending.delete(id);
  }

  cancelRoute(routeKey: string): number {
    let cancelled = 0;
    for (const [id, pending] of this.pending) {
      if (pending.routeKey !== routeKey) continue;
      this.pending.delete(id);
      cancelled += 1;
    }
    return cancelled;
  }

  clearAll(): void {
    this.pending.clear();
  }
}

export function sendFileConfirmationActionMessage(pending: PendingSendFileDelivery): ChannelActionMessage {
  return {
    text: sendFileConfirmationText(pending),
    buttonGroups: [
      [{ text: "发送", action: `cmd:/sendfile-approve ${pending.id}`, style: "primary" }],
      [{ text: "取消", action: `cmd:/sendfile-deny ${pending.id}`, style: "danger" }],
    ],
  };
}

export function sendFileConfirmationFallbackText(pending: PendingSendFileDelivery): string {
  return [
    sendFileConfirmationText(pending),
    "",
    `发送：/sendfile-approve ${pending.id}`,
    `取消：/sendfile-deny ${pending.id}`,
  ].join("\n");
}

function sendFileConfirmationText(pending: PendingSendFileDelivery): string {
  const files = pending.extraction.media.map((media, index) => `${index + 1}. ${formatMediaLine(media)}`);
  const notes = [
    pending.extraction.invalidRefs.length > 0 ? `另有 ${pending.extraction.invalidRefs.length} 个路径无效，确认后不会发送。` : undefined,
    pending.extraction.overflowCount > 0 ? `超过上限，已跳过 ${pending.extraction.overflowCount} 个文件。` : undefined,
  ].filter(Boolean);
  return [
    "确认发送文件",
    `编号：${pending.id}`,
    ...files,
    ...notes,
  ].join("\n");
}

function formatMediaLine(media: ChannelMedia): string {
  const name = media.name ?? (media.path ? path.basename(media.path) : undefined) ?? media.url ?? "unknown";
  const size = media.sizeBytes !== undefined ? `，${formatBytes(media.sizeBytes)}` : "";
  const location = media.path ?? media.url;
  return location ? `${name}${size}\n   ${location}` : `${name}${size}`;
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
