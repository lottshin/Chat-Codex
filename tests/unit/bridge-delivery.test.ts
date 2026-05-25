import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
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

test("BridgeDelivery sends action messages when buttons are supported", async () => {
  const fixture = deliveryFixture({ buttons: true, actionMessages: true });
  await fixture.delivery.deliverActionMessage(target(), approvalActionMessage(), "fallback /OK /P /NO");

  assert.equal(fixture.sentActionMessages.length, 1);
  assert.deepEqual(fixture.sentActionMessages[0]?.buttonGroups[0]?.map((button) => button.action), ["cmd:/OK", "cmd:/P", "cmd:/NO"]);
  assert.deepEqual(fixture.sentTexts, []);
});

test("BridgeDelivery falls back to text when buttons are unsupported", async () => {
  const fixture = deliveryFixture({ buttons: false, actionMessages: true });
  await fixture.delivery.deliverActionMessage(target(), approvalActionMessage(), "fallback /OK /P /NO");

  assert.deepEqual(fixture.sentActionMessages, []);
  assert.deepEqual(fixture.sentTexts, ["fallback /OK /P /NO"]);
});

test("BridgeDelivery falls back to text when adapter lacks action message support", async () => {
  const fixture = deliveryFixture({ buttons: true, actionMessages: false });
  await fixture.delivery.deliverActionMessage(target(), approvalActionMessage(), "fallback /OK /P /NO");

  assert.deepEqual(fixture.sentActionMessages, []);
  assert.deepEqual(fixture.sentTexts, ["fallback /OK /P /NO"]);
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

function deliveryFixture(options: { failText?: boolean; media?: boolean; typing?: boolean; buttons?: boolean; actionMessages?: boolean } = {}) {
  const sentTexts: string[] = [];
  const sentActionMessages: ChannelActionMessage[] = [];
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
      messageUpdate: false,
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
    sentMedia,
    typingEvents,
    events,
    get textAttempts() {
      return textAttempts;
    },
  };
}

function approvalActionMessage(): ChannelActionMessage {
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
