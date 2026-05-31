import test from "node:test";
import assert from "node:assert/strict";
import { replyTargetFromMessage, type ChannelMessage } from "../../src/protocol/channel.js";

test("replyTargetFromMessage preserves Feishu sender open_id from raw event", () => {
  const message: ChannelMessage = {
    id: "om_1",
    routeKey: "feishu:work:direct:oc_1",
    channelId: "feishu",
    accountId: "work",
    sender: { id: "fallback-user-id" },
    conversation: { id: "oc_1", kind: "direct" },
    text: "hello",
    timestamp: new Date().toISOString(),
    raw: {
      sender: {
        sender_id: {
          open_id: "ou_real",
        },
      },
    },
  };

  const target = replyTargetFromMessage(message);

  assert.equal(target.context?.feishuSenderOpenId, "ou_real");
});

test("replyTargetFromMessage does not trust Feishu user_id as open_id", () => {
  const message: ChannelMessage = {
    id: "om_1",
    routeKey: "feishu:work:direct:oc_1",
    channelId: "feishu",
    accountId: "work",
    sender: { id: "user_id_fallback" },
    conversation: { id: "oc_1", kind: "direct" },
    text: "hello",
    timestamp: new Date().toISOString(),
    raw: {
      sender: {
        sender_id: {
          user_id: "user_id_fallback",
        },
      },
    },
  };

  const target = replyTargetFromMessage(message);

  assert.equal(target.context?.feishuSenderOpenId, undefined);
});
