import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { PendingApproval } from "../approvals/types.js";
import type { Logger } from "../logging/logger.js";
import { backendDisplayName, type AiBackend } from "../backend/metadata.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelMedia, ChannelTarget } from "../protocol/channel.js";
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

  async deliverText(target: ChannelTarget, text: string): Promise<void> {
    await this.channels.sendText(target, text);
    this.transcript?.outbound(target, text);
  }

  async sendApprovalTextUntilDelivered(routeKey: string, target: ChannelTarget, pending: PendingApproval): Promise<void> {
    const text = this.approvals.formatForChannel(pending, this.backendName);
    let failures = 0;
    while (this.isApprovalStillPending(routeKey, pending.approvalKey)) {
      try {
        await this.deliverText(target, text);
        return;
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
      if (!this.isApprovalStillPending(routeKey, pending.approvalKey)) return;
      await sleep(this.approvalSendRetryDelayMs);
    }
  }

  async sendProgressText(routeKey: string, target: ChannelTarget, text: string): Promise<void> {
    const suppressedUntil = this.progressSendSuppressedUntil.get(routeKey) ?? 0;
    if (Date.now() < suppressedUntil) return;
    try {
      await this.deliverText(target, text);
      this.progressSendSuppressedUntil.delete(routeKey);
    } catch (error) {
      this.progressSendSuppressedUntil.set(routeKey, Date.now() + PROGRESS_SEND_FAILURE_COOLDOWN_MS);
      this.logger.warn("progress message send failed", {
        channel: target.channelId,
        error: error instanceof Error ? error.message : String(error),
        cooldownMs: PROGRESS_SEND_FAILURE_COOLDOWN_MS,
      });
    }
  }

  async sendRequestedFiles(
    target: ChannelTarget,
    finalText: string,
    cwd: string,
  ): Promise<void> {
    const extraction = extractBridgeSendFileRefs(finalText, cwd, SEND_FILE_MAX_FILES);
    if (extraction.requestedCount === 0) return;

    const failed: string[] = [];
    for (const media of extraction.media) {
      const delivered = await this.trySendMedia(target, media);
      if (!delivered) failed.push(media.name ?? media.path ?? media.url ?? "unknown");
    }

    const notes = [
      extraction.invalidRefs.length > 0 ? `有 ${extraction.invalidRefs.length} 个文件路径无效或不存在，未发送。` : undefined,
      extraction.overflowCount > 0 ? `超过每轮 ${SEND_FILE_MAX_FILES} 个文件上限，已跳过 ${extraction.overflowCount} 个。` : undefined,
      failed.length > 0 ? `有 ${failed.length} 个文件发送失败: ${failed.join(", ")}` : undefined,
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

  private async trySendMedia(target: ChannelTarget, media: ChannelMedia): Promise<boolean> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.media) {
      this.logger.warn("channel media send skipped", {
        channel: target.channelId,
        media: media.path ?? media.url ?? media.name,
        reason: "media unsupported",
      });
      return false;
    }
    try {
      await this.channels.sendMedia(target, media);
      this.transcript?.outboundMedia?.(target, media);
      return true;
    } catch (error) {
      this.logger.warn("channel media send failed", {
        channel: target.channelId,
        media: media.path ?? media.url ?? media.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
