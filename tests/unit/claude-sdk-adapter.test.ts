import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSdkAdapter } from "../../src/claude/claude-sdk-adapter.js";
import type { ClaudeSdkClient, ClaudeSdkOptions, ClaudeSdkPermissionUpdate, ClaudeSdkQuery, ClaudeSdkSessionInfo } from "../../src/claude/claude-sdk-client.js";

class FakeClaudeSdkClient implements ClaudeSdkClient {
  readonly calls: Array<{ prompt: string; options?: ClaudeSdkOptions }> = [];
  readonly listSessionCalls: unknown[] = [];
  messages: unknown[] = [];
  sessions: ClaudeSdkSessionInfo[] = [];
  error?: Error;
  listSessionsError?: Error;
  queryRef?: FakeClaudeSdkQuery;

  query(params: { prompt: string; options?: ClaudeSdkOptions }): ClaudeSdkQuery {
    this.calls.push(params);
    const query = new FakeClaudeSdkQuery(this.messages, this.error, params.options);
    this.queryRef = query;
    return query as unknown as ClaudeSdkQuery;
  }

  async listSessions(options?: unknown): Promise<ClaudeSdkSessionInfo[]> {
    this.listSessionCalls.push(options);
    if (this.listSessionsError) throw this.listSessionsError;
    return this.sessions;
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
        suggestions: value.suggestions,
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
    { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: ["/help"], skills: ["scholar-kit", { name: "frontend-design" }] },
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
  assert.deepEqual(adapter.listPromptSkills(), ["frontend-design", "scholar-kit"]);
  assert.deepEqual(adapter.listPromptSlashCommands(), ["frontend-design", "help", "scholar-kit"]);
});

test("ClaudeSdkAdapter suppresses empty Claude task lifecycle system progress", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [
    { type: "system", subtype: "task_started", session_id: "sdk-session-1" },
    { type: "system", subtype: "task_notification", session_id: "sdk-session-1" },
    { type: "result", subtype: "success", session_id: "sdk-session-1", result: "done" },
  ];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const events = await collect(adapter.run(session.id, "hi"));

  assert.equal(events.some((event) => event.type === "assistant.progress" && /task_/.test(event.text)), false);
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "done"));
});

test("ClaudeSdkAdapter reports Claude API retry system progress", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [
    { type: "system", subtype: "api_retry", session_id: "sdk-session-1" },
    { type: "result", subtype: "success", session_id: "sdk-session-1", result: "done" },
  ];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const events = await collect(adapter.run(session.id, "hi"));

  assert.ok(events.some((event) => event.type === "assistant.progress" && event.text === "Claude API 正在重试请求"));
});

test("ClaudeSdkAdapter maps ExitPlanMode tool use to plan events", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [
    { type: "assistant", session_id: "sdk-session-1", message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "# Plan\n\n1. Do it" } }] } },
    { type: "result", subtype: "success", session_id: "sdk-session-1", result: "Plan ready for review." },
  ];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const events = await collect(adapter.run(session.id, "make a plan", { collaborationMode: "plan" }));

  assert.ok(events.some((event) => event.type === "assistant.plan" && event.text === "# Plan\n\n1. Do it"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "Plan ready for review."));
});

test("ClaudeSdkAdapter uses captured backend session id for later turns", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "system", subtype: "init", session_id: "actual-session" }];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  await collect(adapter.run(session.id, "first"));
  client.messages = [{ type: "result", subtype: "success", session_id: "actual-session", result: "ok" }];
  await collect(adapter.run(session.id, "second"));

  assert.equal(client.calls[0]?.options?.resume, undefined);
  assert.equal(client.calls[1]?.options?.resume, "actual-session");
  assert.equal((await adapter.listSessions())[0]?.id, session.id);
  assert.equal((await adapter.listSessions())[0]?.backendSessionId, "actual-session");
});

test("ClaudeSdkAdapter captures backend session id from result without init", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "result", subtype: "success", session_id: "result-session", result: "ok" }];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  await collect(adapter.run(session.id, "hi"));

  assert.equal((await adapter.listSessions())[0]?.backendSessionId, "result-session");
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

test("ClaudeSdkAdapter resumes bridge-local records with native Claude session hints", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "result", subtype: "success", session_id: "native-session", result: "ok" }];
  const adapter = new ClaudeSdkAdapter({ client });

  const session = await adapter.resumeSession("bridge-local-1", {
    backendSessionId: "native-session",
    cwd: "D:/repo/bridge",
    title: "Persisted task",
    createdAt: "2026-05-29T00:00:00.000Z",
  });
  await collect(adapter.run("bridge-local-1", "hi"));

  assert.equal(session.id, "bridge-local-1");
  assert.equal(session.backendSessionId, "native-session");
  assert.equal(session.cwd, "D:/repo/bridge");
  assert.equal(session.title, "Persisted task");
  assert.equal(session.createdAt, "2026-05-29T00:00:00.000Z");
  assert.equal(client.calls[0]?.options?.resume, "native-session");
});

test("ClaudeSdkAdapter lists SDK-discovered sessions", async () => {
  const client = new FakeClaudeSdkClient();
  client.sessions = [sdkSession("sdk-session-1", { summary: "Discovered task", cwd: "/repo/sdk", lastModified: Date.UTC(2026, 0, 2) })];
  const adapter = new ClaudeSdkAdapter({ client });

  const sessions = await adapter.listSessions();

  assert.equal(client.listSessionCalls.length, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "sdk-session-1");
  assert.equal(sessions[0]?.backend, "claude");
  assert.equal(sessions[0]?.backendSessionId, "sdk-session-1");
  assert.equal(sessions[0]?.title, "Discovered task");
  assert.equal(sessions[0]?.cwd, "/repo/sdk");
  assert.equal(sessions[0]?.updatedAt, new Date(Date.UTC(2026, 0, 2)).toISOString());
});

test("ClaudeSdkAdapter keeps local sessions and deduplicates discovered backend ids", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "system", subtype: "init", session_id: "actual-session" }];
  client.sessions = [
    sdkSession("actual-session", { summary: "Duplicate discovered" }),
    sdkSession("other-session", { summary: "Other discovered" }),
  ];
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd(), title: "Local task" });
  await collect(adapter.run(session.id, "hi"));

  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.id, session.id);
  assert.equal(sessions[0]?.backendSessionId, "actual-session");
  assert.equal(sessions[1]?.id, "other-session");
  assert.equal(sessions[1]?.backendSessionId, "other-session");
});

test("ClaudeSdkAdapter returns local sessions when SDK discovery fails", async () => {
  const client = new FakeClaudeSdkClient();
  client.listSessionsError = new Error("discovery failed");
  const adapter = new ClaudeSdkAdapter({ client });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd(), title: "Local task" });

  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, session.id);
  assert.equal(sessions[0]?.title, "Local task");
});

test("ClaudeSdkAdapter does not query SDK discovery for route-filtered lists", async () => {
  const client = new FakeClaudeSdkClient();
  client.sessions = [sdkSession("sdk-session-1")];
  const adapter = new ClaudeSdkAdapter({ client });
  await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });

  const sessions = await adapter.listSessions("route-1");

  assert.equal(client.listSessionCalls.length, 0);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.routeKey, "route-1");
});

test("ClaudeSdkAdapter resumes SDK-discovered sessions by backend id", async () => {
  const client = new FakeClaudeSdkClient();
  client.messages = [{ type: "result", subtype: "success", session_id: "discovered-session", result: "ok" }];
  const adapter = new ClaudeSdkAdapter({ client });
  await adapter.resumeSession("discovered-session");

  await collect(adapter.run("discovered-session", "hi"));

  assert.equal(client.calls[0]?.options?.resume, "discovered-session");
  assert.equal((await adapter.listSessions()).find((session) => session.id === "discovered-session")?.backendSessionId, "discovered-session");
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
  result: { behavior: "allow"; updatedPermissions?: ClaudeSdkPermissionUpdate[] } | { behavior: "deny"; message: string };
  requestPermission(payload: unknown): Promise<{ behavior: "allow"; updatedPermissions?: ClaudeSdkPermissionUpdate[] } | { behavior: "deny"; message: string }>;
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
  assert.deepEqual(client.queryRef?.canUseToolResults[0], { behavior: "allow", updatedInput: { file_path: "package.json" } });
});

test("ClaudeSdkAdapter forwards rich SDK canUseTool metadata for approval probes", async () => {
  const client = new FakeClaudeSdkClient();
  const updatedPermissions: ClaudeSdkPermissionUpdate[] = [
    { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Read", ruleContent: "package.json" }] },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ];
  const approvalService = fakeApprovalService({ behavior: "allow", updatedPermissions });
  client.messages = [
    {
      type: "canUseTool",
      toolName: "Read",
      input: { file_path: "package.json" },
      toolUseID: "tool-1",
      title: "Read file?",
      displayName: "Read",
      description: "Read package metadata",
      blockedPath: "package.json",
      decisionReason: "requires permission",
      suggestions: updatedPermissions,
    },
    { type: "result", subtype: "success", session_id: "sdk-session", result: "ok" },
  ];
  const adapter = new ClaudeSdkAdapter({ client, approvalService: approvalService as never });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  const registration = adapter.registerRunApprovalContext({ routeKey: "route-1", requestedBy: "user-1", target: target(), sessionId: session.id, turnId: "turn", cwd: process.cwd() });

  await collect(adapter.run(session.id, "hi"));

  registration.dispose();
  assert.deepEqual(approvalService.requests[0], {
    tool_name: "Read",
    toolName: "Read",
    input: { file_path: "package.json" },
    tool_input: { file_path: "package.json" },
    tool_use_id: "tool-1",
    toolUseId: "tool-1",
    title: "Read file?",
    displayName: "Read",
    description: "Read package metadata",
    blockedPath: "package.json",
    decisionReason: "requires permission",
    suggestions: updatedPermissions,
  });
  assert.deepEqual(client.queryRef?.canUseToolResults[0], { behavior: "allow", updatedInput: { file_path: "package.json" }, updatedPermissions });
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

test("ClaudeSdkAdapter omits approval bridge in plan mode unless probe is enabled", async () => {
  const client = new FakeClaudeSdkClient();
  const approvalService = fakeApprovalService({ behavior: "allow" });
  client.messages = [{ type: "result", subtype: "success", session_id: "sdk-session", result: "ok" }];
  const adapter = new ClaudeSdkAdapter({ client, approvalService: approvalService as never });
  const session = await adapter.startSession({ routeKey: "route-1", cwd: process.cwd() });
  adapter.setCollaborationMode("plan", session.id);

  await collect(adapter.run(session.id, "hi"));

  assert.equal(client.calls[0]?.options?.permissionMode, "plan");
  assert.equal(client.calls[0]?.options?.canUseTool, undefined);
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

function sdkSession(sessionId: string, overrides: Partial<ClaudeSdkSessionInfo> = {}): ClaudeSdkSessionInfo {
  return {
    sessionId,
    summary: "SDK task",
    lastModified: Date.UTC(2026, 0, 1),
    ...overrides,
  };
}

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
  suggestions?: ClaudeSdkPermissionUpdate[];
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
