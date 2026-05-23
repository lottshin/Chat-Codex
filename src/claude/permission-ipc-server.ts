import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ClaudePermissionMcpServer, ClaudePermissionMcpToolResult } from "./permission-mcp-server.js";

export interface ClaudePermissionIpcServerOptions {
  mcp: Pick<ClaudePermissionMcpServer, "handleApprovalPrompt">;
  host?: string;
  secret?: string;
}

export interface ClaudePermissionIpcServerInfo {
  url: string;
  secret: string;
}

export class ClaudePermissionIpcServer {
  private readonly mcp: Pick<ClaudePermissionMcpServer, "handleApprovalPrompt">;
  private readonly host: string;
  private readonly secret: string;
  private server?: Server;

  constructor(options: ClaudePermissionIpcServerOptions) {
    this.mcp = options.mcp;
    this.host = options.host ?? "127.0.0.1";
    this.secret = options.secret ?? randomBytes(32).toString("hex");
  }

  async start(): Promise<ClaudePermissionIpcServerInfo> {
    if (this.server) return this.info();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, this.host, resolve);
    });
    return this.info();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private info(): ClaudePermissionIpcServerInfo {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (!address || typeof address === "string") throw new Error("Claude permission IPC server is not listening");
    return { url: `http://${this.host}:${address.port}/approval-prompt`, secret: this.secret };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/approval-prompt") {
      writeJson(response, 404, deny("未知审批 IPC 路径，已拒绝。"));
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.secret}`) {
      writeJson(response, 401, deny("审批 IPC 未授权，已拒绝。"));
      return;
    }
    try {
      const body = await readJson(request);
      writeJson(response, 200, await this.mcp.handleApprovalPrompt(body));
    } catch {
      writeJson(response, 200, deny("审批 IPC 请求无效，已拒绝。"));
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1024 * 1024) throw new Error("request too large");
  }
  return JSON.parse(body || "null") as unknown;
}

function writeJson(response: ServerResponse, statusCode: number, body: ClaudePermissionMcpToolResult): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function deny(message: string): ClaudePermissionMcpToolResult {
  return { behavior: "deny", message };
}
