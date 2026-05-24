import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import type { ApprovalDecision } from "../../src/approvals/types.js";
import { handleApprovalCommand } from "../../src/bridge/commands/approval-command.js";
import type { CodexAdapter } from "../../src/codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";

test("handleApprovalCommand rejects unavailable approval decisions", async () => {
  const approvals = new ApprovalManager();
  const pending = approvals.create("mock:default:direct:user", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    availableDecisions: ["approve", "deny"],
  });
  const sent: string[] = [];
  const resolved: ApprovalDecision[] = [];

  await handleApprovalCommand({
    approvals,
    codex: {
      resolveApproval: async (_approvalKey, decision) => {
        resolved.push(decision);
      },
    } as CodexAdapter,
    delivery: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
      },
    } as never,
  }, message(), target(), [], "approve-session");

  assert.equal(approvals.get(pending.approvalKey)?.status, "pending");
  assert.deepEqual(resolved, []);
  assert.match(sent.at(-1) ?? "", /不支持/);
  assert.match(sent.at(-1) ?? "", /审批提示中实际列出的命令/);
  assert.doesNotMatch(sent.at(-1) ?? "", /\/P、/);
});

test("handleApprovalCommand explains next steps when no approval is pending", async () => {
  const approvals = new ApprovalManager();
  const sent: string[] = [];

  await handleApprovalCommand({
    approvals,
    codex: {} as CodexAdapter,
    delivery: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
      },
    } as never,
  }, message(), target(), [], "approve");

  assert.match(sent.at(-1) ?? "", /当前没有待处理审批/);
  assert.match(sent.at(-1) ?? "", /等待新的审批提示/);
  assert.match(sent.at(-1) ?? "", /\/status/);
  assert.match(sent.at(-1) ?? "", /普通消息继续任务/);
});

test("handleApprovalCommand confirms approval and next step", async () => {
  const approvals = new ApprovalManager();
  approvals.create("mock:default:direct:user", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  const sent: string[] = [];
  const resolved: ApprovalDecision[] = [];

  await handleApprovalCommand({
    approvals,
    codex: {
      resolveApproval: async (_approvalKey, decision) => {
        resolved.push(decision);
      },
    } as CodexAdapter,
    delivery: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
      },
    } as never,
  }, message(), target(), [], "approve");

  assert.deepEqual(resolved, ["approve"]);
  assert.match(sent.at(-1) ?? "", /审批已处理：已通过/);
  assert.match(sent.at(-1) ?? "", /等待当前任务继续输出/);
});

function message(): ChannelMessage {
  return {
    id: "m1",
    channelId: "mock",
    routeKey: "mock:default:direct:user",
    text: "/P",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
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
