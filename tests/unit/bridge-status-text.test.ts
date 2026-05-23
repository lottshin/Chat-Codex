import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeStatusText } from "../../src/bridge/status-text.js";
import type { PendingPlanWorkflow } from "../../src/bridge/plan-workflow.js";
import type { CodexAdapter, CodexSessionStatus, CodexSessionSummary } from "../../src/codex/types.js";
import { ChannelRegistry } from "../../src/channels/registry.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelAdapter, ChannelMessage } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";

test("BridgeStatusText shows Claude backend session id in status", async () => {
  const state = new MemoryStateStore();
  const session = {
    id: "claude-local-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "claude chat",
    backend: "claude" as const,
    backendSessionId: "claude-actual-123",
  };
  state.bindSession(routeKey(), session);

  const text = await new BridgeStatusText({
    backend: "claude",
    commandProfile: "claude",
    channels: fakeChannels(),
    codex: fakeCodex({ type: "idle" }),
    state,
    approvals: new ApprovalManager(),
    routeQueueLength: () => 0,
    deliveryPolicyFor: () => DEFAULT_CHANNEL_DELIVERY_POLICY,
    shouldConsumePendingInitialRouteBinding: () => false,
    pendingInitialRouteBinding: () => undefined,
    isRouteBusy: () => false,
    routeSteerPendingCount: () => 0,
    pendingMediaCount: () => 0,
    compactStateForRoute: () => ({ type: "none" }),
    collaborationModeForRoute: () => "default",
    progressModeFor: () => "brief",
    contextRefreshFor: () => ({ policy: { mode: "off" }, source: "route" }),
    runPolicyStatus: () => undefined,
    planWorkflowForRoute: () => undefined,
  }).statusText(message());

  assert.match(text, /当前会话: `claude-local-1`/);
  assert.match(text, /后端: `claude`/);
  assert.match(text, /Claude session: `claude-actual-123`/);
});

test("BridgeStatusText uses /bridge-* help commands in Claude profile", () => {
  const text = new BridgeStatusText({
    backend: "claude",
    commandProfile: "claude",
    channels: fakeChannels(),
    codex: fakeCodex({ type: "idle" }),
    state: new MemoryStateStore(),
    approvals: new ApprovalManager(),
    routeQueueLength: () => 0,
    deliveryPolicyFor: () => DEFAULT_CHANNEL_DELIVERY_POLICY,
    shouldConsumePendingInitialRouteBinding: () => false,
    pendingInitialRouteBinding: () => undefined,
    isRouteBusy: () => false,
    routeSteerPendingCount: () => 0,
    pendingMediaCount: () => 0,
    compactStateForRoute: () => ({ type: "none" }),
    collaborationModeForRoute: () => "default",
    progressModeFor: () => "brief",
    contextRefreshFor: () => ({ policy: { mode: "off" }, source: "route" }),
    runPolicyStatus: () => undefined,
    planWorkflowForRoute: () => undefined,
  }).helpText(message());

  assert.match(text, /\/bridge-help/);
  assert.match(text, /\/bridge-status/);
  assert.match(text, /\/bridge-compact/);
  assert.match(text, /\/bridge-session/);
  assert.match(text, /\/bridge-all-sessions/);
  assert.match(text, /\/bridge-default \[任务\]/);
  assert.match(text, /\/bridge-mode/);
  assert.match(text, /\/bridge-ctx-refresh/);
  assert.match(text, /\/bridge-permissions/);
  assert.match(text, /\/bridge-plan-accept-edits/);
  assert.match(text, /根 `\/\.\.\.` 优先发给 Claude Code/);
});

test("BridgeStatusText shows backend labels in sessions list", async () => {
  const state = new MemoryStateStore();
  state.bindSession(routeKey(), {
    id: "claude-local-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "claude chat",
    backend: "claude",
    backendSessionId: "claude-actual-123",
  });

  const text = await new BridgeStatusText({
    backend: "claude",
    commandProfile: "claude",
    channels: fakeChannels(),
    codex: fakeCodex({ type: "idle" }, [{
      id: "claude-local-1",
      cwd: "/tmp/project",
      title: "claude chat",
      status: { type: "idle" },
      updatedAt: new Date().toISOString(),
      backend: "claude",
      backendSessionId: "claude-actual-123",
    }]),
    state,
    approvals: new ApprovalManager(),
    routeQueueLength: () => 0,
    deliveryPolicyFor: () => DEFAULT_CHANNEL_DELIVERY_POLICY,
    shouldConsumePendingInitialRouteBinding: () => false,
    pendingInitialRouteBinding: () => undefined,
    isRouteBusy: () => false,
    routeSteerPendingCount: () => 0,
    pendingMediaCount: () => 0,
    compactStateForRoute: () => ({ type: "none" }),
    collaborationModeForRoute: () => "default",
    progressModeFor: () => "brief",
    contextRefreshFor: () => ({ policy: { mode: "off" }, source: "route" }),
    runPolicyStatus: () => undefined,
    planWorkflowForRoute: () => undefined,
  }).sessionsText(message(), [], "sessions");

  assert.match(text, /Session: `claude-local-1`/);
  assert.match(text, /后端: `claude`/);
  assert.match(text, /Claude session: `claude-actual-123`/);
  assert.match(text, /下一步：发送 `\/use` 进入编号选择/);
  assert.match(text, /`\/use <session>`/);
});

test("BridgeStatusText shows actionable next step for idle bound sessions", async () => {
  const state = new MemoryStateStore();
  state.bindSession(routeKey(), {
    id: "mock-codex-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "mock chat",
  });

  const text = await statusText({ state });

  assert.match(text, /下一步：发送普通消息继续任务/);
  assert.match(text, /`\/help`/);
});

test("BridgeStatusText shows actionable next step for unbound sessions", async () => {
  const text = await statusText();

  assert.match(text, /下一步：发送普通消息创建或绑定会话/);
  assert.match(text, /`\/new`/);
  assert.match(text, /`\/resume`/);
});

test("BridgeStatusText shows actionable next step for pending approvals", async () => {
  const state = new MemoryStateStore();
  state.bindSession(routeKey(), {
    id: "mock-codex-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "mock chat",
  });
  const approvals = new ApprovalManager();
  approvals.create(routeKey(), "user", {
    kind: "command",
    sessionId: "mock-codex-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: "echo ok",
  });

  const text = await statusText({ state, approvals });

  assert.match(text, /\*\*待处理审批\*\*/);
  assert.match(text, /下一步：请处理待审批项/);
  assert.match(text, /`\/OK`/);
  assert.match(text, /`\/P`/);
  assert.match(text, /`\/NO`/);
});

test("BridgeStatusText shows actionable next step for pending plan workflows", async () => {
  const state = new MemoryStateStore();
  state.bindSession(routeKey(), {
    id: "mock-codex-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "mock chat",
  });
  const workflow: PendingPlanWorkflow = {
    routeKey: routeKey(),
    message: message(),
    target: {
      channelId: "mock",
      routeKey: routeKey(),
      conversation: { id: "user", kind: "direct" },
      recipient: { id: "user" },
    },
    originalPrompt: "实现功能",
    planText: "计划内容",
    sessionId: "mock-codex-1",
    createdAt: new Date().toISOString(),
  };

  const text = await statusText({ state, planWorkflow: workflow });

  assert.match(text, /\*\*待处理计划\*\*/);
  assert.match(text, /下一步：请处理待计划项/);
  assert.match(text, /`\/1`/);
  assert.match(text, /`\/2`/);
  assert.match(text, /`\/3`/);
  assert.match(text, /`\/4`/);
});

async function statusText(options: {
  state?: MemoryStateStore;
  approvals?: ApprovalManager;
  status?: CodexSessionStatus;
  planWorkflow?: PendingPlanWorkflow;
  busy?: boolean;
} = {}): Promise<string> {
  return new BridgeStatusText({
    commandProfile: "codex",
    channels: fakeChannels(),
    codex: fakeCodex(options.status ?? { type: "idle" }),
    state: options.state ?? new MemoryStateStore(),
    approvals: options.approvals ?? new ApprovalManager(),
    routeQueueLength: () => 0,
    deliveryPolicyFor: () => DEFAULT_CHANNEL_DELIVERY_POLICY,
    shouldConsumePendingInitialRouteBinding: () => false,
    pendingInitialRouteBinding: () => undefined,
    isRouteBusy: () => options.busy ?? false,
    routeSteerPendingCount: () => 0,
    pendingMediaCount: () => 0,
    compactStateForRoute: () => ({ type: "none" }),
    collaborationModeForRoute: () => "default",
    progressModeFor: () => "brief",
    contextRefreshFor: () => ({ policy: { mode: "off" }, source: "route" }),
    runPolicyStatus: () => undefined,
    planWorkflowForRoute: () => options.planWorkflow,
  }).statusText(message());
}

function fakeChannels(): ChannelRegistry {
  return new ChannelRegistry({
    channels: [{
      id: "mock",
      name: "mock",
      kind: "mock",
      start: async () => undefined,
      stop: async () => undefined,
      onMessage: () => undefined,
      getStatus: async () => ({ channelId: "mock", state: "connected" as const }),
      getCapabilities: () => ({ supportsText: true }),
      sendText: async () => ({ channelId: "mock", messageId: "m1", deliveredAt: new Date().toISOString() }),
      sendTyping: async () => undefined,
    }] as unknown as ChannelAdapter[],
    logger: new SilentLogger(),
  });
}

function fakeCodex(status: CodexSessionStatus, sessions: CodexSessionSummary[] = []): CodexAdapter {
  return {
    startSession: async () => ({ id: "unused", cwd: "/tmp/project", createdAt: new Date().toISOString() }),
    resumeSession: async () => ({ id: "unused", cwd: "/tmp/project", createdAt: new Date().toISOString() }),
    run: async function* () { return; },
    getStatus: async () => status,
    listSessions: async () => sessions,
  };
}

function routeKey(): string {
  return "mock:default:direct:user";
}

function message(): ChannelMessage {
  return {
    id: "message-1",
    routeKey: routeKey(),
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
    text: "",
    timestamp: new Date().toISOString(),
  };
}
