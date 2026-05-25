import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { ClaudeApprovalService, type ClaudeApprovalContext } from "../../src/claude/approval-service.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { PendingApproval } from "../../src/approvals/types.js";
import type { ChannelTarget } from "../../src/protocol/channel.js";

const payload = {
  tool_name: "Bash",
  tool_use_id: "toolu-1",
  input: { command: "npm test" },
};

test("ClaudeApprovalService allows approved permission prompts", async () => {
  const fixture = serviceFixture();
  const request = fixture.service.requestPermission(payload, fixture.context);
  await fixture.delivery.created;

  fixture.approvals.decide(fixture.sent[0].approvalKey, fixture.context.routeKey, "approve");

  assert.deepEqual(await request, { behavior: "allow" });
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].kind, "command");
});

test("ClaudeApprovalService treats approve-session as current request allow", async () => {
  const fixture = serviceFixture();
  const request = fixture.service.requestPermission(payload, fixture.context);
  await fixture.delivery.created;

  fixture.approvals.decide(fixture.sent[0].approvalKey, fixture.context.routeKey, "approve-session");

  assert.deepEqual(await request, { behavior: "allow" });
});

test("ClaudeApprovalService denies rejected permission prompts", async () => {
  const fixture = serviceFixture();
  const request = fixture.service.requestPermission(payload, fixture.context);
  await fixture.delivery.created;

  fixture.approvals.decide(fixture.sent[0].approvalKey, fixture.context.routeKey, "deny");

  assert.deepEqual(await request, { behavior: "deny", message: "远程审批已拒绝。" });
});

test("ClaudeApprovalService denies cancelled permission prompts", async () => {
  const fixture = serviceFixture();
  const request = fixture.service.requestPermission(payload, fixture.context);
  await fixture.delivery.created;

  fixture.approvals.cancelRoute(fixture.context.routeKey, "任务已停止");

  assert.deepEqual(await request, { behavior: "deny", message: "审批取消或超时，已拒绝。" });
});

test("ClaudeApprovalService times out fail-closed", async () => {
  const fixture = serviceFixture({ waitTimeoutMs: 0 });

  assert.deepEqual(await fixture.service.requestPermission(payload, fixture.context), { behavior: "deny", message: "审批取消或超时，已拒绝。" });
  assert.equal(fixture.sent[0].decision, "cancel");
  assert.equal(fixture.sent[0].decisionReason, "审批超时");
});

test("ClaudeApprovalService denies malformed payloads without creating approvals", async () => {
  const fixture = serviceFixture();

  assert.deepEqual(await fixture.service.requestPermission({ tool_name: "Bash" }, fixture.context), { behavior: "deny", message: "审批请求格式无效，已拒绝。" });
  assert.equal(fixture.sent.length, 0);
});

test("ClaudeApprovalService denies missing context without creating approvals", async () => {
  const fixture = serviceFixture();

  assert.deepEqual(await fixture.service.requestPermission(payload, undefined), { behavior: "deny", message: "缺少远程审批上下文，已拒绝。" });
  assert.equal(fixture.sent.length, 0);
});

test("ClaudeApprovalService denies and cancels pending approvals when delivery fails", async () => {
  const fixture = serviceFixture({ deliveryError: new Error("send failed") });

  assert.deepEqual(await fixture.service.requestPermission(payload, fixture.context), { behavior: "deny", message: "审批取消或超时，已拒绝。" });
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].decision, "cancel");
  assert.equal(fixture.sent[0].decisionReason, "审批服务异常");
});

function serviceFixture(options: { waitTimeoutMs?: number | null; deliveryError?: Error } = {}) {
  const approvals = new ApprovalManager({ ttlMs: 60_000 });
  const sent: PendingApproval[] = [];
  let resolveCreated: (() => void) | undefined;
  const created = new Promise<void>((resolve) => {
    resolveCreated = resolve;
  });
  const delivery = {
    created,
    async sendApprovalTextUntilDelivered(_routeKey: string, _target: ChannelTarget, pending: PendingApproval) {
      sent.push(pending);
      resolveCreated?.();
      if (options.deliveryError) throw options.deliveryError;
      return { channelId: "mock", messageId: "approval-message", deliveredAt: new Date().toISOString() };
    },
  };
  return {
    approvals,
    sent,
    delivery,
    context: approvalContext(),
    service: new ClaudeApprovalService({
      approvals,
      delivery,
      logger: new SilentLogger(),
      waitTimeoutMs: options.waitTimeoutMs,
    }),
  };
}

function approvalContext(): ClaudeApprovalContext {
  return {
    routeKey: "mock:default:direct:user",
    requestedBy: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/repo",
    target: {
      channelId: "mock",
      routeKey: "mock:default:direct:user",
      conversation: { id: "user", kind: "direct" },
      recipient: { id: "user" },
    },
  };
}
