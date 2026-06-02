import type { ChannelMessage } from "../../protocol/channel.js";
import type { FileHistoryStore } from "../../bridge/file-history-store.js";
import type { Readable } from "node:stream";

export interface FeishuCredentials {
  appId?: string;
  appSecret?: string;
  domain?: string;
  accountId?: string;
  verificationToken?: string;
  encryptKey?: string;
  driveFolderToken?: string;
}

export interface FeishuAdapterOptions extends FeishuCredentials {
  id?: string;
  sourceVersion?: string;
  connectOnStart?: boolean;
  probeOnStart?: boolean;
  staleMessageMs?: number;
  dedupTtlMs?: number;
  groupEnabled?: boolean;
  transportFactory?: FeishuTransportFactory;
  now?: () => number;
  inboundMediaRootDir?: string;
  desktopDir?: string;
  stateDir?: string;
  fileHistory?: FileHistoryStore;
}

export interface FeishuBotIdentity {
  appId?: string;
  botOpenId?: string;
  botName?: string;
}

export interface FeishuProbeResult extends FeishuBotIdentity {
  ok: boolean;
  error?: string;
}

export interface FeishuApiResponse<TData = unknown> {
  code?: number;
  msg?: string;
  data?: TData;
}

export interface FeishuSentMessageData {
  message_id?: string;
  chat_id?: string;
  create_time?: string;
}

export interface FeishuReactionData {
  reaction_id?: string;
}

export interface FeishuImageUploadData {
  image_key?: string;
}

export interface FeishuFileUploadData {
  file_key?: string;
}

export interface FeishuDriveUploadData {
  file_token?: string;
}

export interface FeishuDrivePrepareData {
  upload_id?: string;
  block_size?: number;
  block_num?: number;
}

export interface FeishuDriveMeta {
  doc_token: string;
  doc_type: string;
  title?: string;
  owner_id?: string;
  create_time?: string;
  latest_modify_user?: string;
  latest_modify_time?: string;
  url?: string;
}

export interface FeishuDriveFileListItem {
  token: string;
  name: string;
  type: string;
  parent_token?: string;
  url?: string;
  shortcut_info?: {
    target_type: string;
    target_token: string;
  };
  created_time?: string;
  modified_time?: string;
  owner_id?: string;
}

export interface FeishuDriveFileListData {
  files?: FeishuDriveFileListItem[];
  next_page_token?: string;
  has_more?: boolean;
}

export interface FeishuResourceDownload {
  writeFile?: (filePath: string) => Promise<unknown>;
  getReadableStream: () => Readable;
  headers?: unknown;
}

export interface FeishuSdkClient {
  drive?: {
    v1?: {
      file?: {
        uploadAll(payload: {
          data: {
            file_name: string;
            parent_type: "explorer";
            parent_node: string;
            size: number;
            file: Buffer;
          };
        }): Promise<FeishuDriveUploadData | null>;
        uploadPrepare(payload: {
          data: {
            file_name: string;
            parent_type: "explorer";
            parent_node: string;
            size: number;
          };
        }): Promise<FeishuApiResponse<FeishuDrivePrepareData>>;
        uploadPart(payload: {
          data: {
            upload_id: string;
            seq: number;
            size: number;
            file: Buffer;
          };
        }): Promise<FeishuApiResponse | null>;
        uploadFinish(payload: {
          data: {
            upload_id: string;
            block_num: number;
          };
        }): Promise<FeishuApiResponse<FeishuDriveUploadData>>;
        download(payload: {
          path: {
            file_token?: string;
          };
        }): Promise<FeishuResourceDownload>;
        list(payload?: {
          params?: {
            page_size?: number;
            page_token?: string;
            folder_token?: string;
            order_by?: "EditedTime" | "CreatedTime";
            direction?: "ASC" | "DESC";
            option?: string;
            user_id_type?: "user_id" | "union_id" | "open_id";
          };
        }): Promise<FeishuApiResponse<FeishuDriveFileListData>>;
      };
    };
  };
  cardkit?: {
    v1?: {
      card?: {
        idConvert(payload: {
          data: {
            message_id: string;
          };
        }): Promise<FeishuApiResponse<{ card_id?: string }>>;
        update(payload: {
          data: {
            card: {
              type: "card_json";
              data: string;
            };
            uuid?: string;
            sequence: number;
          };
          path: {
            card_id: string;
          };
        }): Promise<FeishuApiResponse>;
      };
    };
  };
  im: {
    message: {
      reply(payload: {
        data: {
          content: string;
          msg_type: string;
          reply_in_thread?: boolean;
          uuid?: string;
        };
        path: {
          message_id: string;
        };
      }): Promise<FeishuApiResponse<FeishuSentMessageData>>;
      create(payload: {
        data: {
          receive_id: string;
          msg_type: string;
          content: string;
          uuid?: string;
        };
        params: {
          receive_id_type: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
        };
      }): Promise<FeishuApiResponse<FeishuSentMessageData>>;
    };
    image: {
      create(payload: {
        data: {
          image_type: "message" | "avatar";
          image: Buffer;
        };
      }): Promise<FeishuImageUploadData | FeishuApiResponse<FeishuImageUploadData> | null>;
    };
    file: {
      create(payload: {
        data: {
          file_type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
          file_name: string;
          duration?: number;
          file: Buffer;
        };
      }): Promise<FeishuFileUploadData | FeishuApiResponse<FeishuFileUploadData> | null>;
    };
    messageResource: {
      get(payload: {
        params: {
          type: string;
        };
        path: {
          message_id: string;
          file_key: string;
        };
      }): Promise<FeishuResourceDownload>;
    };
    messageReaction: {
      create(payload: {
        path: {
          message_id: string;
        };
        data: {
          reaction_type: {
            emoji_type: string;
          };
        };
      }): Promise<FeishuApiResponse<FeishuReactionData>>;
      delete(payload: {
        path: {
          message_id: string;
          reaction_id: string;
        };
      }): Promise<FeishuApiResponse>;
    };
  };
  request?<T = FeishuApiResponse>(payload: {
    method: string;
    url: string;
    data?: unknown;
    params?: Record<string, unknown>;
  }): Promise<T>;
}

export interface FeishuEventDispatcher {
  register(handles: FeishuEventHandlers): unknown;
}

export interface FeishuWsConnectionStatus {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  lastConnectTime?: number;
  nextConnectTime?: number;
  reconnectAttempts: number;
}

export interface FeishuWsClient {
  start(params: { eventDispatcher: FeishuEventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): FeishuWsConnectionStatus;
}

export interface FeishuWsCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export interface FeishuTransportFactory {
  createClient(credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials): FeishuSdkClient;
  createDispatcher(credentials: FeishuCredentials): FeishuEventDispatcher;
  createWsClient(
    credentials: Required<Pick<FeishuCredentials, "appId" | "appSecret">> & FeishuCredentials,
    callbacks: FeishuWsCallbacks,
  ): FeishuWsClient;
}

export interface FeishuMessageReceiveEvent {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    sender_name?: string;
    name?: string;
    user_name?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export type FeishuEventHandlers = Record<string, (data: unknown) => Promise<unknown> | unknown>;

export interface FeishuCardActionEvent {
  app_id?: string;
  event_id?: string;
  token?: string;
  event_type?: string;
  sender?: FeishuMessageReceiveEvent["sender"];
  open_id?: string;
  user_id?: string;
  union_id?: string;
  open_message_id?: string;
  message_id?: string;
  chat_id?: string;
  open_chat_id?: string;
  action?: unknown;
  value?: unknown;
  event?: unknown;
}

export type FeishuMessageMappingResult =
  | { ok: true; message: ChannelMessage }
  | { ok: false; reason: string };

export interface FeishuMessageMappingOptions {
  channelId: string;
  accountId: string;
  botOpenId?: string;
  expectedAppId?: string;
  now?: number;
  staleMessageMs?: number;
}
