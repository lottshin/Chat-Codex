import test from "node:test";
import assert from "node:assert/strict";
import { detectFileDeliveryIntent, detectRecentFileDeliveryIntent } from "../../src/bridge/file-delivery-intent.js";

test("detectFileDeliveryIntent enables clear send-to-me requests", () => {
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把桌面上的 test.pptx 发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把下载目录里的账单.xlsx 发来").enabled, true);
  assert.equal(detectFileDeliveryIntent("把当前目录的 result.zip 传给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把本地电脑里的会议纪要.docx 发一下").enabled, true);
  assert.equal(detectFileDeliveryIntent("生成报告并作为附件发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把刚才生成的 zip 传给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("打包成 zip 发我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把这个网页下载成 PDF 发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把网上这个 pdf 下载下来发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把这个页面截图发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("刷新浏览器飞书那个二维码然后重新截一张，立即发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("重新截一张发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("截图发给我").enabled, true);
});

test("detectFileDeliveryIntent rejects path analysis and third-party delivery", () => {
  assert.equal(detectFileDeliveryIntent("分析 D:\\tmp\\report.pdf 的内容").enabled, false);
  assert.equal(detectFileDeliveryIntent("看看 D:\\tmp\\report.pdf 是否存在").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发给张三").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发到群里").enabled, false);
  assert.equal(detectFileDeliveryIntent("日志里出现 D:\\tmp\\report.pdf，不要发送").enabled, false);
  assert.equal(detectFileDeliveryIntent("把这篇互联网上的内容发给我").enabled, false);
  assert.equal(detectFileDeliveryIntent("把这个网页链接发给我").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 https://example.com/report.pdf 发给我").enabled, false);
  assert.equal(detectFileDeliveryIntent("把网页内容总结后发给我").enabled, false);
});

test("detectRecentFileDeliveryIntent enables short send-current-file replies only", () => {
  assert.equal(detectRecentFileDeliveryIntent("发给我").enabled, true);
  assert.equal(detectRecentFileDeliveryIntent("发送给我").enabled, true);
  assert.equal(detectRecentFileDeliveryIntent("发我").enabled, true);
  assert.equal(detectRecentFileDeliveryIntent("发一下").enabled, true);
  assert.equal(detectRecentFileDeliveryIntent("把这个发给我").enabled, true);
  assert.equal(detectRecentFileDeliveryIntent("把刚才那张图发给我").enabled, true);

  assert.equal(detectRecentFileDeliveryIntent("发给张三").enabled, false);
  assert.equal(detectRecentFileDeliveryIntent("发到群里").enabled, false);
  assert.equal(detectRecentFileDeliveryIntent("分析一下").enabled, false);
});
