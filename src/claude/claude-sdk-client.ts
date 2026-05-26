import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeSdkMessage = SDKMessage;
export type ClaudeSdkOptions = Options;
export type ClaudeSdkQuery = Query;

export interface ClaudeSdkClient {
  query(params: { prompt: string; options?: ClaudeSdkOptions }): ClaudeSdkQuery;
}

export function createClaudeSdkClient(): ClaudeSdkClient {
  return { query };
}
