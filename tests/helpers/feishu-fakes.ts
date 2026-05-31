import type {
  FeishuApiResponse,
  FeishuCardActionEvent,
  FeishuCredentials,
  FeishuDriveFileListData,
  FeishuDriveMeta,
  FeishuEventDispatcher,
  FeishuEventHandlers,
  FeishuMessageReceiveEvent,
  FeishuReactionData,
  FeishuSdkClient,
  FeishuSentMessageData,
  FeishuTransportFactory,
  FeishuWsCallbacks,
  FeishuWsClient,
  FeishuWsConnectionStatus,
} from "../../src/channels/feishu/feishu-types.js";
import { Readable } from "node:stream";

export class FakeFeishuClient implements FeishuSdkClient {
  readonly replyPayloads: Array<Parameters<FeishuSdkClient["im"]["message"]["reply"]>[0]> = [];
  readonly createPayloads: Array<Parameters<FeishuSdkClient["im"]["message"]["create"]>[0]> = [];
  readonly imageCreatePayloads: Array<Parameters<FeishuSdkClient["im"]["image"]["create"]>[0]> = [];
  readonly fileCreatePayloads: Array<Parameters<FeishuSdkClient["im"]["file"]["create"]>[0]> = [];
  readonly messageResourceGetPayloads: Array<Parameters<FeishuSdkClient["im"]["messageResource"]["get"]>[0]> = [];
  readonly reactionCreatePayloads: Array<Parameters<FeishuSdkClient["im"]["messageReaction"]["create"]>[0]> = [];
  readonly reactionDeletePayloads: Array<Parameters<FeishuSdkClient["im"]["messageReaction"]["delete"]>[0]> = [];
  readonly driveFileUploadAllPayloads: Array<Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadAll"]>[0]> = [];
  readonly driveFileUploadPreparePayloads: Array<Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadPrepare"]>[0]> = [];
  readonly driveFileUploadPartPayloads: Array<Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadPart"]>[0]> = [];
  readonly driveFileUploadFinishPayloads: Array<Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadFinish"]>[0]> = [];
  readonly driveFileDownloadPayloads: Array<{ path: { file_token?: string } }> = [];
  readonly driveFileListPayloads: Array<Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["list"]>[0]> = [];
  readonly cardIdConvertPayloads: Array<{ data: { message_id: string } }> = [];
  readonly cardUpdatePayloads: Array<{ data: { card: { type: "card_json"; data: string }; uuid?: string; sequence: number }; path: { card_id: string } }> = [];
  readonly userGetPayloads: unknown[] = [];
  readonly requestPayloads: Array<{ method: string; url: string; data?: unknown; params?: Record<string, unknown> }> = [];
  probeResponse: FeishuApiResponse<{ pingBotInfo?: { botID?: string; botName?: string } }> = {
    code: 0,
    data: {
      pingBotInfo: {
        botID: "ou_bot",
        botName: "Codex Bot",
      },
    },
  };
  replyResponse: FeishuApiResponse<FeishuSentMessageData> = {
    code: 0,
    data: { message_id: "om_reply", chat_id: "oc_direct" },
  };
  createResponse: FeishuApiResponse<FeishuSentMessageData> = {
    code: 0,
    data: { message_id: "om_create", chat_id: "oc_direct" },
  };
  updateResponse: FeishuApiResponse<FeishuSentMessageData> = {
    code: 0,
    data: { message_id: "om_update", chat_id: "oc_direct" },
  };
  cardIdConvertResponse: FeishuApiResponse<{ card_id?: string }> = {
    code: 0,
    data: { card_id: "card_converted" },
  };
  cardUpdateResponse: FeishuApiResponse = {
    code: 0,
  };
  reactionCreateResponse: FeishuApiResponse<FeishuReactionData> = {
    code: 0,
    data: { reaction_id: "react_typing_1" },
  };
  reactionDeleteResponse: FeishuApiResponse = {
    code: 0,
  };
  driveUploadAllResponse: FeishuApiResponse<{ file_token?: string }> = {
    code: 0,
    data: { file_token: "box_file_upload" },
  };
  driveUploadPrepareResponse: FeishuApiResponse<{ upload_id?: string; block_size?: number; block_num?: number }> = {
    code: 0,
    data: { upload_id: "upload_1", block_size: 4 * 1024 * 1024, block_num: 1 },
  };
  driveUploadPartResponse: FeishuApiResponse = {
    code: 0,
  };
  driveUploadFinishResponse: FeishuApiResponse<{ file_token?: string }> = {
    code: 0,
    data: { file_token: "box_file_upload" },
  };
  driveMetaResponse: FeishuApiResponse<{ metas?: FeishuDriveMeta[] }> = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_upload",
        doc_type: "file",
        title: "file",
        owner_id: "ou_bot",
        create_time: "1",
        latest_modify_user: "ou_bot",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_upload",
      }],
    },
  };
  drivePermissionResponse: FeishuApiResponse = {
    code: 0,
  };
  driveFileListResponse: FeishuApiResponse<FeishuDriveFileListData> = {
    code: 0,
    data: {
      files: [],
      has_more: false,
    },
  };
  imageCreateResponse = {
    image_key: "img_upload",
  };
  fileCreateResponse = {
    file_key: "file_upload",
  };
  driveDownloadBuffer = Buffer.from("feishu-drive-file");
  driveDownloadHeaders: Record<string, string> = {};
  resourceBuffers = new Map<string, Buffer>();
  resourceHeaders = new Map<string, Record<string, string>>();
  replyError?: Error;
  imageCreateError?: Error;
  fileCreateError?: Error;
  messageResourceError?: Error;
  driveDownloadError?: Error;
  reactionCreateError?: Error;
  reactionDeleteError?: Error;

  drive = {
    v1: {
      file: {
        uploadAll: async (payload: Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadAll"]>[0]) => {
          this.driveFileUploadAllPayloads.push(payload);
          return this.driveUploadAllResponse.data ?? null;
        },
        uploadPrepare: async (payload: Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadPrepare"]>[0]) => {
          this.driveFileUploadPreparePayloads.push(payload);
          const size = payload.data.size;
          const blockSize = this.driveUploadPrepareResponse.data?.block_size ?? 4 * 1024 * 1024;
          return {
            ...this.driveUploadPrepareResponse,
            data: {
              ...this.driveUploadPrepareResponse.data,
              block_num: this.driveUploadPrepareResponse.data?.block_num ?? Math.ceil(size / blockSize),
            },
          };
        },
        uploadPart: async (payload: Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadPart"]>[0]) => {
          this.driveFileUploadPartPayloads.push(payload);
          return this.driveUploadPartResponse;
        },
        uploadFinish: async (payload: Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["uploadFinish"]>[0]) => {
          this.driveFileUploadFinishPayloads.push(payload);
          return this.driveUploadFinishResponse;
        },
        download: async (payload: { path: { file_token?: string } }) => {
          this.driveFileDownloadPayloads.push(payload);
          if (this.driveDownloadError) throw this.driveDownloadError;
          return {
            getReadableStream: () => Readable.from(this.driveDownloadBuffer),
            headers: this.driveDownloadHeaders,
          };
        },
        list: async (payload: Parameters<NonNullable<NonNullable<NonNullable<FeishuSdkClient["drive"]>["v1"]>["file"]>["list"]>[0] = {}) => {
          this.driveFileListPayloads.push(payload);
          return this.driveFileListResponse;
        },
      },
    },
  };

  cardkit = {
    v1: {
      card: {
        idConvert: async (payload: { data: { message_id: string } }): Promise<FeishuApiResponse<{ card_id?: string }>> => {
          this.cardIdConvertPayloads.push(payload);
          return this.cardIdConvertResponse;
        },
        update: async (payload: { data: { card: { type: "card_json"; data: string }; uuid?: string; sequence: number }; path: { card_id: string } }): Promise<FeishuApiResponse> => {
          this.cardUpdatePayloads.push(payload);
          return this.cardUpdateResponse;
        },
      },
    },
  };

  im = {
    message: {
      reply: async (payload: Parameters<FeishuSdkClient["im"]["message"]["reply"]>[0]): Promise<FeishuApiResponse<FeishuSentMessageData>> => {
        this.replyPayloads.push(payload);
        if (this.replyError) throw this.replyError;
        return this.replyResponse;
      },
      create: async (payload: Parameters<FeishuSdkClient["im"]["message"]["create"]>[0]): Promise<FeishuApiResponse<FeishuSentMessageData>> => {
        this.createPayloads.push(payload);
        return this.createResponse;
      },
    },
    image: {
      create: async (payload: Parameters<FeishuSdkClient["im"]["image"]["create"]>[0]) => {
        this.imageCreatePayloads.push(payload);
        if (this.imageCreateError) throw this.imageCreateError;
        return this.imageCreateResponse;
      },
    },
    file: {
      create: async (payload: Parameters<FeishuSdkClient["im"]["file"]["create"]>[0]) => {
        this.fileCreatePayloads.push(payload);
        if (this.fileCreateError) throw this.fileCreateError;
        return this.fileCreateResponse;
      },
    },
    messageResource: {
      get: async (payload: Parameters<FeishuSdkClient["im"]["messageResource"]["get"]>[0]) => {
        this.messageResourceGetPayloads.push(payload);
        if (this.messageResourceError) throw this.messageResourceError;
        const key = payload.path.file_key;
        const buffer = this.resourceBuffers.get(key) ?? Buffer.from("feishu-resource");
        const headers = this.resourceHeaders.get(key) ?? {};
        return {
          getReadableStream: () => Readable.from(buffer),
          headers,
        };
      },
    },
    messageReaction: {
      create: async (payload: Parameters<FeishuSdkClient["im"]["messageReaction"]["create"]>[0]): Promise<FeishuApiResponse<FeishuReactionData>> => {
        this.reactionCreatePayloads.push(payload);
        if (this.reactionCreateError) throw this.reactionCreateError;
        return this.reactionCreateResponse;
      },
      delete: async (payload: Parameters<FeishuSdkClient["im"]["messageReaction"]["delete"]>[0]): Promise<FeishuApiResponse> => {
        this.reactionDeletePayloads.push(payload);
        if (this.reactionDeleteError) throw this.reactionDeleteError;
        return this.reactionDeleteResponse;
      },
    },
  };

  async request<T = FeishuApiResponse>(payload?: { method: string; url: string; data?: unknown; params?: Record<string, unknown> }): Promise<T> {
    if (payload) {
      this.requestPayloads.push(payload);
      if (payload.method === "PATCH") return this.updateResponse as T;
      if (payload.url.includes("/drive/v1/files/upload_all")) return this.driveUploadAllResponse as T;
      if (payload.url.includes("/drive/v1/files/upload_prepare")) {
        const size = typeof (payload.data as { size?: unknown } | undefined)?.size === "number"
          ? (payload.data as { size: number }).size
          : 0;
        const blockSize = this.driveUploadPrepareResponse.data?.block_size ?? 4 * 1024 * 1024;
        return {
          ...this.driveUploadPrepareResponse,
          data: {
            ...this.driveUploadPrepareResponse.data,
            block_num: this.driveUploadPrepareResponse.data?.block_num ?? Math.ceil(size / blockSize),
          },
        } as T;
      }
      if (payload.url.includes("/drive/v1/files/upload_part")) return this.driveUploadPartResponse as T;
      if (payload.url.includes("/drive/v1/files/upload_finish")) return this.driveUploadFinishResponse as T;
      if (payload.method === "GET" && payload.url.includes("/drive/v1/files")) return this.driveFileListResponse as T;
      if (payload.url.includes("/drive/v1/metas/batch_query")) return this.driveMetaResponse as T;
      if (payload.url.includes("/permissions/") && payload.url.includes("/members")) return this.drivePermissionResponse as T;
    }
    return this.probeResponse as T;
  }

  sentTexts(): string[] {
    return [...this.replyPayloads, ...this.createPayloads].map((payload) => decodeFeishuPostText(payload.data.content));
  }
}

export class FakeFeishuDispatcher implements FeishuEventDispatcher {
  handlers: FeishuEventHandlers = {};

  register(handles: FeishuEventHandlers): this {
    this.handlers = { ...this.handlers, ...handles };
    return this;
  }

  async emitReceive(event: FeishuMessageReceiveEvent): Promise<void> {
    await this.handlers["im.message.receive_v1"]?.(event);
  }

  async emitCardAction(event: FeishuCardActionEvent): Promise<unknown> {
    return this.handlers["card.action.trigger"]?.(event);
  }
}

export class FakeFeishuWsClient implements FeishuWsClient {
  status: FeishuWsConnectionStatus = {
    state: "idle",
    reconnectAttempts: 0,
  };
  starts = 0;
  closes = 0;

  constructor(private readonly callbacks: FeishuWsCallbacks, private readonly autoReady = true) {}

  async start(_params: { eventDispatcher: FeishuEventDispatcher }): Promise<void> {
    this.starts += 1;
    this.status = {
      state: "connecting",
      reconnectAttempts: 0,
      lastConnectTime: Date.now(),
    };
    if (this.autoReady) {
      this.status = {
        ...this.status,
        state: "connected",
      };
      this.callbacks.onReady?.();
    }
  }

  close(_params?: { force?: boolean }): void {
    this.closes += 1;
    this.status = {
      state: "idle",
      reconnectAttempts: 0,
    };
  }

  getConnectionStatus(): FeishuWsConnectionStatus {
    return this.status;
  }
}

export class FakeFeishuTransportFactory implements FeishuTransportFactory {
  readonly client = new FakeFeishuClient();
  readonly dispatcher = new FakeFeishuDispatcher();
  wsClient?: FakeFeishuWsClient;
  autoReady = true;

  createClient(_credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials): FeishuSdkClient {
    return this.client;
  }

  createDispatcher(_credentials: FeishuCredentials): FeishuEventDispatcher {
    return this.dispatcher;
  }

  createWsClient(
    _credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials,
    callbacks: FeishuWsCallbacks,
  ): FeishuWsClient {
    this.wsClient = new FakeFeishuWsClient(callbacks, this.autoReady);
    return this.wsClient;
  }
}

type FeishuEventOverrides = Omit<Partial<FeishuMessageReceiveEvent>, "sender" | "message"> & {
  sender?: Partial<FeishuMessageReceiveEvent["sender"]>;
  message?: Partial<FeishuMessageReceiveEvent["message"]>;
};

export function sampleFeishuTextEvent(overrides: FeishuEventOverrides = {}): FeishuMessageReceiveEvent {
  const base: FeishuMessageReceiveEvent = {
    event_id: "ev_1",
    event_type: "im.message.receive_v1",
    app_id: "cli_1234567890abcdef",
    sender: {
      sender_id: { open_id: "ou_user" },
      sender_type: "user",
      tenant_key: "tenant",
    },
    message: {
      message_id: "om_in_1",
      create_time: String(Date.now()),
      chat_id: "oc_direct",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好 Codex" }),
    },
  };
  return {
    ...base,
    ...overrides,
    sender: {
      ...base.sender,
      ...overrides.sender,
    },
    message: {
      ...base.message,
      ...overrides.message,
    },
  };
}

export function decodeFeishuPostText(content: string): string {
  const parsed = JSON.parse(content) as {
    zh_cn?: {
      content?: Array<Array<{ text?: string }>>;
    };
  };
  return parsed.zh_cn?.content?.flat().map((item) => item.text ?? "").join("") ?? "";
}
