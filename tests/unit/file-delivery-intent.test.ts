import test from "node:test";
import assert from "node:assert/strict";
import { detectFileDeliveryIntent } from "../../src/bridge/file-delivery-intent.js";

test("detectFileDeliveryIntent enables clear send-to-me requests", () => {
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("生成报告并作为附件发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把刚才生成的 zip 传给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("打包成 zip 发我").enabled, true);
});

test("detectFileDeliveryIntent rejects path analysis and third-party delivery", () => {
  assert.equal(detectFileDeliveryIntent("分析 D:\\tmp\\report.pdf 的内容").enabled, false);
  assert.equal(detectFileDeliveryIntent("看看 D:\\tmp\\report.pdf 是否存在").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发给张三").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发到群里").enabled, false);
  assert.equal(detectFileDeliveryIntent("日志里出现 D:\\tmp\\report.pdf，不要发送").enabled, false);
});
