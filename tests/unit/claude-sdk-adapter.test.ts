import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSdkAdapter } from "../../src/claude/claude-sdk-adapter.js";
import type { ClaudeSdkClient, ClaudeSdkOptions, ClaudeSdkQuery } from "../../src/claude/claude-sdk-client.js";

class FakeClaudeSdkClient implements ClaudeSdkClient {
  readonly calls: Array<{ prompt: string; options?: ClaudeSdkOptions }> = [];
  messages: unknown[] = [];
  error?: Error;
  queryRef?: FakeClaudeSdkQuery;

  query(params: { prompt: string; options?: ClaudeSdkOptions }): ClaudeSdkQuery {
    this.calls.push(params);
    const query = new FakeClaudeSdkQuery(this.messages, this.error, params.options);
    this.queryRef = query;
    return query as unknown as ClaudeSdkQuery;
  }
}

class FakeClaudeSdkQuery implements AsyncGenerator<unknown, void> {
  closed = false;

  readonly canUseToolResults: unknown[] = [];

  constructor(private readonly messages: unknown[], private readonly error?: Error, private readonly options?: ClaudeSdkOptions) {}

  async next(): Promise<IteratorResult<unknown, void>> {
    if (this.closed) return { done: true, value: undefined };
    if (this.error) throw this.error;
    const value = this.messages.shift();
    if (!value) return { done: true, value: undefined };
    if (isCanUseToolProbe(value)) {
      const result = await this.options?.canUseTool?.(value.toolName, value.input, {
        signal: value.signal ?? new AbortController().signal,
        toolUseID: value.toolUseID,
        title: value.title,
        displayName: value.displayName,
        description: value.description,
        blockedPath: value.blockedPath,
        decisionReason: value.decisionReason,
      });
      this.canUseToolResults.push(result);
      return { done: false, value: { type: "can_use_tool_result", result } };
    }
    return { done: false, value };
  }

  async return(): Promise<IteratorResult<unknown, void>> {
    this.closed = true;
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<unknown, void>> {
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<unknown, void> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  async initializationResult(): Promise<never> { throw new Error("not implemented"); }
  async supportedCommands(): Promise<never> { throw new Error("not implemented"); }
  async supportedModels(): Promise<never> { throw new Error("not implemented"); }
  async supportedAgents(): Promise<never> { throw new Error("not implemented"); }
  async mcpServerStatus(): Promise<never> { throw new Error("not implemented"); }
  async getContextUsage(): Promise<never> { throw new Error("not implemented"); }
  async readFile(): Promise<null> { return null; }
  async reloadPlugins(): Promise<never> { throw new Error("not implemented"); }
  async accountInfo(): Promise<never> { throw new Error("not implemented"); }
  async rewindFiles(): Promise<never> { throw new Error("not implemented"); }
  async seedReadState(): Promise<void> {}
  async reconnectMcpServer(): Promise<void> {}
  async toggleMcpServer(): Promise<void> {}
  async setMcpServers(): Promise<never> { throw new Error("not implemented"); }
  async streamInput(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async backgroundTasks(): Promise<boolean> { return false; }
  close(): void { this.closed = true; }
}

test("ClaudeSdkAdapter starts Claude sessions", async () => {
  const adapter = new ClaudeSdkAdapter({ client: new FakeClaudeSdkClient() });

  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd(), title: "SDK" });

  assert.equal(session.backend, "claude");
  assert.equal(session.cwd, process.cwd());
  assert.equal(session.title, "SDK");
  assert.match(session.id, /^claude-sdk-local-/);
});

test("ClaudeSdkAdapter maps SDK messages to Codex events and captures session id", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [
    { type: "system", subtype: "init", session_id: "sdk-session-1" },
    { type: "assistant", session_id: "sdk-session-1", message: { content: [{ type: "text", text: "hello" }] } },
    { type: "result", subtype: "success", session_id: "sdk-session-1", result: "hello done" },
  ];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const events = await collect(adapter.run(session.id, "hi"));

  assert.equal(events[0]?.type, "turn.started");
  assert.ok(events.some((event) => event.type === "assistant.delta" && event.text === "hello"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "hello done"));
  assert.equal(events.at(-1)?.type, "turn.completed");
  assert.equal((await adapter.listSessions())[0]?.backendSessionId, "sdk-session-1");
});

test("ClaudeSdkAdapter passes resume, model, effort, and permission options", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "result", subtype: "success", session_id: "actual-session", result: "ok" }];
  const adapter = new ClaudeSdkAdapter({ client });
  await adapter.resumeSession("actual-session");
  adapter.setModelPolicy({ model: "sonnet", claudeEffort: "max" }, "actual-session");
  adapter.setCollaborationMode("plan", "actual-session");

  await collect(adapter.run("actual-session", "hi"));

  assert.equal(client.calls[0]?.options?.resume, "actual-session");
  assert.equal(client.calls[0]?.options?.model, "sonnet");
  assert.equal(client.calls[0]?.options?.effort, "max");
  assert.equal(client.calls[0]?.options?.permissionMode, "plan");
});

test("ClaudeSdkAdapter maps SDK errors to failed turns", async () => {
  const client = new FakeClaudeSdkClient();
  client.error = new Error("boom");
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const events = await collect(adapter.run(session.id, "hi"));

  const failed = events.at(-1);
  assert.equal(failed?.type, "turn.failed");
  assert.match(failed?.type === "turn.failed" ? failed.error : "", /boom/);
  assert.deepEqual(await adapter.getStatus(session.id), { type: "failed", error: "boom" });
});

test("ClaudeSdkAdapter cancels active runs and returns idle status", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "assistant", session_id: "sdk-session-1", message: { content: [{ type: "text", text: "chunk" }] } }];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  const iterator = adapter.run(session.id, "hi")[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.type, "turn.started");
  assert.equal((await iterator.next()).value.type, "assistant.delta");
  await adapter.cancel(session.id);
  const next = await iterator.next();

  assert.equal(client.queryRef?.closed, true);
  assert.deepEqual(await adapter.getStatus(session.id), { type: "idle" });
  assert.equal(next.value.type, "turn.completed");
});

test("ClaudeSdkAdapter filters listed sessions by route", async () => {
  const adapter = new ClaudeSdkAdapter({ client: new FakeClaudeSdkClient() });
  await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  await adapter.startSession({ routeKey: "route-2", cwd: process.cwd() });

  const sessions = await adapter.listSessions("route-1");

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.routeKey, "route-1");
});

interface FakeApprovalService {
  requests: unknown[];
  result: { behavior: "allow" } | { behavior: "deny"; message: string };
  requestPermission(payload: unknown): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
}

function fakeApprovalService(result: FakeApprovalService["result"]): FakeApprovalService {
  return {
    requests: [],
    result,
    async requestPermission(payload: unknown) {
      this.requests.push(payload);
      return this.result;
    },
  };
}

test("ClaudeSdkAdapter maps SDK canUseTool allow decisions", async () => {
  const client = new FakeClaudeSdkClient();
  const approvalService = fakeApprovalService({ behavior: "allow" });
  client.messages = [
    { type: "canUseTool", toolName: "Read", input: { file_path: "package.json" }, toolUseID: "tool-1" },
    { type: "result", subtype: "success", session_id: "sdk-session", result: "ok" },
  ];
  const adapter = new ClaudeSdkAdapter({ client, approvalService: approvalService as never });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  const registration = adapter.registerRunApprovalContext({ routeKey: "route-1", requestedBy: "user-1", target: target(), sessionId: session.id, turnId: "turn", cwd: process.cwd() });

  await collect(adapter.run(session.id, "hi"));

  registration.dispose();
  assert.equal(approvalService.requests.length, 1);
  assert.deepEqual(client.queryRef?.canUseToolResults[0], { behavior: "allow", toolUseID: "tool-1" });
});

test("ClaudeSdkAdapter maps SDK canUseTool deny decisions", async () => {
  const client = new FakeClaudeSdkClient();
  const approvalService = fakeApprovalService({ behavior: "deny", message: "no" });
  client.messages = [
    { type: "canUseTool", toolName: "Read", input: { file_path: "package.json" }, toolUseID: "tool-1" },
  ];
  const adapter = new ClaudeSdkAdapter({ client, approvalService: approvalService as never });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  const registration = adapter.registerRunApprovalContext({ routeKey: "route-1", requestedBy: "user-1", target: target(), sessionId: session.id, turnId: "turn", cwd: process.cwd() });

  await collect(adapter.run(session.id, "hi"));

  registration.dispose();
  assert.equal(approvalService.requests.length, 1);
  assert.deepEqual(client.queryRef?.canUseToolResults[0], { behavior: "deny", message: "no", interrupt: true, toolUseID: "tool-1" });
});

test("ClaudeSdkAdapter reports interactive approvals when approval service is configured", () => {
  const adapter = new ClaudeSdkAdapter({ client: new FakeClaudeSdkClient(), approvalService: fakeApprovalService({ behavior: "allow" }) as never });

  const status = adapter.getRunPolicyStatus();

  assert.equal(status.interactiveApprovals, true);
  assert.equal(status.effectiveApprovalPolicy, "on-request");
});

test("ClaudeSdkAdapter omits approval bridge in full permission mode", async () => {
  const client = new FakeClaudeSdkClient();
  const approvalService = fakeApprovalService({ behavior: "allow" });
  client.messages = [{ type: "result", subtype: "success", session_id: "sdk-session", result: "ok" }];
  const adapter = new ClaudeSdkAdapter({ client, approvalService: approvalService as never });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  adapter.setRunPolicy({ permissionMode: "full" }, session.id);

  await collect(adapter.run(session.id, "hi"));

  assert.equal(client.calls[0]?.options?.canUseTool, undefined);
  assert.equal(approvalService.requests.length, 0);
});

function isCanUseToolProbe(value: unknown): value is {
  type: "canUseTool";
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  signal?: AbortSignal;
} {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "canUseTool");
}

function target() {
  return {
    channelId: "mock",
    routeKey: "route-1",
    conversation: { id: "conv", kind: "direct" as const },
    recipient: { id: "user-1" },
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
