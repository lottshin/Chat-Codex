import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import path from "node:path";
import type {
  ChannelActionMessage,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelLoginResult,
  ChannelMedia,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelTarget,
  SendOptions,
  SendResult,
} from "../../protocol/channel.js";
import { replyTargetFromMessage } from "../../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../../protocol/delivery-policy.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../protocol/delivery-policy.js";
import { ChannelMediaDeliveryError } from "../../protocol/media-delivery-error.js";
import { LOCAL_STATE_SCHEMA_VERSION, type ChannelAccountCredentialsDocument } from "../../state/persistent-state-types.js";
import { readJsonFile, writeJsonFileAtomic } from "../../state/state-files.js";
import { buildFeishuActionCard, feishuCardActionToInboundText } from "./feishu-card.js";
import {
  downloadFeishuDriveFileToPath,
  grantFeishuDriveFileView,
  listFeishuDriveFolderItems,
  queryFeishuDriveFileMeta,
  uploadFeishuDriveFile,
  type FeishuDriveFolderItem,
} from "./feishu-drive.js";
import {
  ensureFeishuDriveDownloadDirectory,
  hasFeishuDriveDownloadIntent,
  resolveFeishuDriveDownloadIntent,
  resolveFeishuDriveDownloadDirectory,
  sanitizeFeishuDriveDownloadFileName,
  uniqueFeishuDriveDownloadPath,
  type FeishuDriveDownloadDirectoryKind,
} from "./feishu-drive-download.js";
import { decideFeishuMediaDelivery } from "./feishu-media-limits.js";
import {
  DEFAULT_FEISHU_ACCOUNT_ID,
  DEFAULT_FEISHU_DOMAIN,
  DEFAULT_FEISHU_STALE_MESSAGE_MS,
  FEISHU_CHANNEL_ID,
  buildFeishuMessageUuid,
  buildFeishuPostContent,
  feishuEventToChannelMessage,
  feishuStatusDetails,
  formatFeishuApiError,
  missingFeishuCredentials,
  normalizeFeishuCredentials,
} from "./feishu-message.js";
import {
  downloadFeishuInboundAttachments,
  feishuFileTypeForName,
  feishuUploadKey,
  materializeFeishuChannelMedia,
} from "./feishu-media.js";
import type {
  FeishuAdapterOptions,
  FeishuApiResponse,
  FeishuBotIdentity,
  FeishuCardActionEvent,
  FeishuCredentials,
  FeishuEventDispatcher,
  FeishuEventHandlers,
  FeishuMessageReceiveEvent,
  FeishuProbeResult,
  FeishuReactionData,
  FeishuSdkClient,
  FeishuSentMessageData,
  FeishuTransportFactory,
  FeishuWsCallbacks,
  FeishuWsClient,
} from "./feishu-types.js";

const DEFAULT_SOURCE_VERSION = "node-sdk";
const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000;
const FEISHU_TYPING_EMOJI_TYPE = "Typing";
const FEISHU_DRIVE_DOWNLOAD_ACTION_PREFIX = "local:feishu-drive-download:";
const SILENT_FEISHU_SDK_LOGGER = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

interface PendingFeishuDriveDownload {
  id: string;
  target: ChannelTarget;
  fileToken: string;
  fileName: string;
  sourceUrl: string;
  directory: string;
  directoryKind: FeishuDriveDownloadDirectoryKind;
  requesterOpenId?: string;
  actionMessageId?: string;
  state: "pending" | "running";
}

interface FeishuDriveDownloadCardAction {
  decision: "approve" | "cancel";
  requestId: string;
}

interface PendingFeishuDriveFolderConfig {
  token: string;
  expiresAt: number;
}

interface RecentFeishuDriveFolderListing {
  files: FeishuDriveFolderItem[];
  expiresAt: number;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id: string;
  readonly label = "Feishu Adapter";
  private readonly credentials: FeishuCredentials;
  private readonly sourceVersion: string;
  private readonly connectOnStart: boolean;
  private readonly probeOnStart: boolean;
  private readonly staleMessageMs: number;
  private readonly dedupTtlMs: number;
  private groupEnabled: boolean;
  private readonly transportFactory: FeishuTransportFactory;
  private readonly now: () => number;
  private readonly inboundMediaRootDir?: string;
  private readonly desktopDir?: string;
  private readonly stateDir?: string;
  private handler?: ChannelMessageHandler;
  private status: ChannelStatus;
  private client?: FeishuSdkClient;
  private dispatcher?: FeishuEventDispatcher;
  private wsClient?: FeishuWsClient;
  private botOpenId?: string;
  private botName?: string;
  private readonly seenMessages = new Map<string, number>();
  private readonly typingReactions = new Map<string, string>();
  private readonly actionMessageIds = new Set<string>();
  private readonly driveDownloadRequests = new Map<string, PendingFeishuDriveDownload>();
  private readonly pendingDriveFolderConfigs = new Map<string, PendingFeishuDriveFolderConfig>();
  private readonly recentDriveFolderListings = new Map<string, RecentFeishuDriveFolderListing>();

  constructor(options: FeishuAdapterOptions = {}) {
    this.id = options.id ?? FEISHU_CHANNEL_ID;
    this.credentials = normalizeFeishuCredentials(options);
    this.sourceVersion = options.sourceVersion ?? DEFAULT_SOURCE_VERSION;
    this.connectOnStart = options.connectOnStart ?? true;
    this.probeOnStart = options.probeOnStart ?? true;
    this.staleMessageMs = options.staleMessageMs ?? DEFAULT_FEISHU_STALE_MESSAGE_MS;
    this.dedupTtlMs = options.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.groupEnabled = options.groupEnabled ?? false;
    this.transportFactory = options.transportFactory ?? new DefaultFeishuTransportFactory();
    this.now = options.now ?? Date.now;
    this.inboundMediaRootDir = options.inboundMediaRootDir;
    this.desktopDir = options.desktopDir;
    this.stateDir = options.stateDir;
    this.status = {
      channelId: this.id,
      state: missingFeishuCredentials(this.credentials).length > 0 ? "login_required" : "stopped",
      account: this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
      details: this.statusDetails("adapter-ready"),
    };
  }

  async start(): Promise<void> {
    const missing = missingFeishuCredentials(this.credentials);
    if (missing.length > 0) {
      this.status = {
        ...this.status,
        state: "login_required",
        lastError: `缺少飞书配置: ${missing.join(", ")}`,
        details: this.statusDetails("missing-credentials"),
      };
      return;
    }
    const required = this.requiredCredentials();
    this.status = {
      ...this.status,
      state: "starting",
      lastError: undefined,
      details: this.statusDetails("starting"),
    };
    this.client = this.transportFactory.createClient(required);
    if (this.probeOnStart) {
      const probe = await this.probeBotIdentity();
      if (!probe.ok) {
        this.status = {
          ...this.status,
          state: "failed",
          lastError: probe.error ?? "飞书机器人配置检查失败",
          details: this.statusDetails("probe-failed"),
        };
        return;
      }
    }
    if (!this.connectOnStart) {
      this.status = {
        ...this.status,
        state: "connected",
        details: this.statusDetails("configuration-checked"),
      };
      return;
    }
    this.dispatcher = this.transportFactory.createDispatcher(this.credentials);
    this.dispatcher.register(this.eventHandlers());
    this.wsClient = this.transportFactory.createWsClient(required, this.wsCallbacks());
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    this.status = {
      ...this.status,
      state: this.status.state === "connected" ? "connected" : "starting",
      details: this.statusDetails("websocket-started"),
    };
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = undefined;
    this.dispatcher = undefined;
    this.typingReactions.clear();
    this.actionMessageIds.clear();
    this.driveDownloadRequests.clear();
    this.pendingDriveFolderConfigs.clear();
    this.recentDriveFolderListings.clear();
    this.status = {
      ...this.status,
      state: "stopped",
      details: this.statusDetails("stopped"),
    };
  }

  async login(): Promise<ChannelLoginResult> {
    const missing = missingFeishuCredentials(this.credentials);
    if (missing.length > 0) {
      return {
        state: "login_required",
        message: `飞书没有扫码登录流程。请配置 ${missing.join(", ")} 后重新启动。`,
      };
    }
    return {
      state: "connected",
      message: "飞书使用 App ID / App Secret 连接，当前配置已存在。",
    };
  }

  async getStatus(): Promise<ChannelStatus> {
    const details = this.status.details;
    const lastSkipReason = stringDetail(details, "lastSkipReason");
    const lastTypingError = stringDetail(details, "lastTypingError");
    return {
      ...this.status,
      details: {
        ...this.statusDetails(stringDetail(details, "phase") ?? "status"),
        ...(lastSkipReason ? { lastSkipReason } : {}),
        ...(lastTypingError ? { lastTypingError } : {}),
      },
    };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      text: true,
      media: true,
      receiveMedia: true,
      typing: true,
      direct: true,
      group: this.groupEnabled,
      thread: false,
      login: "token",
      messageUpdate: true,
      streamingHint: true,
      buttons: true,
      cards: true,
    };
  }

  getDeliveryPolicy(): ChannelDeliveryPolicy {
    return {
      ...DEFAULT_CHANNEL_DELIVERY_POLICY,
      progress: "aggregate",
      taskLifecycle: "update-progress",
    };
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  setGroupEnabled(enabled: boolean): void {
    this.groupEnabled = enabled;
    this.status = {
      ...this.status,
      details: this.statusDetails(enabled ? "group-enabled" : "group-disabled"),
    };
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult> {
    return this.sendFeishuMessage(target, "post", buildFeishuPostContent(text), options);
  }

  async sendActionMessage(target: ChannelTarget, message: ChannelActionMessage, options?: SendOptions): Promise<SendResult> {
    const result = await this.sendFeishuMessage(target, "interactive", JSON.stringify(buildFeishuActionCard(message, target)), options);
    this.actionMessageIds.add(result.messageId);
    return result;
  }

  async updateText(_target: ChannelTarget, messageId: string, text: string, options?: SendOptions): Promise<SendResult> {
    const client = this.ensureClient();
    const isActionMessage = options?.metadata?.messageKind === "action" || this.actionMessageIds.has(messageId);
    if (isActionMessage) {
      return this.updateActionCard(client, _target, messageId, text);
    }
    if (!client.request) throw new Error("Feishu SDK client does not support raw requests");
    const response = await client.request<FeishuApiResponse<FeishuSentMessageData>>({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      data: {
        msg_type: "post",
        content: buildFeishuPostContent(text),
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      const errorText = formatFeishuApiError(response, "飞书消息更新失败");
      this.recordSendError(new Error(errorText), "update-failed");
      throw new Error(errorText);
    }
    this.actionMessageIds.delete(messageId);
    return this.recordSendResult(response, messageId);
  }

  private async updateActionCard(client: FeishuSdkClient, target: ChannelTarget, messageId: string, text: string): Promise<SendResult> {
    const card = buildFeishuActionCard({ text, buttonGroups: [] }, target);
    const cardApi = client.cardkit?.v1?.card;
    let cardkitError: Error | undefined;
    if (cardApi) {
      try {
        const converted = await cardApi.idConvert({ data: { message_id: messageId } });
        if (converted.code !== undefined && converted.code !== 0) {
          throw new Error(formatFeishuApiError(converted, "飞书卡片 ID 转换失败"));
        }
        const cardId = converted.data?.card_id;
        if (!cardId) throw new Error("飞书卡片 ID 转换响应缺少 card_id");
        const response = await cardApi.update({
          path: { card_id: cardId },
          data: {
            card: { type: "card_json", data: JSON.stringify(card) },
            sequence: this.now(),
            uuid: buildFeishuMessageUuid(),
          },
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new Error(formatFeishuApiError(response, "飞书卡片更新失败"));
        }
        this.actionMessageIds.delete(messageId);
        return this.recordSendResult({ code: 0, data: { message_id: messageId } }, messageId);
      } catch (error) {
        cardkitError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (client.request) {
      const response = await client.request<FeishuApiResponse<FeishuSentMessageData>>({
        method: "PATCH",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        data: { content: JSON.stringify(card) },
      });
      if (response.code !== undefined && response.code !== 0) {
        const errorText = formatFeishuApiError(response, "飞书卡片更新失败");
        const error = cardkitError ? new Error(`${errorText}; cardkit fallback reason: ${cardkitError.message}`) : new Error(errorText);
        this.recordSendError(error, "card-update-failed");
        throw error;
      }
      this.actionMessageIds.delete(messageId);
      return this.recordSendResult(response, messageId);
    }
    if (cardkitError) {
      this.recordSendError(cardkitError, "card-update-failed");
      throw cardkitError;
    }
    throw new Error("Feishu SDK client does not support card update requests");
  }

  async sendMedia(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult> {
    if (media.type !== "image" && media.type !== "file") {
      throw new Error(`FeishuAdapter 当前只支持图片和文件媒体发送: ${media.type}`);
    }
    const client = this.ensureClient();
    try {
      const materialized = await materializeFeishuChannelMedia(media);
      if (media.caption?.trim()) {
        await this.sendText(target, media.caption.trim(), options);
      }
      const decision = decideFeishuMediaDelivery(media, materialized.buffer.length);
      if (decision.kind === "image") {
        const upload = await client.im.image.create({
          data: {
            image_type: "message",
            image: materialized.buffer,
          },
        });
        const imageKey = feishuUploadKey(upload, "image_key");
        if (!imageKey) throw new Error("飞书图片上传响应缺少 image_key");
        return this.sendFeishuMessage(target, "image", JSON.stringify({ image_key: imageKey }), options);
      }
      if (decision.kind === "drive") {
        return await this.sendDriveFileLink(client, target, materialized, options);
      }
      const upload = await client.im.file.create({
        data: {
          file_type: feishuFileTypeForName(materialized.fileName, materialized.mimeType),
          file_name: materialized.fileName,
          file: materialized.buffer,
        },
      });
      const fileKey = feishuUploadKey(upload, "file_key");
      if (!fileKey) throw new Error("飞书文件上传响应缺少 file_key");
      return this.sendFeishuMessage(target, "file", JSON.stringify({ file_key: fileKey }), options);
    } catch (error) {
      this.recordSendError(error, "media-send-failed");
      throw error;
    }
  }

  private async sendDriveFileLink(
    client: FeishuSdkClient,
    target: ChannelTarget,
    materialized: { buffer: Buffer; fileName: string; mimeType?: string },
    options?: SendOptions,
  ): Promise<SendResult> {
    const driveFolderToken = this.credentials.driveFolderToken?.trim();
    if (!driveFolderToken) {
      throw new ChannelMediaDeliveryError("飞书聊天附件最大 30 MB；发送更大文件需要配置 FEISHU_DRIVE_FOLDER_TOKEN。", {
        stage: "validate",
        reasonCode: "feishu_drive_folder_token_missing",
      });
    }
    const openId = stringDetail(target.context, "feishuSenderOpenId");
    if (!openId) {
      throw new ChannelMediaDeliveryError("飞书 Drive 大文件发送需要当前消息事件里的 open_id，不能使用 user_id/union_id 代替。", {
        stage: "permission",
        reasonCode: "feishu_sender_open_id_missing",
      });
    }
    const uploaded = await uploadFeishuDriveFile({
      client,
      folderToken: driveFolderToken,
      fileName: materialized.fileName,
      buffer: materialized.buffer,
    });
    await grantFeishuDriveFileView({
      client,
      fileToken: uploaded.fileToken,
      openId,
    });
    return this.sendText(target, `文件超过飞书聊天附件 30 MB 限制，已作为云空间链接发送：\n${materialized.fileName}\n${uploaded.url}`, options);
  }

  private async sendFeishuMessage(
    target: ChannelTarget,
    msgType: string,
    content: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const client = this.ensureClient();
    const uuid = buildFeishuMessageUuid();
    const sourceMessageId = options?.replyToMessageId ?? stringDetail(target.context, "sourceMessageId");
    let response: FeishuApiResponse<FeishuSentMessageData> | undefined;
    if (sourceMessageId) {
      try {
        response = await client.im.message.reply({
          path: { message_id: sourceMessageId },
          data: {
            content,
            msg_type: msgType,
            uuid,
          },
        });
        if (response.code === undefined || response.code === 0) {
          return this.recordSendResult(response, uuid);
        }
      } catch (error) {
        this.recordSendError(error, "reply-failed");
      }
    }
    response = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: target.conversation.id,
        msg_type: msgType,
        content,
        uuid,
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      const errorText = formatFeishuApiError(response, "飞书消息发送失败");
      this.recordSendError(new Error(errorText), "create-failed");
      throw new Error(errorText);
    }
    return this.recordSendResult(response, uuid);
  }

  async sendTyping(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void> {
    const messageId = options?.replyToMessageId ?? stringDetail(target.context, "sourceMessageId");
    if (!messageId) return;
    if (typing) {
      await this.addTypingReaction(messageId);
      return;
    }
    await this.removeTypingReaction(messageId);
  }

  private eventHandlers(): FeishuEventHandlers {
    return {
      "im.message.receive_v1": (event) => this.handleIncomingEvent(event as FeishuMessageReceiveEvent),
      "card.action.trigger": (event) => this.handleCardActionEvent(event as FeishuCardActionEvent),
    };
  }

  private async handleCardActionEvent(event: FeishuCardActionEvent): Promise<Record<string, unknown> | void> {
    const payload = feishuCardActionPayload(event);
    const driveDownloadAction = feishuDriveDownloadCardAction(payload);
    if (driveDownloadAction) {
      return this.handleDriveDownloadCardAction(payload, driveDownloadAction);
    }
    const inbound = feishuCardActionToInboundText(payload);
    if (!inbound) {
      this.status = {
        ...this.status,
        details: {
          ...this.statusDetails("event-skipped"),
          lastSkipReason: "unsupported_card_action",
        },
      };
      return;
    }
    const senderId = cardActionSenderId(payload);
    const chatId = cardActionChatId(payload);
    if (!senderId || !chatId) {
      this.status = {
        ...this.status,
        details: {
          ...this.statusDetails("event-skipped"),
          lastSkipReason: "missing_card_action_fields",
        },
      };
      return;
    }
    const messageId = cardActionEventId(payload) ?? `card-action-${this.now()}`;
    const sourceMessageId = cardActionMessageId(payload);
    const routeKey = inbound.routeKey ?? `${this.id}:${this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID}:direct:${chatId}`;
    const timestamp = new Date(this.now()).toISOString();
    const message: ChannelMessage = {
      id: messageId,
      routeKey,
      channelId: this.id,
      accountId: this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
      sender: { id: senderId },
      conversation: { id: chatId, kind: routeKey.includes(":group:") ? "group" : "direct", displayName: routeKey.includes(":group:") ? "飞书群聊" : "飞书私聊" },
      text: inbound.text,
      timestamp,
      raw: sourceMessageId ? { event, sourceMessageId } : event,
    };
    const response = feishuCardActionResponse();
    if (!this.recordMessageId(message.id)) return response;
    this.status = {
      ...this.status,
      lastInboundAt: message.timestamp,
      details: this.statusDetails("card-action-received"),
    };
    this.updateCardActionByCallbackToken(payload, inbound);
    this.runCardActionHandler(message);
    return response;
  }

  private updateCardActionByCallbackToken(event: FeishuCardActionEvent, inbound: { text: string }): void {
    this.updateCardByCallbackToken(event, cardActionResponseText(inbound.text));
  }

  private updateCardByCallbackToken(event: FeishuCardActionEvent, text: string): void {
    const token = cardActionUpdateToken(event);
    const client = this.client;
    if (!token || !client?.request) return;
    const request = client.request.bind(client);

    const card = buildFeishuActionCard({ text, buttonGroups: [] });
    void (async () => {
      try {
        const response = await request<FeishuApiResponse>({
          method: "POST",
          url: "/open-apis/interactive/v1/card/update",
          data: { token, card },
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new Error(formatFeishuApiError(response, "飞书卡片回调延时更新失败"));
        }
      } catch (error) {
        this.status = {
          ...this.status,
          state: "degraded",
          lastError: error instanceof Error ? error.message : String(error),
          details: this.statusDetails("card-callback-update-failed"),
        };
      }
    })();
  }

  private runCardActionHandler(message: ChannelMessage): void {
    void (async () => {
      try {
        await this.handler?.(message);
      } catch (error) {
        this.status = {
          ...this.status,
          state: "degraded",
          lastError: error instanceof Error ? error.message : String(error),
          details: this.statusDetails("handler-failed"),
        };
      }
    })();
  }

  private async handleIncomingEvent(event: FeishuMessageReceiveEvent): Promise<void> {
    if (event.message?.chat_type === "group" && !this.groupEnabled) {
      this.status = {
        ...this.status,
        details: {
          ...this.statusDetails("event-skipped"),
          lastSkipReason: "group_disabled",
        },
      };
      return;
    }
    const mapped = feishuEventToChannelMessage(event, {
      channelId: this.id,
      accountId: this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
      botOpenId: this.botOpenId,
      expectedAppId: this.credentials.appId,
      now: this.now(),
      staleMessageMs: this.staleMessageMs,
    });
    if (!mapped.ok) {
      this.status = {
        ...this.status,
        details: {
          ...this.statusDetails("event-skipped"),
          lastSkipReason: mapped.reason,
        },
      };
      return;
    }
    let message = mapped.message;
    if (isFeishuGroupMessageWithoutBotMention(message)) {
      this.status = {
        ...this.status,
        details: {
          ...this.statusDetails("event-skipped"),
          lastSkipReason: "group_bot_not_mentioned",
        },
      };
      return;
    }
    if (!this.recordMessageId(message.id)) {
      this.status = {
        ...this.status,
        details: {
          ...this.statusDetails("duplicate-skipped"),
          lastSkipReason: "duplicate_message",
        },
      };
      return;
    }
    if (await this.tryHandleDriveFolderConfigMessage(message)) return;
    if (await this.tryHandleDriveFolderListMessage(message)) return;
    if (await this.tryHandleDriveFileDownloadMessage(message)) return;
    if (await this.tryHandleRecentDriveFolderFileMessage(message)) return;
    await downloadFeishuInboundAttachments({
      client: this.ensureClient(),
      message,
      rootDir: this.inboundMediaRootDir,
    });
    this.status = {
      ...this.status,
      lastInboundAt: message.timestamp,
      details: this.statusDetails("message-received"),
    };
    try {
      await this.handler?.(message);
    } catch (error) {
      this.status = {
        ...this.status,
        state: "degraded",
        lastError: error instanceof Error ? error.message : String(error),
        details: this.statusDetails("handler-failed"),
      };
    }
  }

  private async probeBotIdentity(): Promise<FeishuProbeResult> {
    const client = this.ensureClient();
    if (!client.request) return { ok: true, appId: this.credentials.appId };
    try {
      const response = await client.request<FeishuApiResponse<{
        pingBotInfo?: {
          botID?: string;
          botName?: string;
        };
      }>>({
        method: "POST",
        url: "/open-apis/bot/v1/openclaw_bot/ping",
        data: { needBotInfo: true },
      });
      if (response.code !== undefined && response.code !== 0) {
        return {
          ok: false,
          appId: this.credentials.appId,
          error: formatFeishuApiError(response, "飞书机器人配置检查失败"),
        };
      }
      const identity: FeishuBotIdentity = {
        appId: this.credentials.appId,
        botOpenId: response.data?.pingBotInfo?.botID,
        botName: response.data?.pingBotInfo?.botName,
      };
      this.botOpenId = identity.botOpenId;
      this.botName = identity.botName;
      this.status = {
        ...this.status,
        account: this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
        details: this.statusDetails("probe-ok"),
      };
      return { ok: true, ...identity };
    } catch (error) {
      return {
        ok: false,
        appId: this.credentials.appId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async tryHandleDriveFolderConfigMessage(message: ChannelMessage): Promise<boolean> {
    if (message.conversation.kind !== "direct") return false;
    const token = driveFolderTokenFromConfigText(message.text);
    if (token) {
      await this.configureDriveFolderToken(message, token);
      return true;
    }
    const pending = this.activePendingDriveFolderConfig(message.routeKey);
    if (pending && hasDriveFolderConfigIntent(message.text)) {
      await this.configureDriveFolderToken(message, pending.token);
      this.pendingDriveFolderConfigs.delete(message.routeKey);
      return true;
    }
    const candidate = driveFolderTokenFromText(message.text);
    if (!candidate) return false;
    this.pendingDriveFolderConfigs.set(message.routeKey, {
      token: candidate,
      expiresAt: this.now() + this.dedupTtlMs,
    });
    this.status = {
      ...this.status,
      lastInboundAt: message.timestamp,
      details: this.statusDetails("drive-folder-config-pending"),
    };
    await this.sendText(replyTargetFromMessage(message), [
      "收到飞书云空间文件夹链接。",
      "如果要把它设为大文件中转文件夹，请回复：帮我配置这个中转文件夹",
    ].join("\n"));
    return true;
  }

  private activePendingDriveFolderConfig(routeKey: string): PendingFeishuDriveFolderConfig | undefined {
    const pending = this.pendingDriveFolderConfigs.get(routeKey);
    if (!pending) return undefined;
    if (pending.expiresAt > this.now()) return pending;
    this.pendingDriveFolderConfigs.delete(routeKey);
    return undefined;
  }

  private async configureDriveFolderToken(message: ChannelMessage, token: string): Promise<void> {
    this.credentials.driveFolderToken = token;
    const saved = this.saveDriveFolderToken(token);
    this.status = {
      ...this.status,
      lastInboundAt: message.timestamp,
      details: this.statusDetails(saved ? "drive-folder-configured" : "drive-folder-configured-runtime-only"),
    };
    const suffix = saved ? "已保存到本机配置，当前运行也已生效。" : "当前运行已生效；但没有本地状态目录，重启后需要重新配置。";
    await this.sendText(replyTargetFromMessage(message), [
      "已配置飞书云空间中转文件夹。",
      suffix,
      "超过 30 MB 的文件会作为云空间链接发送。",
    ].join("\n"));
  }

  private async tryHandleDriveFolderListMessage(message: ChannelMessage): Promise<boolean> {
    if (!hasDriveFolderListIntent(message.text)) return false;
    const target = replyTargetFromMessage(message);
    const folderToken = this.credentials.driveFolderToken?.trim();
    if (!folderToken) {
      await this.sendText(target, [
        "还没有配置飞书云空间中转文件夹。",
        "请先发送飞书文件夹链接，再回复：帮我配置这个中转文件夹",
      ].join("\n"));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-list-missing-config"),
      };
      return true;
    }
    try {
      const result = await listFeishuDriveFolderItems({
        client: this.ensureClient(),
        folderToken,
        pageSize: 20,
      });
      this.recentDriveFolderListings.set(message.routeKey, {
        files: result.files,
        expiresAt: this.now() + this.dedupTtlMs,
      });
      await this.sendText(target, formatDriveFolderListText(result.files, result.hasMore));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-listed"),
      };
      return true;
    } catch (error) {
      await this.sendText(target, driveDownloadFailureText("飞书云空间中转文件夹列表读取失败。", error));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-list-failed"),
      };
      return true;
    }
  }

  private activeRecentDriveFolderListing(routeKey: string): RecentFeishuDriveFolderListing | undefined {
    const listing = this.recentDriveFolderListings.get(routeKey);
    if (!listing) return undefined;
    if (listing.expiresAt > this.now()) return listing;
    this.recentDriveFolderListings.delete(routeKey);
    return undefined;
  }

  private async tryHandleRecentDriveFolderFileMessage(message: ChannelMessage): Promise<boolean> {
    const listing = this.activeRecentDriveFolderListing(message.routeKey);
    if (!listing) return false;
    const text = message.text?.trim();
    if (!text) return false;
    const wantsDownload = hasFeishuDriveDownloadIntent(text);
    const reference = resolveRecentDriveFolderFileReference(text, listing.files, wantsDownload);
    if (reference.kind === "none") return false;
    const target = replyTargetFromMessage(message);
    if (reference.kind === "ambiguous") {
      await this.sendText(target, [
        "中转站里匹配到多个文件，请直接说文件名或序号：",
        ...reference.files.map((file, index) => `${index + 1}. ${file.name}`),
      ].join("\n"));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-reference-ambiguous"),
      };
      return true;
    }
    if (reference.kind === "unsupported") {
      await this.sendText(target, [
        "这项不是云空间普通文件，暂不支持直接下载。",
        `名称：${reference.file.name}`,
        `类型：${reference.file.type}`,
      ].join("\n"));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-reference-unsupported"),
      };
      return true;
    }
    if (!wantsDownload) {
      await this.sendText(target, [
        `中转站里的文件是：${reference.file.name}`,
        "要保存到本机请回复：保存到桌面",
      ].join("\n"));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-reference-clarified"),
      };
      return true;
    }
    try {
      const destination = resolveFeishuDriveDownloadDirectory(text, {
        defaultRootDir: this.inboundMediaRootDir,
        desktopDir: this.desktopDir,
      });
      await this.requestDriveFileDownloadConfirmation(message, {
        fileToken: reference.file.token,
        fileName: reference.file.name,
        sourceUrl: reference.file.url ?? `feishu-drive:file:${reference.file.token}`,
        directory: destination.directory,
        directoryKind: destination.directoryKind,
      });
      return true;
    } catch (error) {
      await this.sendText(target, driveDownloadFailureText("飞书云空间文件下载失败。", error, reference.file.name));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-folder-reference-download-failed"),
      };
      return true;
    }
  }

  private async tryHandleDriveFileDownloadMessage(message: ChannelMessage): Promise<boolean> {
    const intent = resolveFeishuDriveDownloadIntent(message.text, {
      defaultRootDir: this.inboundMediaRootDir,
      desktopDir: this.desktopDir,
    });
    if (!intent) return false;
    const target = replyTargetFromMessage(message);
    try {
      const meta = await queryFeishuDriveFileMeta(this.ensureClient(), intent.fileToken);
      if (meta.docType !== "file") {
        await this.sendText(target, [
          "暂不支持下载飞书在线文档。",
          `类型：${meta.docType}`,
          "目前只支持云空间普通文件；文档、表格、多维表格需要导出功能。",
        ].join("\n"));
        return true;
      }
      await this.requestDriveFileDownloadConfirmation(message, {
        fileToken: intent.fileToken,
        fileName: sanitizeFeishuDriveDownloadFileName(meta.title, `${intent.fileToken}.bin`),
        sourceUrl: intent.sourceUrl,
        directory: intent.directory,
        directoryKind: intent.directoryKind,
      });
      return true;
    } catch (error) {
      await this.sendText(target, driveDownloadFailureText("飞书云空间文件下载失败。", error));
      this.status = {
        ...this.status,
        lastInboundAt: message.timestamp,
        details: this.statusDetails("drive-download-request-failed"),
      };
      return true;
    }
  }

  private async requestDriveFileDownloadConfirmation(
    message: ChannelMessage,
    request: {
      fileToken: string;
      fileName: string;
      sourceUrl: string;
      directory: string;
      directoryKind: FeishuDriveDownloadDirectoryKind;
    },
  ): Promise<void> {
    if (request.directoryKind !== "default") {
      await ensureFeishuDriveDownloadDirectory(request.directory, request.directoryKind);
    }
    const target = replyTargetFromMessage(message);
    const requestId = buildFeishuMessageUuid();
    const pending: PendingFeishuDriveDownload = {
      id: requestId,
      target,
      fileToken: request.fileToken,
      fileName: sanitizeFeishuDriveDownloadFileName(request.fileName, `${request.fileToken}.bin`),
      sourceUrl: request.sourceUrl,
      directory: request.directory,
      directoryKind: request.directoryKind,
      requesterOpenId: stringDetail(target.context, "feishuSenderOpenId"),
      state: "pending",
    };
    const result = await this.sendActionMessage(target, {
      text: [
        "确认下载飞书云空间文件",
        `文件：${pending.fileName}`,
        `保存到：${pending.directory}`,
        `来源：${pending.sourceUrl}`,
      ].join("\n"),
      buttonGroups: [
        [{ text: "下载", action: `${FEISHU_DRIVE_DOWNLOAD_ACTION_PREFIX}approve:${requestId}`, style: "primary" }],
        [{ text: "取消", action: `${FEISHU_DRIVE_DOWNLOAD_ACTION_PREFIX}cancel:${requestId}`, style: "danger" }],
      ],
    });
    pending.actionMessageId = result.messageId;
    this.driveDownloadRequests.set(requestId, pending);
    this.status = {
      ...this.status,
      lastInboundAt: message.timestamp,
      details: this.statusDetails("drive-download-pending"),
    };
  }

  private async handleDriveDownloadCardAction(
    event: FeishuCardActionEvent,
    action: FeishuDriveDownloadCardAction,
  ): Promise<Record<string, unknown>> {
    const pending = this.driveDownloadRequests.get(action.requestId);
    if (!pending) {
      this.updateCardByCallbackToken(event, "下载请求已过期或已经处理。");
      return feishuCardActionResponse();
    }
    const actorOpenId = cardActionSenderId(event);
    if (pending.requesterOpenId && actorOpenId !== pending.requesterOpenId) {
      await this.updateDriveDownloadActionMessage(pending, [
        "只有发起人可以确认下载。",
        `文件：${pending.fileName}`,
      ].join("\n"));
      return feishuCardActionResponse();
    }
    if (action.decision === "cancel") {
      this.driveDownloadRequests.delete(action.requestId);
      await this.updateDriveDownloadActionMessage(pending, [
        "已取消下载。",
        `文件：${pending.fileName}`,
      ].join("\n"));
      return feishuCardActionResponse();
    }
    if (pending.state === "running") {
      await this.updateDriveDownloadActionMessage(pending, [
        "正在下载，请稍候。",
        `文件：${pending.fileName}`,
        `保存到：${pending.directory}`,
      ].join("\n"));
      return feishuCardActionResponse();
    }
    pending.state = "running";
    void this.runDriveDownload(pending);
    return feishuCardActionResponse();
  }

  private async runDriveDownload(pending: PendingFeishuDriveDownload): Promise<void> {
    try {
      await this.updateDriveDownloadActionMessage(pending, [
        "正在下载飞书云空间文件。",
        `文件：${pending.fileName}`,
        `保存到：${pending.directory}`,
      ].join("\n"));
      await ensureFeishuDriveDownloadDirectory(pending.directory, pending.directoryKind);
      const localPath = await uniqueFeishuDriveDownloadPath(pending.directory, pending.fileName);
      await downloadFeishuDriveFileToPath({
        client: this.ensureClient(),
        fileToken: pending.fileToken,
        localPath,
      });
      this.driveDownloadRequests.delete(pending.id);
      await this.updateDriveDownloadActionMessage(pending, [
        "已下载飞书云空间文件。",
        `文件：${pending.fileName}`,
        `保存到：${localPath}`,
      ].join("\n"));
      this.status = {
        ...this.status,
        lastOutboundAt: new Date(this.now()).toISOString(),
        lastError: undefined,
        details: this.statusDetails("drive-download-completed"),
      };
    } catch (error) {
      this.driveDownloadRequests.delete(pending.id);
      this.recordSendError(error, "drive-download-failed");
      await this.updateDriveDownloadActionMessage(pending, driveDownloadFailureText("飞书云空间文件下载失败。", error, pending.fileName));
    }
  }

  private async updateDriveDownloadActionMessage(pending: PendingFeishuDriveDownload, text: string): Promise<void> {
    try {
      if (pending.actionMessageId) {
        await this.updateText(pending.target, pending.actionMessageId, text, { metadata: { messageKind: "action" } });
        return;
      }
      await this.sendText(pending.target, text);
    } catch (error) {
      this.recordSendError(error, "drive-download-card-update-failed");
      try {
        await this.sendText(pending.target, text);
      } catch {
        // Keep the original update failure in channel status.
      }
    }
  }

  private saveDriveFolderToken(token: string): boolean {
    if (!this.stateDir) return false;
    const accountId = this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID;
    const filePath = path.join(this.stateDir, "accounts", accountId, "credentials.local.json");
    const existing = readJsonFile<ChannelAccountCredentialsDocument | undefined>(filePath, undefined);
    writeJsonFileAtomic(filePath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      channelId: this.id,
      channelType: "feishu",
      accountId,
      credentials: cleanCredentialRecord({
        ...existing?.credentials,
        appId: this.credentials.appId,
        appSecret: this.credentials.appSecret,
        domain: this.credentials.domain,
        verificationToken: this.credentials.verificationToken,
        encryptKey: this.credentials.encryptKey,
        driveFolderToken: token,
      }),
      updatedAt: new Date(this.now()).toISOString(),
    } satisfies ChannelAccountCredentialsDocument);
    return true;
  }

  private wsCallbacks(): FeishuWsCallbacks {
    return {
      onReady: () => {
        this.status = {
          ...this.status,
          state: "connected",
          account: this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
          lastError: undefined,
          details: this.statusDetails("websocket-connected"),
        };
      },
      onError: (error) => {
        this.status = {
          ...this.status,
          state: this.status.state === "connected" ? "degraded" : "failed",
          lastError: error.message,
          details: this.statusDetails("websocket-error"),
        };
      },
      onReconnecting: () => {
        this.status = {
          ...this.status,
          state: "degraded",
          details: this.statusDetails("websocket-reconnecting"),
        };
      },
      onReconnected: () => {
        this.status = {
          ...this.status,
          state: "connected",
          lastError: undefined,
          details: this.statusDetails("websocket-reconnected"),
        };
      },
    };
  }

  private ensureClient(): FeishuSdkClient {
    if (this.client) return this.client;
    const missing = missingFeishuCredentials(this.credentials);
    if (missing.length > 0) {
      throw new Error(`飞书渠道未配置: ${missing.join(", ")}`);
    }
    this.client = this.transportFactory.createClient(this.requiredCredentials());
    return this.client;
  }

  private requiredCredentials(): Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials {
    const appId = this.credentials.appId;
    const appSecret = this.credentials.appSecret;
    if (!appId || !appSecret) {
      throw new Error(`飞书渠道未配置: ${missingFeishuCredentials(this.credentials).join(", ")}`);
    }
    return {
      ...this.credentials,
      appId,
      appSecret,
      domain: this.credentials.domain ?? DEFAULT_FEISHU_DOMAIN,
      accountId: this.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
    };
  }

  private recordSendResult(response: FeishuApiResponse<FeishuSentMessageData>, fallbackMessageId: string): SendResult {
    const deliveredAt = new Date(this.now()).toISOString();
    this.status = {
      ...this.status,
      lastOutboundAt: deliveredAt,
      lastError: undefined,
      details: this.statusDetails("message-sent"),
    };
    return {
      channelId: this.id,
      messageId: response.data?.message_id ?? fallbackMessageId,
      deliveredAt,
      raw: response,
    };
  }

  private async addTypingReaction(messageId: string): Promise<void> {
    if (this.typingReactions.has(messageId)) return;
    const client = this.ensureClient();
    try {
      const response: FeishuApiResponse<FeishuReactionData> = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: {
            emoji_type: FEISHU_TYPING_EMOJI_TYPE,
          },
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        this.recordTypingError(new Error(formatFeishuApiError(response, "飞书 typing 表情添加失败")), "typing-add-failed");
        return;
      }
      const reactionId = response.data?.reaction_id;
      if (reactionId) this.typingReactions.set(messageId, reactionId);
    } catch (error) {
      this.recordTypingError(error, "typing-add-failed");
    }
  }

  private async removeTypingReaction(messageId: string): Promise<void> {
    const reactionId = this.typingReactions.get(messageId);
    if (!reactionId) return;
    const client = this.ensureClient();
    try {
      const response = await client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        this.recordTypingError(new Error(formatFeishuApiError(response, "飞书 typing 表情移除失败")), "typing-remove-failed");
        return;
      }
      this.typingReactions.delete(messageId);
    } catch (error) {
      this.recordTypingError(error, "typing-remove-failed");
    }
  }

  private recordSendError(error: unknown, phase: string): void {
    this.status = {
      ...this.status,
      state: this.status.state === "connected" ? "degraded" : this.status.state,
      lastError: error instanceof Error ? error.message : String(error),
      details: this.statusDetails(phase),
    };
  }

  private recordTypingError(error: unknown, phase: string): void {
    this.status = {
      ...this.status,
      details: {
        ...this.statusDetails(phase),
        lastTypingError: error instanceof Error ? error.message : String(error),
      },
    };
  }

  private recordMessageId(messageId: string): boolean {
    const now = this.now();
    for (const [id, expiresAt] of this.seenMessages) {
      if (expiresAt <= now) this.seenMessages.delete(id);
    }
    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.set(messageId, now + this.dedupTtlMs);
    return true;
  }

  private statusDetails(phase: string): Record<string, unknown> {
    const connection = this.wsClient?.getConnectionStatus?.();
    return feishuStatusDetails({
      phase,
      sourceVersion: this.sourceVersion,
      credentials: this.credentials,
      botOpenId: this.botOpenId,
      botName: this.botName,
      groupEnabled: this.groupEnabled,
      connectionState: connection?.state,
      reconnectAttempts: connection?.reconnectAttempts,
      dedupSize: this.seenMessages.size,
    });
  }
}

function feishuCardActionPayload(event: FeishuCardActionEvent): FeishuCardActionEvent {
  const nested = objectDetail(event, "event");
  return nested ? { ...event, ...nested } : event;
}

function cardActionSenderId(event: FeishuCardActionEvent): string | undefined {
  const operator = objectDetail(event, "operator");
  const user = objectDetail(event, "user");
  return event.sender?.sender_id?.open_id
    ?? event.open_id
    ?? event.user_id
    ?? event.union_id
    ?? stringDetail(operator, "open_id")
    ?? stringDetail(operator, "user_id")
    ?? stringDetail(operator, "union_id")
    ?? stringDetail(user, "open_id")
    ?? stringDetail(user, "user_id")
    ?? stringDetail(user, "union_id");
}

function cardActionChatId(event: FeishuCardActionEvent): string | undefined {
  const context = objectDetail(event, "context");
  return event.chat_id
    ?? event.open_chat_id
    ?? stringDetail(context, "chat_id")
    ?? stringDetail(context, "open_chat_id");
}

function cardActionEventId(event: FeishuCardActionEvent): string | undefined {
  return event.event_id;
}

function cardActionMessageId(event: FeishuCardActionEvent): string | undefined {
  const context = objectDetail(event, "context");
  return event.open_message_id
    ?? event.message_id
    ?? stringDetail(context, "open_message_id")
    ?? stringDetail(context, "message_id");
}

function cardActionUpdateToken(event: FeishuCardActionEvent): string | undefined {
  return event.token && event.token.length > 0 ? event.token : undefined;
}

function feishuCardActionResponse(): Record<string, unknown> {
  return {};
}

function cardActionResponseText(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (/^\/(?:ok|yes|approve|1)(?:\s|$)/.test(normalized)) {
    return "审批已处理：已通过，当前操作将继续执行。\n下一步：等待当前任务继续输出；如需补充信息，直接发送普通消息。";
  }
  if (/^\/(?:p|yes-session|ok-session|approve-session)(?:\s|$)/.test(normalized)) {
    return "审批已处理：已按本会话通过，当前操作将继续执行。\n下一步：等待当前任务继续输出；如需补充信息，直接发送普通消息。";
  }
  if (/^\/(?:no|deny|reject|2)(?:\s|$)/.test(normalized)) {
    return "审批已处理：已拒绝。\n下一步：等待当前任务确认拒绝结果；如需继续，直接发送普通消息。";
  }
  return "操作已提交，正在处理。\n下一步：等待当前操作完成；如需查看状态，发送 `/status`。";
}

function objectDetail(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

class DefaultFeishuTransportFactory implements FeishuTransportFactory {
  createClient(credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials): FeishuSdkClient {
    return new Client({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appType: AppType.SelfBuild,
      domain: resolveSdkDomain(credentials.domain),
      logger: SILENT_FEISHU_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
    }) as unknown as FeishuSdkClient;
  }

  createDispatcher(credentials: FeishuCredentials): FeishuEventDispatcher {
    return new EventDispatcher({
      verificationToken: credentials.verificationToken ?? "",
      encryptKey: credentials.encryptKey ?? "",
      logger: SILENT_FEISHU_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
    }) as unknown as FeishuEventDispatcher;
  }

  createWsClient(
    credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials,
    callbacks: FeishuWsCallbacks,
  ): FeishuWsClient {
    return new WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: resolveSdkDomain(credentials.domain),
      logger: SILENT_FEISHU_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
      autoReconnect: true,
      source: "codex-wechat-middleware",
      onReady: callbacks.onReady,
      onError: callbacks.onError,
      onReconnecting: callbacks.onReconnecting,
      onReconnected: callbacks.onReconnected,
      handshakeTimeoutMs: 30_000,
      wsConfig: { pingTimeout: 10 },
    }) as unknown as FeishuWsClient;
  }
}

function resolveSdkDomain(domain: string | undefined): Domain | string {
  const normalized = (domain ?? DEFAULT_FEISHU_DOMAIN).trim().toLowerCase();
  if (normalized === "feishu") return Domain.Feishu;
  if (normalized === "lark") return Domain.Lark;
  return domain ?? DEFAULT_FEISHU_DOMAIN;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isFeishuGroupMessageWithoutBotMention(message: ChannelMessage): boolean {
  if (message.conversation.kind !== "group") return false;
  const raw = message.raw as {
    chatCodex?: {
      feishu?: {
        group?: {
          mentionedBot?: boolean;
        };
      };
    };
  } | undefined;
  return raw?.chatCodex?.feishu?.group?.mentionedBot !== true;
}

function feishuDriveDownloadCardAction(event: FeishuCardActionEvent): FeishuDriveDownloadCardAction | undefined {
  const action = cardActionString(event);
  if (!action?.startsWith(FEISHU_DRIVE_DOWNLOAD_ACTION_PREFIX)) return undefined;
  const rest = action.slice(FEISHU_DRIVE_DOWNLOAD_ACTION_PREFIX.length);
  const match = /^(approve|cancel):(.+)$/.exec(rest);
  if (!match) return undefined;
  return {
    decision: match[1] === "approve" ? "approve" : "cancel",
    requestId: match[2],
  };
}

function cardActionString(event: FeishuCardActionEvent): string | undefined {
  const nested = objectDetail(event, "event");
  const source = nested ?? event;
  const rawAction = objectDetail(source, "action")
    ?? objectDetail(source, "value")
    ?? objectDetail(event, "action")
    ?? objectDetail(event, "value")
    ?? source;
  const value = objectDetail(rawAction, "value") ?? rawAction as Record<string, unknown>;
  return stringDetail(value, "action");
}

function driveDownloadFailureText(title: string, error: unknown, fileName?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const stage = error instanceof ChannelMediaDeliveryError ? error.stage : "download";
  const reasonCode = error instanceof ChannelMediaDeliveryError ? error.reasonCode : "feishu_drive_download_failed";
  return [
    title,
    ...(fileName ? [`文件：${fileName}`] : []),
    `阶段：${stage}`,
    `原因：${reasonCode}`,
    `说明：${message}`,
  ].join("\n");
}

function driveFolderTokenFromConfigText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const link = driveFolderLinkFromText(trimmed);
  if (!link) return undefined;
  const token = link.token;
  const remaining = trimmed.replace(link.matchedText, " ");
  return hasDriveFolderConfigIntent(remaining) ? token : undefined;
}

function driveFolderTokenFromText(text: string | undefined): string | undefined {
  return driveFolderLinkFromText(text)?.token;
}

function driveFolderLinkFromText(text: string | undefined): { token: string; matchedText: string } | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const match = /(https?:\/\/[^\s<>"']*\/drive\/folder\/([A-Za-z0-9_-]+)[^\s<>"']*)/i.exec(trimmed)
    ?? /(^|\s)(\/drive\/folder\/([A-Za-z0-9_-]+)(?:[/?#][^\s<>"']*)?)/i.exec(trimmed);
  if (!match) return undefined;
  const matchedText = match[1] || match[2];
  const token = match[2]?.startsWith("/")
    ? match[3]
    : match[2];
  return token ? { token, matchedText } : undefined;
}

function hasDriveFolderConfigIntent(text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  return /(配置|设置|设为|保存|绑定|配对|中转文件夹|中转目录|FEISHU_DRIVE_FOLDER_TOKEN|drive\s*folder|folder\s*token)/i.test(trimmed);
}

function hasDriveFolderListIntent(text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  if (/(配置|设置|设为|保存|绑定|配对|下载|发送|上传|FEISHU_DRIVE_FOLDER_TOKEN)/i.test(trimmed)) return false;
  const mentionsRelayFolder = /(中转站|中转文件夹|中转目录|云空间中转|飞书云空间中转|drive\s*folder|relay\s*folder)/i.test(trimmed);
  const asksForContents = /(里面|里边|里头|有什么|有哪些|查看|看看|看一下|列出|列表|清单|文件|内容)/i.test(trimmed);
  return mentionsRelayFolder && asksForContents;
}

function formatDriveFolderListText(files: FeishuDriveFolderItem[], hasMore: boolean): string {
  if (files.length === 0) return "飞书云空间中转文件夹当前没有文件。";
  const header = `中转文件夹里有 ${files.length} 项${hasMore ? "（仅显示前 20 项）" : ""}：`;
  const lines = files.map((file, index) => {
    const label = driveFolderItemTypeLabel(file.type);
    const url = file.url ? `\n   ${file.url}` : "";
    return `${index + 1}. ${label} ${file.name}${url}`;
  });
  if (hasMore) lines.push("还有更多文件，当前先显示前 20 项。");
  return [header, ...lines].join("\n");
}

function driveFolderItemTypeLabel(type: string): string {
  switch (type) {
    case "folder":
      return "[文件夹]";
    case "file":
      return "[文件]";
    case "doc":
    case "docx":
      return "[文档]";
    case "sheet":
      return "[表格]";
    case "bitable":
      return "[多维表格]";
    case "mindnote":
      return "[思维笔记]";
    case "slides":
      return "[幻灯片]";
    case "shortcut":
      return "[快捷方式]";
    default:
      return `[${type}]`;
  }
}

type RecentDriveFolderFileReference =
  | { kind: "none" }
  | { kind: "matched"; file: FeishuDriveFolderItem }
  | { kind: "ambiguous"; files: FeishuDriveFolderItem[] }
  | { kind: "unsupported"; file: FeishuDriveFolderItem };

function resolveRecentDriveFolderFileReference(
  text: string,
  files: FeishuDriveFolderItem[],
  allowSingleFileFallback: boolean,
): RecentDriveFolderFileReference {
  const trimmed = text.trim();
  if (!trimmed || files.length === 0) return { kind: "none" };
  const hasReference = hasRecentDriveFolderFileReference(trimmed);
  const ordinaryFiles = files.filter(isOrdinaryDriveFile);
  const indexed = indexedDriveFolderFile(trimmed, files);
  if (indexed) return indexed.type === "file" ? { kind: "matched", file: indexed } : { kind: "unsupported", file: indexed };
  const matches = dedupeDriveFolderItems(files.filter((file) => driveFolderItemMatchesText(file, trimmed)));
  if (matches.length === 1) {
    const file = matches[0];
    return file.type === "file" ? { kind: "matched", file } : { kind: "unsupported", file };
  }
  if (matches.length > 1) return { kind: "ambiguous", files: matches };
  if (ordinaryFiles.length === 1 && (hasReference || allowSingleFileFallback)) {
    return { kind: "matched", file: ordinaryFiles[0] };
  }
  if (allowSingleFileFallback && hasReference && ordinaryFiles.length > 1) {
    return { kind: "ambiguous", files: ordinaryFiles };
  }
  return { kind: "none" };
}

function hasRecentDriveFolderFileReference(text: string): boolean {
  return /(中转站|中转云盘|中转文件夹|中转目录|云盘|云空间|刚才|上面|里面|列表|这个|那个|该文件|第\s*\d+|\d+\s*(?:号|项|个)|图片|照片|文件|jpg|jpeg|png|gif|webp|bmp|pptx?|pdf|docx?|xlsx?|zip|rar|7z|txt|csv|mp4|mov|mp3|wav)/i.test(text);
}

function indexedDriveFolderFile(text: string, files: FeishuDriveFolderItem[]): FeishuDriveFolderItem | undefined {
  const match = /(?:第\s*)?(\d+)\s*(?:个|项|号)?/.exec(text);
  if (!match) return undefined;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(index) || index < 1 || index > files.length) return undefined;
  return files[index - 1];
}

function driveFolderItemMatchesText(file: FeishuDriveFolderItem, text: string): boolean {
  const normalizedText = normalizeDriveFolderSearchText(text);
  const normalizedName = normalizeDriveFolderSearchText(file.name);
  if (normalizedName && normalizedText.includes(normalizedName)) return true;
  const extension = driveFolderFileExtension(file.name);
  const stem = extension ? file.name.slice(0, -(extension.length + 1)) : file.name;
  const normalizedStem = normalizeDriveFolderSearchText(stem);
  if (normalizedStem.length >= 3 && normalizedText.includes(normalizedStem)) return true;
  if (extension && driveFolderExtensionMatchesText(extension, text)) return true;
  if (/(图片|照片)/.test(text) && isImageDriveFolderFile(file.name)) return true;
  return false;
}

function normalizeDriveFolderSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s，,。.!！；;：:（）()[\]{}<>《》"'“”‘’_-]+/g, "");
}

function driveFolderExtensionMatchesText(extension: string, text: string): boolean {
  const tokens: string[] = text.toLowerCase().match(/[a-z0-9]{2,6}/g) ?? [];
  return driveFolderExtensionAliases(extension).some((alias) => tokens.includes(alias));
}

function driveFolderExtensionAliases(extension: string): string[] {
  const normalized = extension.toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return ["jpg", "jpeg"];
  return [normalized];
}

function driveFolderFileExtension(name: string): string | undefined {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim());
  return match?.[1]?.toLowerCase();
}

function isImageDriveFolderFile(name: string): boolean {
  const extension = driveFolderFileExtension(name);
  return extension ? ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(extension) : false;
}

function isOrdinaryDriveFile(file: FeishuDriveFolderItem): boolean {
  return file.type === "file";
}

function dedupeDriveFolderItems(files: FeishuDriveFolderItem[]): FeishuDriveFolderItem[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.type}:${file.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanCredentialRecord(credentials: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(credentials)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, value]) => [key, value.trim()]),
  );
}
