# Natural Sendfile And Large Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build natural-language file delivery authorization, clearer file-send failures, Weixin CDN upload retry, and Feishu large-file Drive fallback.

**Architecture:** Keep the existing `BRIDGE_SEND_FILE:` protocol as the only backend-to-Bridge file declaration path. Add a deterministic Bridge-side intent detector that only enables that protocol for the current turn, and add channel-specific media limits/errors behind the existing `ChannelAdapter.sendMedia()` contract. Feishu Drive fallback uploads to a configured relay folder, grants only the current event `open_id`, then sends a Drive URL back to the current chat.

**Tech Stack:** TypeScript, Node test runner, existing Bridge/Channel adapter modules, Feishu Open Platform Drive APIs, Weixin OpenClaw-compatible CDN upload path.

---

## Ground Rules

- Worktree: `D:\tmp\chat-codex-worktrees\new-feature`.
- Do not commit unless the user explicitly asks. The checklist below says when a commit would normally happen, but leave those steps unchecked/skipped in this repo.
- Follow TDD: write the failing test, run the targeted command to see it fail, then implement.
- Keep all new user-facing text in Simplified Chinese.
- Keep `/sendfile` behavior compatible.

## File Map

- Create `src/bridge/file-delivery-intent.ts`: deterministic natural-language sendfile authorization detector.
- Modify `src/bridge/bridge.ts`: call the detector before normal prompt enqueue; bypass route steering when this turn is a file-delivery turn.
- Create `src/protocol/media-delivery-error.ts`: shared structured media-send error type and stages.
- Modify `src/bridge/delivery.ts`: return structured file delivery results and user-readable failure summaries.
- Modify `src/protocol/channel.ts`: preserve Feishu `sender.sender_id.open_id` in `ChannelTarget.context.feishuSenderOpenId`.
- Modify `src/channels/weixin/weixin-api.ts`: add CDN upload retry.
- Modify `src/channels/feishu/feishu-types.ts`: add Drive config and Drive response types.
- Modify `src/channels/feishu/feishu-message.ts`: load/normalize `FEISHU_DRIVE_FOLDER_TOKEN`.
- Modify `src/channels/feishu/feishu-adapter.ts`: enforce Feishu media size limits and call Drive fallback.
- Create `src/channels/feishu/feishu-drive.ts`: upload to Drive, grant `openid` view permission, query metadata URL.
- Create `src/channels/feishu/feishu-media-limits.ts`: central Feishu byte limits and decision helper.
- Modify tests under `tests/unit` and `tests/integration`.
- Update `README.md`, `docs/technical-design.zh-CN.md`, `docs/feishu-adapter-design.zh-CN.md`, and `package.json`.

## Task 1: Natural-Language Sendfile Intent Detector

**Files:**
- Create: `src/bridge/file-delivery-intent.ts`
- Test: `tests/unit/file-delivery-intent.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for clear allow/deny cases:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { detectFileDeliveryIntent } from "../../src/bridge/file-delivery-intent.js";

test("detectFileDeliveryIntent enables clear send-to-me requests", () => {
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("生成报告并作为附件发给我").enabled, true);
  assert.equal(detectFileDeliveryIntent("把刚才生成的 zip 传给我").enabled, true);
});

test("detectFileDeliveryIntent rejects path analysis and third-party delivery", () => {
  assert.equal(detectFileDeliveryIntent("分析 D:\\tmp\\report.pdf 的内容").enabled, false);
  assert.equal(detectFileDeliveryIntent("看看 D:\\tmp\\report.pdf 是否存在").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发给张三").enabled, false);
  assert.equal(detectFileDeliveryIntent("把 D:\\tmp\\report.pdf 发到群里").enabled, false);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/unit/file-delivery-intent.test.js`

Expected: build fails because `file-delivery-intent.ts` does not exist.

- [ ] **Step 3: Implement detector**

Implement a small heuristic function:

```ts
export interface FileDeliveryIntentDecision {
  enabled: boolean;
  reason: "send_to_current_user" | "not_delivery" | "third_party_target" | "ambiguous";
}

export function detectFileDeliveryIntent(text: string | undefined): FileDeliveryIntentDecision {
  const normalized = (text ?? "").trim();
  if (!normalized) return { enabled: false, reason: "ambiguous" };
  if (/(发给|发送给|传给).{0,12}(张三|李四|别人|其他人|同事|群|群里|群聊|邮箱|email|mail)/i.test(normalized)) {
    return { enabled: false, reason: "third_party_target" };
  }
  const deliveryVerb = /(发给我|发送给我|传给我|发来|发我|作为附件|附件发|打包发|发一下|发送这个文件|把.+发过来)/i.test(normalized);
  const deliverable = /([a-zA-Z]:\\[^ \n\r\t]+|\/[^ \n\r\t]+|刚才生成|生成.*(报告|文件|压缩包|zip|图片|截图|pdf)|作为附件)/i.test(normalized);
  return deliveryVerb && deliverable
    ? { enabled: true, reason: "send_to_current_user" }
    : { enabled: false, reason: "not_delivery" };
}
```

- [ ] **Step 4: Verify pass**

Run: `npm run build && node --test dist/tests/unit/file-delivery-intent.test.js`

Expected: all tests pass.

## Task 2: Bridge Integration For Natural Sendfile

**Files:**
- Modify: `src/bridge/bridge.ts`
- Test: `tests/integration/bridge-mock.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add tests near the existing `/sendfile` integration tests:

```ts
test("Bridge enables sendfile for clear natural language file delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-natural-sendfile-"));
  const filePath = path.join(root, "report.pdf");
  fs.writeFileSync(filePath, "report");
  const codex = new SendFileCodexAdapter(filePath);
  const channel = new MockChannelAdapter({ media: true });
  const bridge = new Bridge({ channel, codex, cwd: root });
  await bridge.start();

  await channel.emitText(`把 ${filePath} 发给我`);
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(codex.prompts[0].includes("BRIDGE_SEND_FILE: /absolute/path/to/file"));
  assert.equal(channel.sentMedia.length, 1);
  assert.equal(channel.sentMedia[0].media.path, filePath);
});

test("Bridge does not enable sendfile for analysis or third-party requests", async () => {
  for (const text of ["分析 D:\\tmp\\report.pdf", "把 D:\\tmp\\report.pdf 发给张三"]) {
    const codex = new MockCodexAdapter();
    const channel = new MockChannelAdapter({ media: true });
    const bridge = new Bridge({ channel, codex });
    await bridge.start();
    await channel.emitText(text);
    await bridge.waitForIdle();
    await bridge.stop();
    assert.equal(codex.prompts[0].includes("BRIDGE_SEND_FILE: /absolute/path/to/file"), false);
    assert.equal(channel.sentMedia.length, 0);
  }
});
```

These helpers already exist in `bridge-mock.test.ts`.

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/integration/bridge-mock.test.js --test-name-pattern "natural language file delivery|analysis or third-party"`

Expected: prompt is not augmented and no media is sent.

- [ ] **Step 3: Implement Bridge hook**

In `Bridge.handleMessage()` after `input` is built and before `routeSteering.tryEnqueue()`:

```ts
const fileDeliveryIntent = detectFileDeliveryIntent(text);
if (fileDeliveryIntent.enabled) {
  await this.routeQueue.enqueuePrompt(message, target, input, { sendFile: true });
  return;
}
```

Do not route natural sendfile through `routeSteering`; it must run as a real queued turn.

- [ ] **Step 4: Verify pass**

Run the targeted integration command again.

Expected: both tests pass.

## Task 3: Structured Media Delivery Errors

**Files:**
- Create: `src/protocol/media-delivery-error.ts`
- Modify: `src/bridge/delivery.ts`
- Test: `tests/unit/bridge-delivery.test.ts`

- [ ] **Step 1: Write failing tests**

Add a fixture option that makes `sendMedia()` throw a structured error:

```ts
test("BridgeDelivery reports file name size stage and reason for media failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-delivery-fail-"));
  const filePath = path.join(root, "report.zip");
  fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024 + 1));
  const fixture = deliveryFixture({
    media: true,
    mediaError: new ChannelMediaDeliveryError("飞书聊天附件最大 30 MB", {
      stage: "upload",
      reasonCode: "feishu_file_too_large",
    }),
  });

  await fixture.delivery.sendRequestedFiles(target(), `${BRIDGE_SEND_FILE_PREFIX} ${filePath}`, root);

  assert.match(fixture.sentTexts.at(-1) ?? "", /report\.zip/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /1\.0 MB|1 MB/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /upload/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /飞书聊天附件最大 30 MB/);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/unit/bridge-delivery.test.js --test-name-pattern "reports file name size stage"`

Expected: build fails because `ChannelMediaDeliveryError` does not exist or output lacks details.

- [ ] **Step 3: Implement shared error and result formatting**

Create:

```ts
export type ChannelMediaErrorStage = "resolve" | "validate" | "upload" | "send" | "permission" | "link";

export class ChannelMediaDeliveryError extends Error {
  readonly stage: ChannelMediaErrorStage;
  readonly reasonCode: string;

  constructor(message: string, options: { stage: ChannelMediaErrorStage; reasonCode: string; cause?: unknown }) {
    super(message);
    this.name = "ChannelMediaDeliveryError";
    this.stage = options.stage;
    this.reasonCode = options.reasonCode;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
```

Change `trySendMedia()` to return `FileDeliveryResult` with `status`, `fileName`, `sizeBytes`, `stage`, `reasonCode`, and `message`. Format one concise summary under `文件发送结果:`.

- [ ] **Step 4: Verify pass**

Run: `npm run build && node --test dist/tests/unit/bridge-delivery.test.js`

Expected: bridge delivery tests pass.

## Task 4: Weixin CDN Upload Retry

**Files:**
- Modify: `src/channels/weixin/weixin-api.ts`
- Test: `tests/integration/weixin-adapter-api.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests around existing Weixin media upload tests:

```ts
test("WeixinAdapter retries temporary CDN upload failures", async () => {
  let cdnAttempts = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes("getuploadurl")) return jsonResponse({ upload_full_url: "https://cdn.example/upload-retry" });
    if (url === "https://cdn.example/upload-retry") {
      cdnAttempts += 1;
      if (cdnAttempts === 1) return new Response("temporary", { status: 503 });
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-after-retry" } });
    }
    if (url.includes("sendmessage")) return jsonResponse({});
    throw new Error(`unexpected fetch ${url}`);
  };
  // create adapter and send a small file like the existing file attachment test
  assert.equal(cdnAttempts, 2);
});
```

Also add a missing-header retry test if practical:

```ts
if (cdnAttempts === 1) return new Response("", { status: 200 });
```

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/integration/weixin-adapter-api.test.js --test-name-pattern "CDN upload"`

Expected: send fails after first CDN response.

- [ ] **Step 3: Implement retry**

Add `cdnUploadMaxRetries` and `cdnUploadRetryBaseDelayMs` to `WeixinApiClientOptions`, default max retries to `3`. Retry:

- thrown fetch errors
- HTTP `408`, `429`, and `>=500`
- missing `x-encrypted-param`

Do not retry HTTP 4xx other than 408/429.

- [ ] **Step 4: Verify pass**

Run the targeted Weixin integration command.

Expected: CDN upload attempts twice and media sends successfully.

## Task 5: Feishu Config And Current open_id Context

**Files:**
- Modify: `src/channels/feishu/feishu-types.ts`
- Modify: `src/channels/feishu/feishu-message.ts`
- Modify: `src/protocol/channel.ts`
- Test: `tests/unit/feishu-message.test.ts`
- Test: create `tests/unit/channel-target.test.ts`

- [ ] **Step 1: Write failing tests**

Add env parsing assertions:

```ts
const credentials = loadFeishuCredentialsFromEnv({
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "secret",
  FEISHU_DRIVE_FOLDER_TOKEN: "fld_test",
} as NodeJS.ProcessEnv);
assert.equal(credentials.driveFolderToken, "fld_test");
```

Add target context test:

```ts
test("replyTargetFromMessage preserves Feishu sender open_id", () => {
  const target = replyTargetFromMessage({
    id: "om_1",
    routeKey: "feishu:work:direct:oc_1",
    channelId: "feishu",
    accountId: "work",
    sender: { id: "fallback-user-id" },
    conversation: { id: "oc_1", kind: "direct" },
    text: "hello",
    timestamp: new Date().toISOString(),
    raw: { sender: { sender_id: { open_id: "ou_real" } } },
  });
  assert.equal(target.context?.feishuSenderOpenId, "ou_real");
});
```

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/unit/feishu-message.test.js dist/tests/unit/channel-target.test.js`

Expected: missing `driveFolderToken` and missing context field.

- [ ] **Step 3: Implement config/context**

Add optional `driveFolderToken?: string` to `FeishuCredentials`. Load:

- `FEISHU_DRIVE_FOLDER_TOKEN`
- `LARK_DRIVE_FOLDER_TOKEN`
- scoped env in `src/cli/actions/channel-actions.ts` if that function has scoped Feishu env support

Update `replyTargetFromMessage()` with a small nested-object extractor that only sets `feishuSenderOpenId` if the raw event contains a string `sender.sender_id.open_id`.

- [ ] **Step 4: Verify pass**

Run the targeted unit tests.

## Task 6: Feishu IM Media Size Limits

**Files:**
- Create: `src/channels/feishu/feishu-media-limits.ts`
- Modify: `src/channels/feishu/feishu-adapter.ts`
- Test: `tests/unit/feishu-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Use sparse files or buffers to avoid huge repo artifacts:

```ts
test("FeishuAdapter sends images over 10 MB as ordinary files up to 30 MB", async () => {
  const filePath = path.join(tempDir("codex-feishu-large-image-"), "large.png");
  fs.writeFileSync(filePath, Buffer.alloc(10 * 1024 * 1024 + 1));
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await adapter.sendMedia(targetWithOpenId(), { type: "image", path: filePath, name: "large.png", mimeType: "image/png" });

  assert.equal(factory.client.imageCreatePayloads.length, 0);
  assert.equal(factory.client.fileCreatePayloads.length, 1);
});
```

Add an over-30MB test that expects a structured error when no Drive token is configured:

```ts
await assert.rejects(
  () => adapter.sendMedia(targetWithOpenId(), { type: "file", path: filePath, name: "huge.zip" }),
  /FEISHU_DRIVE_FOLDER_TOKEN/
);
```

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/unit/feishu-adapter.test.js --test-name-pattern "over 10 MB|over-30MB|30 MB"`

Expected: adapter still calls image upload or Feishu file upload without precheck.

- [ ] **Step 3: Implement limits**

Constants:

```ts
export const FEISHU_IMAGE_MESSAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MESSAGE_MAX_BYTES = 30 * 1024 * 1024;
```

Decision:

- image <=10MB: image message
- image >10MB and <=30MB: ordinary file message
- file <=30MB: ordinary file message
- over 30MB: Drive fallback or `ChannelMediaDeliveryError` with `reasonCode: "feishu_drive_folder_token_missing"`

- [ ] **Step 4: Verify pass**

Run targeted Feishu tests.

## Task 7: Feishu Drive Upload, Permission, And Link

**Files:**
- Create: `src/channels/feishu/feishu-drive.ts`
- Modify: `src/channels/feishu/feishu-types.ts`
- Modify: `src/channels/feishu/feishu-adapter.ts`
- Modify: `tests/helpers/feishu-fakes.ts`
- Test: `tests/unit/feishu-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `FakeFeishuClient.request()` to record and return Drive responses. Add a test:

```ts
test("FeishuAdapter uploads over-30MB files to Drive and grants current open_id only", async () => {
  const filePath = path.join(tempDir("codex-feishu-drive-"), "huge.zip");
  fs.writeFileSync(filePath, Buffer.alloc(30 * 1024 * 1024 + 1));
  const factory = new FakeFeishuTransportFactory();
  factory.client.driveUploadAllResponse = { code: 0, data: { file_token: "box_file_1" } };
  factory.client.driveMetaResponse = { code: 0, data: { metas: [{ doc_token: "box_file_1", doc_type: "file", url: "https://tenant.feishu.cn/file/box_file_1" }] } };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
    connectOnStart: false,
  });
  await adapter.start();

  await adapter.sendMedia(targetWithOpenId("ou_requester"), { type: "file", path: filePath, name: "huge.zip" });

  assert.ok(factory.client.requestPayloads.some((payload) => payload.url.includes("/drive/v1/files/upload")));
  assert.ok(factory.client.requestPayloads.some((payload) => payload.url.includes("/permissions/box_file_1/members?type=file")));
  const permissionPayload = factory.client.requestPayloads.find((payload) => payload.url.includes("/permissions/box_file_1/members"));
  assert.deepEqual(permissionPayload?.data, { member_type: "openid", member_id: "ou_requester", perm: "view" });
  assert.match(factory.client.sentTexts().at(-1) ?? "", /https:\/\/tenant\.feishu\.cn\/file\/box_file_1/);
});
```

Add a negative test where `target.context.feishuSenderOpenId` is absent and `recipient.id` is `user_id`; expect failure and no permission call.

- [ ] **Step 2: Verify failure**

Run: `npm run build && node --test dist/tests/unit/feishu-adapter.test.js --test-name-pattern "Drive|open_id"`

Expected: Drive methods are missing.

- [ ] **Step 3: Implement Drive client**

Use official APIs:

- Small Drive upload: `POST /open-apis/drive/v1/files/upload_all`
- Multipart upload: `upload_prepare`, `upload_part`, `upload_finish`
- Metadata URL: `POST /open-apis/drive/v1/metas/batch_query` with `with_url: true`
- Permission: `POST /open-apis/drive/v1/permissions/{file_token}/members?type=file`

Implement `uploadFeishuDriveFile(params)` returning `{ fileToken, url }`.

Before writing the upload body, inspect `@larksuiteoapi/node-sdk` request support already available through `FeishuSdkClient.request`. If raw `request()` cannot send `FormData` reliably, keep the public adapter contract the same but implement the Drive client with `fetch` plus the app's tenant access token endpoint. Do not make users configure a user OAuth token for this feature.

For this feature, use `upload_all` for files that are accepted by the endpoint and multipart for larger files. The Drive client should throw `ChannelMediaDeliveryError` with stages `upload`, `permission`, or `link`.

- [ ] **Step 4: Wire adapter fallback**

When `sendMedia()` decides Drive fallback:

1. Require `target.context.feishuSenderOpenId`.
2. Require `this.credentials.driveFolderToken`.
3. Upload file to Drive folder.
4. Grant view permission to that open_id.
5. Send text link to current chat with `sendText()`.
6. Return that text send result.

- [ ] **Step 5: Verify pass**

Run targeted Feishu tests.

## Task 8: Documentation And Version

**Files:**
- Modify: `README.md`
- Modify: `docs/technical-design.zh-CN.md`
- Modify: `docs/feishu-adapter-design.zh-CN.md`
- Modify: `package.json`
- Check: `npm-shrinkwrap.json` only if package version is mirrored there
- Test: existing status/help tests if text changes

- [ ] **Step 1: Update docs**

Document:

- Natural language sendfile examples and safety limits.
- `/sendfile` remains available.
- File failures now include stage/reason.
- `FEISHU_DRIVE_FOLDER_TOKEN=fld...`.
- Setup steps: create relay group, add bot, create relay folder, share folder to group as editable, copy `fld...`.
- Drive fallback only grants current message `open_id`; no third-party send.

- [ ] **Step 2: Bump version**

Update `package.json` from `0.1.8` to `0.2.0`. If `npm-shrinkwrap.json` has a top-level version, update it too.

- [ ] **Step 3: Run affected docs/status tests**

Run: `npm run build && node --test dist/tests/unit/bridge-status-text.test.js dist/tests/unit/feishu-message.test.js`

Expected: pass. If help/status output changed, update tests intentionally.

## Task 9: Full Verification

**Files:**
- All modified files

- [ ] **Step 1: Build**

Run: `npm run build`

Expected: TypeScript build passes.

- [ ] **Step 2: Targeted test sweep**

Run:

```powershell
node --test dist/tests/unit/file-delivery-intent.test.js
node --test dist/tests/unit/bridge-delivery.test.js
node --test dist/tests/unit/feishu-adapter.test.js
node --test dist/tests/integration/weixin-adapter-api.test.js
node --test dist/tests/integration/bridge-mock.test.js --test-name-pattern "sendfile|natural language file delivery"
```

Expected: all pass.

- [ ] **Step 3: Full test suite**

Run: `npm test`

Expected: all existing and new tests pass. Note current local Node may be v20 even though package requires `>=22`; if tests pass under v20, still report the engine mismatch.

- [ ] **Step 4: Smoke plan workflow**

Run: `npm run smoke:plan`

Expected: plan workflow smoke passes.

- [ ] **Step 5: Final checklist**

Check:

- Function contracts: empty text, missing path, missing open_id, missing Drive token, channel without media support.
- Naming consistency: grep `FEISHU_DRIVE_FOLDER_TOKEN`, `driveFolderToken`, `feishuSenderOpenId`, `ChannelMediaDeliveryError`.
- Error/status docs: every new reason code appears in code comments or docs.
- Docs updated for all user-visible config/output.
- Version bump done.
- No accidental changes in `D:\New_god\Chat-Codex`, `HANDOFF.md`, or `temp/`.

Run:

```powershell
git status --short
git diff --stat
rg -n "FEISHU_DRIVE_FOLDER_TOKEN|driveFolderToken|feishuSenderOpenId|ChannelMediaDeliveryError" src tests docs README.md package.json
```

Expected: only intentional worktree changes are present.
