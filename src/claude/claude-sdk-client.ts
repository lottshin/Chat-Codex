import { getSessionInfo, listSessions, query } from "@anthropic-ai/claude-agent-sdk";
import type { GetSessionInfoOptions, ListSessionsOptions, Options, PermissionUpdate, Query, SDKMessage, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeSdkMessage = SDKMessage;
export type ClaudeSdkOptions = Options;
export type ClaudeSdkQuery = Query;
export type ClaudeSdkSessionInfo = SDKSessionInfo;
export type ClaudeSdkPermissionUpdate = PermissionUpdate;
export type ClaudeSdkListSessionsOptions = Omit<ListSessionsOptions, "sessionStore">;
export type ClaudeSdkGetSessionInfoOptions = Omit<GetSessionInfoOptions, "sessionStore">;

export interface ClaudeSdkClient {
  query(params: { prompt: string; options?: ClaudeSdkOptions }): ClaudeSdkQuery;
  listSessions?(options?: ClaudeSdkListSessionsOptions): Promise<ClaudeSdkSessionInfo[]>;
  getSessionInfo?(sessionId: string, options?: ClaudeSdkGetSessionInfoOptions): Promise<ClaudeSdkSessionInfo | undefined>;
}

export function createClaudeSdkClient(): ClaudeSdkClient {
  return { query, listSessions, getSessionInfo };
}
