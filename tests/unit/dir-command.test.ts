import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { handleDirCommand } from "../../src/bridge/commands/dir-command.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";

test("handleDirCommand shows current default workdir", async () => {
  const fixture = dirFixture({ cwd: "/workspace", hasActiveSession: true });

  await fixture.handle([]);

  assert.match(fixture.sent.at(-1) ?? "", /当前新会话默认工作目录: `\/workspace`/);
  assert.match(fixture.sent.at(-1) ?? "", /当前已绑定会话不会切换目录/);
});

test("handleDirCommand sets an existing directory", async () => {
  const fixture = dirFixture();
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-dir-existing-"));

  await fixture.handle([targetDir]);

  assert.equal(fixture.cwd, targetDir);
  assert.match(fixture.sent.at(-1) ?? "", /已设置新会话默认工作目录/);
  assert.match(fixture.sent.at(-1) ?? "", new RegExp(escapeRegExp(targetDir)));
});

test("handleDirCommand supports explicit set with paths containing spaces", async () => {
  const fixture = dirFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-dir-spaces-"));
  const targetDir = path.join(root, "project with spaces");
  fs.mkdirSync(targetDir);

  await fixture.handle(["set", targetDir]);

  assert.equal(fixture.cwd, targetDir);
});

test("handleDirCommand rejects missing directories without creating them", async () => {
  const fixture = dirFixture();
  const missingDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-dir-missing-")), "missing");

  await fixture.handle([missingDir]);

  assert.equal(fixture.cwd, "/workspace");
  assert.equal(fs.existsSync(missingDir), false);
  assert.match(fixture.sent.at(-1) ?? "", /工作目录不存在/);
  assert.match(fixture.sent.at(-1) ?? "", /\/dir create <path>/);
});

test("handleDirCommand creates directories only when explicit", async () => {
  const fixture = dirFixture();
  const missingDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-dir-create-")), "created");

  await fixture.handle(["create", missingDir]);

  assert.equal(fixture.cwd, missingDir);
  assert.equal(fs.statSync(missingDir).isDirectory(), true);
  assert.match(fixture.sent.at(-1) ?? "", /已创建目录并设置新会话默认工作目录/);
});

test("handleDirCommand rejects file paths", async () => {
  const fixture = dirFixture();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-dir-file-"));
  const filePath = path.join(tempDir, "file.txt");
  fs.writeFileSync(filePath, "x");

  await fixture.handle([filePath]);

  assert.equal(fixture.cwd, "/workspace");
  assert.match(fixture.sent.at(-1) ?? "", /工作目录不是目录/);
});

function dirFixture(options: { cwd?: string; hasActiveSession?: boolean } = {}) {
  let cwd = options.cwd ?? "/workspace";
  const sent: string[] = [];
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
  return {
    sent,
    get cwd() {
      return cwd;
    },
    handle: (args: string[]) => handleDirCommand({
      delivery,
      getDefaultWorkdir: () => cwd,
      setDefaultWorkdir: (next) => {
        cwd = next;
      },
      hasActiveSession: () => options.hasActiveSession ?? false,
    }, message(), target(), args),
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
