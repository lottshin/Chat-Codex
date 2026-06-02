import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChannelAttachment, ChannelMedia } from "../../src/protocol/channel.js";
import {
  FileHistoryStore,
  fileHistoryExtractionFromLocalItems,
  formatFileHistoryList,
} from "../../src/bridge/file-history-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-history-store-"));
}

function localMedia(filePath: string, overrides: Partial<ChannelMedia> = {}): ChannelMedia {
  return {
    type: overrides.type ?? "file",
    path: filePath,
    name: overrides.name ?? path.basename(filePath),
    mimeType: overrides.mimeType ?? "application/octet-stream",
    sizeBytes: overrides.sizeBytes,
    caption: overrides.caption,
  };
}

function localAttachment(filePath: string, overrides: Partial<ChannelAttachment> = {}): ChannelAttachment {
  return {
    id: overrides.id ?? `att-${path.basename(filePath)}`,
    type: overrides.type ?? "file",
    name: overrides.name ?? path.basename(filePath),
    mimeType: overrides.mimeType ?? "application/octet-stream",
    sizeBytes: overrides.sizeBytes,
    localPath: filePath,
    downloadState: overrides.downloadState ?? "available",
  };
}

test("FileHistoryStore records local deliverables and formats recent files", () => {
  const root = tempDir();
  const imagePath = path.join(root, "qr.png");
  const reportPath = path.join(root, "report.pdf");
  fs.writeFileSync(imagePath, "png");
  fs.writeFileSync(reportPath, "report");
  const store = new FileHistoryStore({ now: () => 1_000 });

  store.recordLocalDeliverables("route-a", [
    localMedia(imagePath, { type: "image", sizeBytes: 3 }),
    localMedia(reportPath, { type: "file", sizeBytes: 6 }),
  ], { messageId: "assistant-1" });

  const items = store.list("route-a");
  assert.deepEqual(items.map((item) => ({
    source: item.source,
    kind: item.kind,
    name: item.name,
    localPath: item.localPath,
    messageId: item.messageId,
  })), [
    { source: "agent_local", kind: "file", name: "report.pdf", localPath: reportPath, messageId: "assistant-1" },
    { source: "agent_local", kind: "image", name: "qr.png", localPath: imagePath, messageId: "assistant-1" },
  ]);

  const text = formatFileHistoryList(items);
  assert.match(text, /最近文件：/);
  assert.match(text, /1\. \[本地\] report\.pdf，6 B/);
  assert.match(text, new RegExp(escapeRegExp(reportPath)));
});

test("FileHistoryStore isolates routes and expires old records", () => {
  const root = tempDir();
  const filePath = path.join(root, "a.pdf");
  fs.writeFileSync(filePath, "pdf");
  let now = 10_000;
  const store = new FileHistoryStore({ now: () => now, ttlMs: 100 });

  store.recordLocalDeliverables("route-a", [localMedia(filePath)]);

  assert.equal(store.list("route-b").length, 0);
  assert.equal(store.list("route-a").length, 1);

  now = 10_101;
  assert.equal(store.list("route-a").length, 0);
});

test("FileHistoryStore records only usable inbound attachments", () => {
  const root = tempDir();
  const imagePath = path.join(root, "photo.jpg");
  const failedPath = path.join(root, "failed.jpg");
  fs.writeFileSync(imagePath, "jpg");
  fs.writeFileSync(failedPath, "failed");
  const store = new FileHistoryStore({ now: () => 1_000 });

  store.recordInboundAttachments("route-a", [
    localAttachment(imagePath, { type: "image", sizeBytes: 3 }),
    localAttachment(failedPath, { type: "image", downloadState: "failed" }),
    { id: "missing-path", type: "file", name: "missing.pdf", downloadState: "available" },
  ], { messageId: "user-1" });

  const items = store.list("route-a");
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "inbound_attachment");
  assert.equal(items[0].localPath, imagePath);
  assert.equal(items[0].messageId, "user-1");
});

test("FileHistoryStore records Feishu Drive listings and resolves ordinals from shown order", () => {
  const store = new FileHistoryStore({ now: () => 1_000 });

  store.recordFeishuDriveListing("route-a", [
    { token: "box_pdf", name: "brief.pdf", type: "file", url: "https://tenant.feishu.cn/file/box_pdf" },
    { token: "box_png", name: "chart.png", type: "file", url: "https://tenant.feishu.cn/file/box_png" },
  ]);

  const items = store.list("route-a");
  assert.deepEqual(items.map((item) => item.name), ["brief.pdf", "chart.png"]);

  const resolved = store.resolveReference("route-a", "下载第 2 个到桌面", { action: "download_to_local" });
  assert.equal(resolved.kind, "feishu_drive_file");
  if (resolved.kind === "feishu_drive_file") {
    assert.equal(resolved.item.feishuFileToken, "box_png");
    assert.equal(resolved.item.name, "chart.png");
  }
});

test("FileHistoryStore filters by explicit cloud source and file type", () => {
  const root = tempDir();
  const oldImage = path.join(root, "old-local.png");
  fs.writeFileSync(oldImage, "png");
  const store = new FileHistoryStore({ now: () => 1_000 });

  store.recordLocalDeliverables("route-a", [localMedia(oldImage, { type: "image" })]);
  store.recordFeishuDriveListing("route-a", [
    { token: "box_pdf", name: "deck.pdf", type: "file", url: "https://tenant.feishu.cn/file/box_pdf" },
    { token: "box_png", name: "cloud-image.png", type: "file", url: "https://tenant.feishu.cn/file/box_png" },
  ]);

  const resolved = store.resolveReference("route-a", "把云盘里的图片保存到桌面", { action: "download_to_local" });
  assert.equal(resolved.kind, "feishu_drive_file");
  if (resolved.kind === "feishu_drive_file") {
    assert.equal(resolved.item.name, "cloud-image.png");
  }
});

test("FileHistoryStore returns ambiguity instead of picking among multiple matches", () => {
  const root = tempDir();
  const one = path.join(root, "one.png");
  const two = path.join(root, "two.png");
  fs.writeFileSync(one, "png");
  fs.writeFileSync(two, "png");
  const store = new FileHistoryStore({ now: () => 1_000 });

  store.recordLocalDeliverables("route-a", [
    localMedia(one, { type: "image" }),
    localMedia(two, { type: "image" }),
  ]);

  const resolved = store.resolveReference("route-a", "把图片发给我", { action: "send_to_chat" });
  assert.equal(resolved.kind, "ambiguous");
  if (resolved.kind === "ambiguous") {
    assert.deepEqual(resolved.items.map((item) => item.name), ["two.png", "one.png"]);
  }
});

test("FileHistoryStore reports unsupported Feishu Drive item types", () => {
  const store = new FileHistoryStore({ now: () => 1_000 });

  store.recordFeishuDriveListing("route-a", [
    { token: "folder_1", name: "资料文件夹", type: "folder", url: "https://tenant.feishu.cn/drive/folder/folder_1" },
  ]);

  const resolved = store.resolveReference("route-a", "下载第 1 个到桌面", { action: "download_to_local" });
  assert.equal(resolved.kind, "unsupported");
  if (resolved.kind === "unsupported") {
    assert.equal(resolved.item.name, "资料文件夹");
  }
});

test("fileHistoryExtractionFromLocalItems builds sendfile extraction from local history", () => {
  const root = tempDir();
  const filePath = path.join(root, "report.pdf");
  fs.writeFileSync(filePath, "pdf");
  const store = new FileHistoryStore({ now: () => 1_000 });
  store.recordLocalDeliverables("route-a", [localMedia(filePath, { sizeBytes: 3 })]);

  const resolved = store.resolveReference("route-a", "发给我", { action: "send_to_chat" });
  assert.equal(resolved.kind, "local_media");
  if (resolved.kind !== "local_media") throw new Error("expected local media");

  const extraction = fileHistoryExtractionFromLocalItems(resolved.items, 3);
  assert.equal(extraction.requestedCount, 1);
  assert.equal(extraction.media[0].path, filePath);
  assert.equal(extraction.invalidRefs.length, 0);
  assert.equal(extraction.overflowCount, 0);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
