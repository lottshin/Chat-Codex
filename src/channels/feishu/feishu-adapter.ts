import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
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
import type { ChannelDeliveryPolicy } from "../../protocol/delivery-policy.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../protocol/delivery-policy.js";
import { buildFeishuActionCard, feishuCardActionToInboundText } from "./feishu-card.js";
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
const SILENT_FEISHU_SDK_LOGGER = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

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
      if (media.type === "image") {
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
    const token = cardActionUpdateToken(event);
    const client = this.client;
    if (!token || !client?.request) return;
    const request = client.request.bind(client);

    const card = buildFeishuActionCard({ text: cardActionResponseText(inbound.text), buttonGroups: [] });
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
