import test from "node:test";
import assert from "node:assert/strict";
import { handleSendFileCommand } from "../../src/bridge/commands/sendfile-command.js";
import type { BridgeDelivery } from "../../src/bridge/delivery.js";
import type { BridgeRouteQueue } from "../../src/bridge/route-queue.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";

test("handleSendFileCommand strips the active command name before enqueueing", async () => {
  const fixture = sendFileFixture();

  await handleSendFileCommand(fixture.options, message(), target(), "/sendfile 生成报告", "sendfile");
  await handleSendFileCommand(fixture.options, message(), target(), "/bridge-sendfile 生成图", "bridge-sendfile");

  assert.deepEqual(fixture.enqueued, [
    { prompt: "生成报告", sendFile: true },
    { prompt: "生成图", sendFile: true },
  ]);
});

test("handleSendFileCommand shows command-specific usage for empty prompts", async () => {
  const fixture = sendFileFixture();

  await handleSendFileCommand(fixture.options, message(), target(), "/bridge-sendfile", "bridge-sendfile");

  assert.equal(fixture.enqueued.length, 0);
  assert.match(fixture.sent.at(-1) ?? "", /缺少任务内容/);
  assert.match(fixture.sent.at(-1) ?? "", /`\/bridge-sendfile <你要 Codex 做什么，并在最终结果里发文件>`/);
  assert.match(fixture.sent.at(-1) ?? "", /普通消息里的本地路径不会自动作为附件发送/);
});

test("handleSendFileCommand uses Claude Code wording for Claude profile", async () => {
  const fixture = sendFileFixture({ assistantName: "Claude Code" });

  await handleSendFileCommand(fixture.options, message(), target(), "/sendfile", "sendfile");

  assert.match(fixture.sent.at(-1) ?? "", /`\/sendfile <你要 Claude Code 做什么，并在最终结果里发文件>`/);
});

function sendFileFixture(options: { assistantName?: string } = {}) {
  const sent: string[] = [];
  const enqueued: Array<{ prompt: string; sendFile: boolean | undefined }> = [];
  return {
    sent,
    enqueued,
    options: {
      delivery: {
        sendText: async (_target: ChannelTarget, text: string) => {
          sent.push(text);
        },
      } as BridgeDelivery,
      routeQueue: {
        enqueuePrompt: async (_message: ChannelMessage, _target: ChannelTarget, prompt: string, options?: { sendFile?: boolean }) => {
          enqueued.push({ prompt, sendFile: options?.sendFile });
        },
      } as BridgeRouteQueue,
      assistantName: options.assistantName,
    },
  };
}

function message(): ChannelMessage {
  return {
    id: "message-1",
    routeKey: "mock:default:direct:user",
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
    text: "",
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
