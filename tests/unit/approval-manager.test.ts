import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";

test("ApprovalManager creates and resolves approvals", () => {
  const manager = new ApprovalManager();
  const pending = manager.create("mock:default:direct:user", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    command: "echo ok",
  });

  const text = manager.formatForChannel(pending);

  assert.equal(pending.status, "pending");
  assert.equal(pending.expiresAt, undefined);
  assert.match(text, /类型: 命令执行/);
  assert.match(text, /\*\*请选择处理方式\*\*/);
  assert.match(text, /`\/OK` 或 `\/1`：通过当前审批/);
  assert.match(text, /`\/P` 或 `\/2`：本会话通过/);
  assert.match(text, /`\/NO` 或 `\/3`：拒绝当前审批/);
  assert.match(text, /下一步：直接回复上面任一命令；不确定时发送 \/status 查看当前待处理审批。/);
  assert.doesNotMatch(text, new RegExp(pending.approvalKey));
  assert.doesNotMatch(text, /\/approve/);
  assert.equal(manager.latest(pending.routeKey)?.approvalKey, pending.approvalKey);

  const resolved = manager.decide(pending.approvalKey, pending.routeKey, "approve");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision, "approve");
});

test("ApprovalManager renders dynamic approval choices", () => {
  const manager = new ApprovalManager();
  const pending = manager.create("mock:default:direct:user", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    command: "echo ok",
    availableDecisions: ["approve", "deny"],
  });

  const text = manager.formatForChannel(pending);

  assert.match(text, /`\/OK` 或 `\/1`：通过当前审批/);
  assert.match(text, /`\/NO` 或 `\/2`：拒绝当前审批/);
  assert.doesNotMatch(text, /\/P/);
  assert.doesNotMatch(text, /\/3/);
});

test("ApprovalManager only expires approvals when ttl is configured", () => {
  const manager = new ApprovalManager({ ttlMs: -1 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  assert.equal(manager.latest("route-a"), undefined);
  assert.equal(manager.get(pending.approvalKey)?.status, "expired");
});

test("ApprovalManager latest returns the newest pending approval for a route", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  const second = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i2",
  });
  manager.create("route-b", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i3",
  });

  assert.notEqual(first.approvalKey, second.approvalKey);
  assert.equal(manager.latest("route-a")?.approvalKey, second.approvalKey);
});

test("ApprovalManager rejects wrong route decisions", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  assert.throws(() => manager.decide(pending.approvalKey, "route-b", "deny"), /不属于当前会话/);
  assert.throws(() => manager.decide(pending.approvalKey, "route-b", "deny"), /\/OK、\/NO 或数字选项/);
});

test("ApprovalManager cancels pending approvals for a route", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  manager.create("route-b", "user", {
    kind: "command",
    sessionId: "s2",
    turnId: "t2",
    itemId: "i2",
  });

  const cancelled = manager.cancelRoute("route-a", "任务已停止");

  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].approvalKey, first.approvalKey);
  assert.equal(cancelled[0].decision, "cancel");
  assert.equal(cancelled[0].decisionReason, "任务已停止");
  assert.equal(manager.list("route-a").length, 0);
  assert.equal(manager.list("route-b").length, 1);
});

test("ApprovalManager waitForDecision resolves when approval is decided", async () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  const wait = manager.waitForDecision(pending.approvalKey);
  manager.decide(pending.approvalKey, "route-a", "approve-session");
  const resolved = await wait;

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision, "approve-session");
});

test("ApprovalManager waitForDecision resolves when route approvals are cancelled", async () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  const wait = manager.waitForDecision(pending.approvalKey);
  manager.cancelRoute("route-a", "任务已停止");
  const resolved = await wait;

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision, "cancel");
  assert.equal(resolved.decisionReason, "任务已停止");
});

test("ApprovalManager waitForDecision times out fail-closed", async () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  const resolved = await manager.waitForDecision(pending.approvalKey, { timeoutMs: 0 });

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision, "cancel");
  assert.equal(resolved.decisionReason, "审批超时");
});

test("ApprovalManager waitForDecision resolves expired approvals", async () => {
  const manager = new ApprovalManager({ ttlMs: -1 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  const resolved = await manager.waitForDecision(pending.approvalKey);

  assert.equal(resolved.status, "expired");
});

test("ApprovalManager waitForDecision keeps simultaneous approvals independent", async () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  const second = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i2",
  });

  const firstWait = manager.waitForDecision(first.approvalKey);
  const secondWait = manager.waitForDecision(second.approvalKey);
  manager.decide(second.approvalKey, "route-a", "deny");
  manager.decide(first.approvalKey, "route-a", "approve");

  assert.equal((await firstWait).decision, "approve");
  assert.equal((await secondWait).decision, "deny");
});
