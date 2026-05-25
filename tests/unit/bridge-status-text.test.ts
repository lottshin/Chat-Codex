import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeStatusText } from "../../src/bridge/status-text.js";
import type { CompactState } from "../../src/bridge/bridge-types.js";
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

test("BridgeStatusText uses root help commands in Claude profile", () => {
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

  assert.match(text, /已知 Chat-Codex 命令可直接使用根 `\/\.\.\.`/);
  assert.match(text, /旧 `\/bridge-\*` 别名仍兼容/);
  assert.match(text, /\/help/);
  assert.match(text, /\/status/);
  assert.match(text, /\/show \[status\|sessions\|files\|approvals\|plan\|whoami\|debug\]/);
  assert.match(text, /\/compact/);
  assert.match(text, /\/session/);
  assert.match(text, /\/all-sessions/);
  assert.match(text, /\/default \[任务\]/);
  assert.match(text, /\/progress \[brief\|detailed\|silent\]/);
  assert.match(text, /\/mode/);
  assert.match(text, /\/sendfile <任务内容>/);
  assert.match(text, /普通消息里的本地路径、Markdown 链接或 file:\/\/ 引用不会自动作为附件发送/);
  assert.match(text, /渠道必须支持图片\/文件发送/);
  assert.doesNotMatch(text, /\/bridge-sendfile <任务内容>/);
  assert.match(text, /`\/progress brief`/);
  assert.match(text, /\/ctx-refresh/);
  assert.match(text, /\/permissions/);
  assert.doesNotMatch(text, /\/bridge-1/);
  assert.match(text, /\/permission \[approval\|full confirm\|default\|auto\|acceptEdits\|dontAsk\|plan\|bypassPermissions confirm\]/);
  assert.match(text, /`\/permission full confirm`: 高风险完全权限/);
  assert.match(text, /`\/permission bypassPermissions confirm`: Claude Code 高风险模式/);
  assert.doesNotMatch(text, /`\/bridge-permission full confirm`/);
  assert.match(text, /\/plan-accept-edits/);
  assert.match(text, /\/plan-execute/);
  assert.match(text, /别名：`\/1`/);
  assert.doesNotMatch(text, /\/bridge-1/);
  assert.doesNotMatch(text, /根 `\/\.\.\.` 优先发给 Claude Code/);
  assert.match(text, /\*\*常用下一步\*\*/);
  assert.match(text, /发送 `\/status`/);
  assert.match(text, /发送 `\/sessions` 查看列表，或发送 `\/use` 进入编号选择/);
  assert.match(text, /`\/OK`、`\/P`、`\/NO`/);
});

test("BridgeStatusText shows common next steps in Codex profile help", () => {
  const text = new BridgeStatusText({
    commandProfile: "codex",
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

  assert.ok(text.indexOf("**常用下一步**") < text.indexOf("**完整命令**"));
  assert.match(text, /发送 `\/status`/);
  assert.match(text, /发送 `\/new`/);
  assert.match(text, /发送 `\/sessions` 查看列表，或发送 `\/use` 进入编号选择/);
  assert.match(text, /\/sendfile <任务内容>/);
  assert.match(text, /普通消息里的本地路径、Markdown 链接或 file:\/\/ 引用不会自动作为附件发送/);
  assert.match(text, /最终回复必须声明 `BRIDGE_SEND_FILE: \/absolute\/path\/to\/file`/);
  assert.match(text, /渠道必须支持图片\/文件发送/);
  assert.doesNotMatch(text, /\/bridge-sendfile/);
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
  assert.match(text, /下一步：请处理待处理计划/);
  assert.match(text, /`\/1`/);
  assert.match(text, /`\/2` 按当前权限执行/);
  assert.match(text, /\/plan-edit 或 \/2 按当前权限策略执行这个计划/);
  assert.match(text, /\/permission acceptEdits/);
  assert.doesNotMatch(text, /\/2` 修改/);
  assert.doesNotMatch(text, /切到 Claude acceptEdits 语义/);
  assert.match(text, /`\/3`/);
  assert.match(text, /`\/4`/);
});

test("BridgeStatusText shows pending plan guidance by command profile", async () => {
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

  const text = await statusText({ state, commandProfile: "claude", planWorkflow: workflow });

  assert.match(text, /\/plan-execute 或 \/1/);
  assert.match(text, /\/plan-edit 或 \/2/);
  assert.match(text, /\/permission acceptEdits/);
  assert.match(text, /\/replan <补充> 或 \/3 <补充>/);
  assert.match(text, /\/plan-cancel 或 \/4/);
  assert.doesNotMatch(text, /\/bridge-plan-execute/);
  assert.doesNotMatch(text, /\/bridge-permission acceptEdits/);
});

test("BridgeStatusText shows permission guidance by command profile", () => {
  const codexText = new BridgeStatusText({
    commandProfile: "codex",
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
  }).permissionText();
  const claudeText = new BridgeStatusText({
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
  }).permissionText();

  assert.match(codexText, /\*\*当前状态\*\*/);
  assert.match(codexText, /`\/permission approval`/);
  assert.match(codexText, /`\/permission full confirm`/);
  assert.match(codexText, /`\/permission bypassPermissions confirm`/);
  assert.match(claudeText, /`\/permission approval`/);
  assert.match(claudeText, /`\/permission full confirm`/);
  assert.match(claudeText, /`\/permission bypassPermissions confirm`/);
  assert.doesNotMatch(claudeText, /`\/bridge-permission full confirm`/);
});

test("BridgeStatusText shows progress guidance by command profile", () => {
  const codex = statusTextRenderer("codex");
  const claude = statusTextRenderer("claude");

  const codexHelp = codex.helpText(message());
  const codexProgress = codex.progressModeText(routeKey());
  const claudeProgress = claude.progressModeText(routeKey());
  const codexInvalid = codex.invalidProgressModeText("impossible");
  const claudeInvalid = claude.invalidProgressModeText("impossible");

  assert.match(codexHelp, /`brief`: 摘要模式，发送计划、推理自言自语、搜索、文件变更和其他摘要/);
  assert.match(codexHelp, /别名值：`normal`=`brief`/);
  assert.match(codexProgress, /\*\*模式说明\*\*/);
  assert.match(codexProgress, /其他摘要/);
  assert.match(codexProgress, /`\/progress detailed` 查看命令和工具细节/);
  assert.match(codexProgress, /`\/mode <模式>`/);
  assert.match(codexProgress, /`\/sendfile <任务内容>`/);
  assert.match(claudeProgress, /`\/progress detailed` 查看命令和工具细节/);
  assert.match(claudeProgress, /`\/mode <模式>`/);
  assert.match(claudeProgress, /`\/sendfile <任务内容>`/);
  assert.doesNotMatch(claudeProgress, /`\/bridge-progress detailed`/);
  assert.match(codexInvalid, /未知进度模式: `impossible`/);
  assert.match(codexInvalid, /可用值: `brief`、`detailed`、`silent`/);
  assert.match(codexInvalid, /`quiet`\/`off`\/`none`=`silent`/);
  assert.match(codexInvalid, /发送 `\/progress` 查看当前模式和示例/);
  assert.match(claudeInvalid, /发送 `\/progress` 查看当前模式和示例/);
});

test("BridgeStatusText shows compact status actions by command profile", async () => {
  const state = new MemoryStateStore();
  state.bindSession(routeKey(), {
    id: "mock-codex-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "mock chat",
  });

  const codexText = await statusText({ state, compactState: { type: "confirming", sessionId: "mock-codex-1", requestedAt: new Date().toISOString() } });
  const claudeText = await statusText({
    state,
    commandProfile: "claude",
    compactState: { type: "confirming", sessionId: "mock-codex-1", requestedAt: new Date().toISOString() },
  });
  const runningText = await statusText({ state, compactState: { type: "running", sessionId: "mock-codex-1", startedAt: new Date().toISOString() } });

  assert.match(codexText, /发送 `\/compact confirm` 开始/);
  assert.match(codexText, /确认要压缩请发送确认命令/);
  assert.match(claudeText, /发送 `\/compact confirm` 开始/);
  assert.doesNotMatch(claudeText, /发送 `\/bridge-compact confirm` 开始/);
  assert.match(runningText, /上下文压缩: 进行中/);
  assert.match(runningText, /当前不支持中途取消 `\/compact`/);
  assert.match(runningText, /可发送 `\/status` 刷新查看/);
});

test("BridgeStatusText shows show command context summary", async () => {
  const state = new MemoryStateStore();
  state.bindSession(routeKey(), {
    id: "mock-codex-1",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    title: "mock chat",
  });
  const text = await new BridgeStatusText({
    commandProfile: "codex",
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
  }).showText(message());

  assert.match(text, /\*\*Codex 上下文\*\*/);
  assert.match(text, /Route: `mock:default:direct:user`/);
  assert.match(text, /当前会话: `mock-codex-1`/);
  assert.match(text, /工作目录: `\/tmp\/project`/);
  assert.match(text, /待处理附件: `0`/);
  assert.match(text, /子命令：`\/show status`、`\/show sessions`、`\/show files`/);
});

test("BridgeStatusText shows show files guidance", async () => {
  const text = await new BridgeStatusText({
    commandProfile: "codex",
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
    pendingMediaCount: () => 2,
    compactStateForRoute: () => ({ type: "none" }),
    collaborationModeForRoute: () => "default",
    progressModeFor: () => "brief",
    contextRefreshFor: () => ({ policy: { mode: "off" }, source: "route" }),
    runPolicyStatus: () => undefined,
    planWorkflowForRoute: () => undefined,
  }).showText(message(), ["files"]);

  assert.match(text, /\*\*文件上下文\*\*/);
  assert.match(text, /待处理附件: `2`/);
  assert.match(text, /发送普通消息会把待处理附件带入本轮/);
  assert.match(text, /发送 `\/cancel` 可取消待发送附件/);
});

async function statusText(options: {
  state?: MemoryStateStore;
  approvals?: ApprovalManager;
  status?: CodexSessionStatus;
  planWorkflow?: PendingPlanWorkflow;
  busy?: boolean;
  commandProfile?: "codex" | "claude";
  compactState?: CompactState;
} = {}): Promise<string> {
  return new BridgeStatusText({
    commandProfile: options.commandProfile ?? "codex",
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
    compactStateForRoute: () => options.compactState ?? ({ type: "none" }),
    collaborationModeForRoute: () => "default",
    progressModeFor: () => "brief",
    contextRefreshFor: () => ({ policy: { mode: "off" }, source: "route" }),
    runPolicyStatus: () => undefined,
    planWorkflowForRoute: () => options.planWorkflow,
  }).statusText(message());
}

function statusTextRenderer(commandProfile: "codex" | "claude" = "codex"): BridgeStatusText {
  return new BridgeStatusText({
    backend: commandProfile === "claude" ? "claude" : undefined,
    commandProfile,
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
  });
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
