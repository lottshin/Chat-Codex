import fs from "node:fs";
import path from "node:path";
import type { ApprovalManager } from "../approvals/approval-manager.js";
import { approvalChoices } from "../approvals/choices.js";
import type { PendingApproval } from "../approvals/types.js";
import type { Logger } from "../logging/logger.js";
import { backendDisplayName, type AiBackend } from "../backend/metadata.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelActionMessage, ChannelMedia, ChannelTarget, SendResult } from "../protocol/channel.js";
import { isChannelMediaDeliveryError, type ChannelMediaErrorStage } from "../protocol/media-delivery-error.js";
import { extractBridgeSendFileRefs } from "./media-extractor.js";
import { PROGRESS_SEND_FAILURE_COOLDOWN_MS, SEND_FILE_MAX_FILES } from "./bridge-types.js";
import { sleep } from "./formatters.js";

export interface BridgeDeliveryOptions {
  channels: ChannelRegistry;
  approvals: ApprovalManager;
  logger: Logger;
  transcript?: TranscriptSink;
  approvalSendRetryDelayMs: number;
  backend?: AiBackend;
}

export interface ActionMessageSendResult extends SendResult {
  actionMessage: boolean;
}

type FileDeliveryStatus = "sent" | "failed" | "skipped";

interface FileDeliveryResult {
  status: FileDeliveryStatus;
  path?: string;
  url?: string;
  fileName: string;
  sizeBytes?: number;
  channelId: string;
  stage?: ChannelMediaErrorStage;
  reasonCode?: string;
  message?: string;
}

export class BridgeDelivery {
  private readonly channels: ChannelRegistry;
  private readonly approvals: ApprovalManager;
  private readonly logger: Logger;
  private readonly transcript?: TranscriptSink;
  private readonly approvalSendRetryDelayMs: number;
  private readonly backendName: string;
  private readonly progressSendSuppressedUntil = new Map<string, number>();

  constructor(options: BridgeDeliveryOptions) {
    this.channels = options.channels;
    this.approvals = options.approvals;
    this.logger = options.logger;
    this.transcript = options.transcript;
    this.approvalSendRetryDelayMs = options.approvalSendRetryDelayMs;
    this.backendName = backendDisplayName(options.backend);
  }

  async sendText(target: ChannelTarget, text: string): Promise<void> {
    try {
      await this.deliverText(target, text);
    } catch (error) {
      this.logger.warn("channel text send failed", {
        channel: target.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async deliverText(target: ChannelTarget, text: string): Promise<SendResult> {
    const result = await this.channels.sendText(target, text);
    this.transcript?.outbound(target, text);
    return result;
  }

  async sendApprovalTextUntilDelivered(routeKey: string, target: ChannelTarget, pending: PendingApproval): Promise<ActionMessageSendResult | undefined> {
    const text = this.approvals.formatForChannel(pending, this.backendName);
    const actionMessage = approvalActionMessage(text, pending);
    let failures = 0;
    while (this.isApprovalStillPending(routeKey, pending.approvalKey)) {
      try {
        return await this.deliverActionMessage(target, actionMessage, text);
      } catch (error) {
        failures += 1;
        this.logger.warn("approval message send failed", {
          channel: target.channelId,
          approvalKey: pending.approvalKey,
          failures,
          retryInMs: this.approvalSendRetryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.isApprovalStillPending(routeKey, pending.approvalKey)) return undefined;
      await sleep(this.approvalSendRetryDelayMs);
    }
    return undefined;
  }

  async deliverActionMessage(target: ChannelTarget, message: ChannelActionMessage, fallbackText: string): Promise<ActionMessageSendResult> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (capabilities.buttons) {
      try {
        const result = await this.channels.sendActionMessage(target, message);
        this.transcript?.outbound(target, fallbackText);
        return { ...result, actionMessage: true };
      } catch (error) {
        this.logger.warn("channel action message send failed", {
          channel: target.channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const result = await this.deliverText(target, fallbackText);
    return { ...result, actionMessage: false };
  }

  async updateActionMessage(target: ChannelTarget, messageId: string, text: string): Promise<boolean> {
    try {
      await this.channels.updateText(target, messageId, text, { metadata: { messageKind: "action" } });
      this.transcript?.outbound(target, text);
      return true;
    } catch (error) {
      this.logger.warn("action message update failed", {
        channel: target.channelId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async sendProgressText(routeKey: string, target: ChannelTarget, text: string): Promise<SendResult | undefined> {
    const suppressedUntil = this.progressSendSuppressedUntil.get(routeKey) ?? 0;
    if (Date.now() < suppressedUntil) return undefined;
    try {
      const result = await this.deliverText(target, text);
      this.progressSendSuppressedUntil.delete(routeKey);
      return result;
    } catch (error) {
      this.progressSendSuppressedUntil.set(routeKey, Date.now() + PROGRESS_SEND_FAILURE_COOLDOWN_MS);
      this.logger.warn("progress message send failed", {
        channel: target.channelId,
        error: error instanceof Error ? error.message : String(error),
        cooldownMs: PROGRESS_SEND_FAILURE_COOLDOWN_MS,
      });
      return undefined;
    }
  }

  async updateProgressText(routeKey: string, target: ChannelTarget, messageId: string, text: string): Promise<boolean> {
    try {
      await this.channels.updateText(target, messageId, text);
      this.progressSendSuppressedUntil.delete(routeKey);
      this.transcript?.outbound(target, text);
      return true;
    } catch (error) {
      this.logger.warn("progress message update failed", {
        channel: target.channelId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async sendRequestedFiles(
    target: ChannelTarget,
    finalText: string,
    cwd: string,
  ): Promise<void> {
    const extraction = extractBridgeSendFileRefs(finalText, cwd, SEND_FILE_MAX_FILES);
    await this.sendRequestedFileExtraction(target, extraction);
  }

  async sendRequestedFileExtraction(
    target: ChannelTarget,
    extraction: ReturnType<typeof extractBridgeSendFileRefs>,
  ): Promise<void> {
    if (extraction.requestedCount === 0) return;

    const results: FileDeliveryResult[] = [];
    for (const media of extraction.media) {
      results.push(await this.trySendMedia(target, media));
    }
    const failed = results.filter((result) => result.status !== "sent");

    const notes = [
      extraction.invalidRefs.length > 0 ? `有 ${extraction.invalidRefs.length} 个文件路径无效或不存在，未发送。` : undefined,
      extraction.overflowCount > 0 ? `超过每轮 ${SEND_FILE_MAX_FILES} 个文件上限，已跳过 ${extraction.overflowCount} 个。` : undefined,
      ...failed.map(formatFileDeliveryFailure),
    ].filter(Boolean);
    if (notes.length > 0) {
      await this.sendText(target, ["文件发送结果", ...notes.map((note) => `- ${note}`)].join("\n"));
    }
  }

  async withTyping<T>(target: ChannelTarget, operation: () => Promise<T>): Promise<T> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.typing) {
      return operation();
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await this.sendTyping(target, true);
      if (stopped) return;
      timer = setTimeout(() => {
        void tick();
      }, 5000);
      timer.unref?.();
    };
    await tick();
    try {
      return await operation();
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await this.sendTyping(target, false);
    }
  }

  async sendTyping(target: ChannelTarget, typing: boolean): Promise<void> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.typing) return;
    try {
      await this.channels.sendTyping(target, typing);
    } catch (error) {
      this.logger.warn("channel typing send failed", {
        channel: target.channelId,
        typing,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private isApprovalStillPending(routeKey: string, approvalKey: string): boolean {
    const approval = this.approvals.get(approvalKey);
    return approval?.routeKey === routeKey && approval.status === "pending";
  }

  private async trySendMedia(target: ChannelTarget, media: ChannelMedia): Promise<FileDeliveryResult> {
    const base = fileDeliveryResultBase(target, media);
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.media) {
      this.logger.warn("channel media send skipped", {
        channel: target.channelId,
        media: media.path ?? media.url ?? media.name,
        reason: "media unsupported",
      });
      return {
        ...base,
        status: "skipped",
        stage: "validate",
        reasonCode: "media_unsupported",
        message: "当前渠道不支持文件发送",
      };
    }
    try {
      await this.channels.sendMedia(target, media);
      this.transcript?.outboundMedia?.(target, media);
      return { ...base, status: "sent" };
    } catch (error) {
      this.logger.warn("channel media send failed", {
        channel: target.channelId,
        media: media.path ?? media.url ?? media.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...base,
        status: "failed",
        stage: isChannelMediaDeliveryError(error) ? error.stage : "send",
        reasonCode: isChannelMediaDeliveryError(error) ? error.reasonCode : "media_send_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function fileDeliveryResultBase(target: ChannelTarget, media: ChannelMedia): Omit<FileDeliveryResult, "status"> {
  return {
    path: media.path,
    url: media.url,
    fileName: media.name ?? (media.path ? path.basename(media.path) : undefined) ?? media.url ?? "unknown",
    sizeBytes: media.sizeBytes ?? fileSize(media.path),
    channelId: target.channelId,
  };
}

function formatFileDeliveryFailure(result: FileDeliveryResult): string {
  return [
    `文件 ${result.fileName}`,
    result.sizeBytes !== undefined ? `大小 ${formatBytes(result.sizeBytes)}` : undefined,
    `渠道 ${result.channelId}`,
    result.stage ? `阶段 ${result.stage}` : undefined,
    result.reasonCode ? `原因码 ${result.reasonCode}` : undefined,
    result.message ? `原因 ${result.message}` : undefined,
  ].filter(Boolean).join("；");
}

function fileSize(filePath: string | undefined): number | undefined {
  if (!filePath) return undefined;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
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

export function approvalActionMessage(text: string, pending: PendingApproval): ChannelActionMessage {
  const buttons = approvalChoices(pending).map((choice) => ({
    text: choice.buttonText,
    action: `cmd:${choice.command ?? choice.numeric} ${pending.approvalKey}`,
    style: choice.buttonStyle,
  }));
  return {
    text,
    buttonGroups: chunkButtons(buttons, 2),
  };
}

function chunkButtons<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
