import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgeSideTasks } from "../../src/bridge/side-tasks.js";
import { UnlimitedTurnScheduler } from "../../src/bridge/turn-scheduler.js";
import { SilentLogger } from "../../src/logging/logger.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { CodexAdapter, CodexEvent, CodexSession } from "../../src/codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";

test("BridgeSideTasks rejects empty btw bodies", async () => {
  const fixture = sideTaskFixture();

  await fixture.sideTasks.start(message(), target(), "/btw");

  assert.equal(fixture.startedSessions.length, 0);
  assert.match(fixture.sent.at(-1) ?? "", /用法: `\/btw <后台任务>`/);
});

test("BridgeSideTasks starts side session with current route cwd and sends final result", async () => {
  const fixture = sideTaskFixture({ currentSessionCwd: "/repo-current" });

  await fixture.sideTasks.start(message(), target(), "/btw quick check");
  await fixture.sideTasks.waitForIdle();

  assert.equal(fixture.startedSessions.length, 1);
  assert.equal(fixture.startedSessions[0].cwd, "/repo-current");
  assert.equal(fixture.runPrompts[0], "quick check");
  assert.match(fixture.sent[0], /已启动 BTW 后台任务 `btw-1`/);
  assert.match(fixture.sent.at(-1) ?? "", /BTW 任务 btw-1 完成:\n完成: quick check/);
});

test("BridgeSideTasks uses default workdir without bound route cwd", async () => {
  const fixture = sideTaskFixture({ defaultWorkdir: "/repo-default" });

  await fixture.sideTasks.start(message(), target(), "/btw quick check");
  await fixture.sideTasks.waitForIdle();

  assert.equal(fixture.startedSessions[0].cwd, "/repo-default");
});

test("BridgeSideTasks sends failure result", async () => {
  const fixture = sideTaskFixture({ fail: true });

  await fixture.sideTasks.start(message(), target(), "/btw fail task");
  await fixture.sideTasks.waitForIdle();

  assert.match(fixture.sent.at(-1) ?? "", /BTW 任务 btw-1 失败: 模拟失败/);
});

test("BridgeSideTasks delivers progress with BTW label", async () => {
  const fixture = sideTaskFixture({ progress: true });

  await fixture.sideTasks.start(message(), target(), "/btw progress task");
  await fixture.sideTasks.waitForIdle();

  assert.ok(fixture.sent.some((text) => text.includes("BTW btw-1: 正在后台处理")));
});

function sideTaskFixture(options: {
  defaultWorkdir?: string;
  currentSessionCwd?: string;
  fail?: boolean;
  progress?: boolean;
} = {}) {
  const sent: string[] = [];
  const startedSessions: Array<{ routeKey: string; cwd: string; title?: string }> = [];
  const runPrompts: string[] = [];
  let sessionId = 0;
  const codex: CodexAdapter = {
    startSession: async (input) => {
      startedSessions.push(input);
      return { id: `side-${++sessionId}`, cwd: input.cwd, createdAt: new Date().toISOString(), title: input.title };
    },
    resumeSession: async (id) => ({ id, cwd: "/repo", createdAt: new Date().toISOString() }),
    run: async function* (id, prompt): AsyncIterable<CodexEvent> {
      const text = typeof prompt === "string" ? prompt : prompt.text ?? "";
      runPrompts.push(text);
      yield { type: "turn.started", sessionId: id, turnId: "turn-1" };
      if (options.progress) yield { type: "assistant.progress", sessionId: id, turnId: "turn-1", kind: "reasoning", text: "正在后台处理" };
      if (options.fail) {
        yield { type: "turn.failed", sessionId: id, turnId: "turn-1", error: "模拟失败" };
        return;
      }
      yield { type: "assistant.completed", sessionId: id, turnId: "turn-1", text: `完成: ${text}` };
      yield { type: "turn.completed", sessionId: id, turnId: "turn-1" };
    },
    getStatus: async () => ({ type: "idle" }),
    listSessions: async () => [],
  };
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
        return { channelId: "mock", messageId: `m-${sent.length}`, deliveredAt: new Date().toISOString() };
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  const sideTasks = new BridgeSideTasks({
    codex,
    state: new MemoryStateStore(),
    approvals: new ApprovalManager(),
    turnScheduler: new UnlimitedTurnScheduler(),
    delivery,
    defaultWorkdir: () => options.defaultWorkdir ?? "/repo-default",
    currentSessionCwd: () => options.currentSessionCwd,
    currentCollaborationMode: () => undefined,
    deliveryPolicyFor: () => DEFAULT_CHANNEL_DELIVERY_POLICY,
    shouldDeliverProgressWithPolicy: () => true,
  });
  return { sideTasks, sent, startedSessions, runPrompts };
}

function message(): ChannelMessage {
  return {
    id: "message-1",
    routeKey: "mock:default:direct:user",
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
    text: "/btw quick check",
    timestamp: new Date().toISOString(),
  };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "mock:default:direct:user",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  };
}
