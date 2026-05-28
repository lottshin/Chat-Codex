import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { approvalActionMessage, BridgeDelivery } from "../../src/bridge/delivery.js";
import { BRIDGE_SEND_FILE_PREFIX } from "../../src/bridge/media-extractor.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelActionMessage, ChannelMedia, ChannelTarget } from "../../src/protocol/channel.js";

test("BridgeDelivery swallows normal text send failures", async () => {
  const fixture = deliveryFixture({ failText: true });
  await fixture.delivery.sendText(target(), "hello");
  assert.equal(fixture.textAttempts, 1);
  assert.deepEqual(fixture.sentTexts, []);
});

test("BridgeDelivery suppresses progress briefly after a progress send failure", async () => {
  const fixture = deliveryFixture({ failText: true });
  await fixture.delivery.sendProgressText("route", target(), "progress 1");
  await fixture.delivery.sendProgressText("route", target(), "progress 2");
  assert.equal(fixture.textAttempts, 1);
  assert.deepEqual(fixture.sentTexts, []);
});

test("approvalActionMessage renders buttons from pending approval choices", () => {
  const message = approvalActionMessage("approval", {
    approvalKey: "a001",
    routeKey: "route",
    requestedBy: "user",
    requestedAt: new Date().toISOString(),
    status: "pending",
    kind: "permissions",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    approvalOptions: [
      { id: "current", decision: "approve", label: "允许本次", description: "通过当前审批" },
      { id: "remember", decision: "approve-session", label: "记住规则", description: "允许此命令后续不再询问", updatedPermissions: [{ type: "addRules" }] },
      { id: "accept-edits", decision: "approve-session", label: "Accept edits", description: "切换到 Accept edits", updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] },
      { id: "deny", decision: "deny", label: "拒绝", description: "拒绝当前审批" },
    ],
  });

  assert.deepEqual(message.buttonGroups.map((group) => group.map((button) => button.action)), [["cmd:/1 a001", "cmd:/2 a001", "cmd:/3 a001"], ["cmd:/4 a001"]]);
  assert.deepEqual(message.buttonGroups.flat().map((button) => button.text), ["允许本次", "记住规则", "Accept edits", "拒绝"]);
  assert.deepEqual(message.buttonGroups.flat().map((button) => button.style), ["primary", "default", "default", "danger"]);
});

test("BridgeDelivery sends action messages when buttons are supported", async () => {
  const fixture = deliveryFixture({ buttons: true, actionMessages: true });
  const result = await fixture.delivery.deliverActionMessage(target(), staticActionMessage(), "fallback /OK /P /NO");

  assert.equal(result.messageId, "action-1");
  assert.equal(fixture.sentActionMessages.length, 1);
  assert.deepEqual(fixture.sentActionMessages[0]?.buttonGroups[0]?.map((button) => button.action), ["cmd:/OK", "cmd:/P", "cmd:/NO"]);
  assert.deepEqual(fixture.sentTexts, []);
});

test("BridgeDelivery falls back to text when buttons are unsupported", async () => {
  const fixture = deliveryFixture({ buttons: false, actionMessages: true });
  const result = await fixture.delivery.deliverActionMessage(target(), staticActionMessage(), "fallback /OK /P /NO");

  assert.equal(result.messageId, "text-1");
  assert.deepEqual(fixture.sentActionMessages, []);
  assert.deepEqual(fixture.sentTexts, ["fallback /OK /P /NO"]);
});

test("BridgeDelivery falls back to text when adapter lacks action message support", async () => {
  const fixture = deliveryFixture({ buttons: true, actionMessages: false });
  await fixture.delivery.deliverActionMessage(target(), staticActionMessage(), "fallback /OK /P /NO");

  assert.deepEqual(fixture.sentActionMessages, []);
  assert.deepEqual(fixture.sentTexts, ["fallback /OK /P /NO"]);
});

test("BridgeDelivery updates action messages without throwing on failure", async () => {
  const success = deliveryFixture({ messageUpdate: true });
  assert.equal(await success.delivery.updateActionMessage(target(), "m-1", "已处理"), true);
  assert.deepEqual(success.updatedTexts, ["m-1:已处理"]);

  const failure = deliveryFixture({ messageUpdate: true, failUpdate: true });
  assert.equal(await failure.delivery.updateActionMessage(target(), "m-1", "已处理"), false);
  assert.deepEqual(failure.updatedTexts, []);
});

test("BridgeDelivery sends requested files through channel media", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-delivery-test-"));
  const filePath = path.join(root, "result.txt");
  fs.writeFileSync(filePath, "ok");
  const fixture = deliveryFixture({ media: true });

  await fixture.delivery.sendRequestedFiles(target(), `${BRIDGE_SEND_FILE_PREFIX} ${filePath}`, root);

  assert.equal(fixture.sentMedia.length, 1);
  assert.equal(fixture.sentMedia[0]?.path, filePath);
});

test("BridgeDelivery toggles typing around an operation", async () => {
  const fixture = deliveryFixture({ typing: true });
  await fixture.delivery.withTyping(target(), async () => {
    fixture.events.push("operation");
  });
  assert.deepEqual(fixture.typingEvents, [true, false]);
  assert.deepEqual(fixture.events, ["operation"]);
});

function deliveryFixture(options: { failText?: boolean; media?: boolean; typing?: boolean; buttons?: boolean; actionMessages?: boolean; messageUpdate?: boolean; failUpdate?: boolean } = {}) {
  const sentTexts: string[] = [];
  const sentActionMessages: ChannelActionMessage[] = [];
  const updatedTexts: string[] = [];
  const sentMedia: ChannelMedia[] = [];
  const typingEvents: boolean[] = [];
  const events: string[] = [];
  let textAttempts = 0;
  const channels = {
    sendText: async (_target: ChannelTarget, text: string) => {
      textAttempts += 1;
      if (options.failText) throw new Error("send failed");
      sentTexts.push(text);
      return { channelId: "mock", messageId: `text-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
    },
    ...(options.actionMessages === false ? {} : {
      sendActionMessage: async (_target: ChannelTarget, message: ChannelActionMessage) => {
        sentActionMessages.push(message);
        return { channelId: "mock", messageId: `action-${sentActionMessages.length}`, deliveredAt: new Date().toISOString() };
      },
    }),
    sendMedia: async (_target: ChannelTarget, media: ChannelMedia) => {
      sentMedia.push(media);
      return { channelId: "mock", messageId: `media-${sentMedia.length}`, deliveredAt: new Date().toISOString() };
    },
    updateText: async (_target: ChannelTarget, messageId: string, text: string) => {
      if (options.failUpdate) throw new Error("update failed");
      updatedTexts.push(`${messageId}:${text}`);
      return { channelId: "mock", messageId, deliveredAt: new Date().toISOString() };
    },
    sendTyping: async (_target: ChannelTarget, typing: boolean) => {
      typingEvents.push(typing);
    },
    getCapabilities: () => ({
      text: true,
      media: options.media ?? false,
      typing: options.typing ?? false,
      direct: true,
      group: false,
      thread: false,
      login: "none" as const,
      messageUpdate: options.messageUpdate ?? false,
      streamingHint: false,
      buttons: options.buttons ?? false,
    }),
  } as unknown as ChannelRegistry;
  const delivery = new BridgeDelivery({
    channels,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  return {
    delivery,
    sentTexts,
    sentActionMessages,
    updatedTexts,
    sentMedia,
    typingEvents,
    events,
    get textAttempts() {
      return textAttempts;
    },
  };
}

function staticActionMessage(): ChannelActionMessage {
  return {
    text: "approval",
    buttonGroups: [[
      { text: "允许", action: "cmd:/OK", style: "primary" },
      { text: "本轮允许", action: "cmd:/P", style: "default" },
      { text: "拒绝", action: "cmd:/NO", style: "danger" },
    ]],
  };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "route",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  };
}
