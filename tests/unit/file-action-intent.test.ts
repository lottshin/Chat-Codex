import test from "node:test";
import assert from "node:assert/strict";
import { classifyFileActionIntent } from "../../src/bridge/file-action-intent.js";

test("classifyFileActionIntent separates chat delivery from local downloads", () => {
  assert.deepEqual(classifyFileActionIntent("把 D:\\tmp\\report.pdf 发给我"), {
    action: "send_to_chat",
    target: "current_user",
    source: "local",
  });
  assert.deepEqual(classifyFileActionIntent("把桌面上的 test.pptx 发给我"), {
    action: "send_to_chat",
    target: "current_user",
    source: "local",
  });
  assert.deepEqual(classifyFileActionIntent("生成报告并作为附件发给我"), {
    action: "send_to_chat",
    target: "current_user",
    source: "generated",
  });
  assert.deepEqual(classifyFileActionIntent("把这个页面截图发给我"), {
    action: "send_to_chat",
    target: "current_user",
    source: "remote_materialized",
  });

  assert.deepEqual(classifyFileActionIntent("把云盘里的图片保存到桌面"), {
    action: "download_to_local",
    target: "local_computer",
    source: "cloud",
  });
  assert.deepEqual(classifyFileActionIntent("下载到 D:\\tmp 这个文件"), {
    action: "download_to_local",
    target: "local_computer",
    source: "unspecified",
  });
});

test("classifyFileActionIntent rejects third-party and plain internet forwarding", () => {
  assert.deepEqual(classifyFileActionIntent("把 D:\\tmp\\report.pdf 发给张三"), {
    action: "blocked",
    target: "third_party",
    source: "local",
    reason: "third_party_target",
  });
  assert.deepEqual(classifyFileActionIntent("把这个网页链接发给我"), {
    action: "none",
    target: "none",
    source: "remote",
    reason: "plain_remote_reference",
  });
  assert.deepEqual(classifyFileActionIntent("分析 D:\\tmp\\report.pdf 的内容"), {
    action: "none",
    target: "none",
    source: "local",
    reason: "not_delivery",
  });
});
