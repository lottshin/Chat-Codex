import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";
import { ChannelMediaDeliveryError } from "../../src/protocol/media-delivery-error.js";
import { FakeFeishuTransportFactory, sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

const credentials = {
  appId: "cli_1234567890abcdef",
  appSecret: "test-secret",
  accountId: "work",
};

test("FeishuAdapter reports login_required when credentials are missing", async () => {
  const adapter = new FeishuAdapter({ transportFactory: new FakeFeishuTransportFactory() });

  await adapter.start();
  const status = await adapter.getStatus();

  assert.equal(status.state, "login_required");
  assert.match(status.lastError ?? "", /FEISHU_APP_ID/);
  assert.equal(status.details?.appSecret, "未配置");
});

test("FeishuAdapter starts websocket and declares private media capabilities", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });

  await adapter.start();

  assert.equal((await adapter.getStatus()).state, "connected");
  assert.equal(factory.wsClient?.starts, 1);
  assert.deepEqual(adapter.getDeliveryPolicy(), {
    ...DEFAULT_CHANNEL_DELIVERY_POLICY,
    progress: "aggregate",
    taskLifecycle: "update-progress",
  });
  assert.deepEqual(adapter.getCapabilities(), {
    text: true,
    media: true,
    receiveMedia: true,
    typing: true,
    direct: true,
    group: false,
    thread: false,
    login: "token",
    messageUpdate: true,
    streamingHint: true,
    buttons: true,
    cards: true,
  });
});

test("FeishuAdapter downloads inbound image resources before emitting ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: uploadRoot });
  const received: Array<{ localPath?: string; downloadState?: string }> = [];
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  factory.client.resourceBuffers.set("img_in_1", imageBytes);
  factory.client.resourceHeaders.set("img_in_1", { "content-type": "image/png" });
  adapter.onMessage(async (message) => {
    const attachment = message.attachments?.[0];
    received.push({
      localPath: attachment?.localPath,
      downloadState: attachment?.downloadState,
    });
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_img",
      chat_id: "oc_user",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_in_1" }),
    },
  }));

  assert.equal(factory.client.messageResourceGetPayloads.length, 1);
  assert.deepEqual(factory.client.messageResourceGetPayloads[0], {
    params: { type: "image" },
    path: { message_id: "om_img", file_key: "img_in_1" },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].downloadState, "available");
  assert.ok(received[0].localPath?.startsWith(uploadRoot));
  assert.deepEqual(fs.readFileSync(received[0].localPath ?? ""), imageBytes);
});

test("FeishuAdapter downloads inbound file resources before emitting ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: uploadRoot });
  const fileBytes = Buffer.from("report");
  factory.client.resourceBuffers.set("file_in_1", fileBytes);
  factory.client.resourceHeaders.set("file_in_1", { "content-type": "application/pdf" });
  let localPath = "";
  let downloadState = "";
  adapter.onMessage(async (message) => {
    const attachment = message.attachments?.[0];
    localPath = attachment?.localPath ?? "";
    downloadState = attachment?.downloadState ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_file",
      chat_id: "oc_user",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_in_1", file_name: "report.pdf", file_size: fileBytes.length }),
    },
  }));

  assert.deepEqual(factory.client.messageResourceGetPayloads[0], {
    params: { type: "file" },
    path: { message_id: "om_file", file_key: "file_in_1" },
  });
  assert.equal(downloadState, "available");
  assert.ok(localPath.startsWith(uploadRoot));
  assert.deepEqual(fs.readFileSync(localPath), fileBytes);
});

test("FeishuAdapter marks inbound resource download failures on attachment", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.messageResourceError = new Error("resource denied");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: tempDir("codex-feishu-upload-") });
  let downloadState = "";
  let error = "";
  adapter.onMessage(async (message) => {
    downloadState = message.attachments?.[0]?.downloadState ?? "";
    error = message.attachments?.[0]?.error ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_img_failed",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_failed" }),
    },
  }));

  assert.equal(downloadState, "failed");
  assert.match(error, /resource denied/);
});

test("FeishuAdapter uploads and sends image and file media", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  const dir = tempDir("codex-feishu-send-");
  const imagePath = path.join(dir, "shot.png");
  const filePath = path.join(dir, "report.pdf");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  fs.writeFileSync(filePath, Buffer.from("pdf"));
  await adapter.start();
  const target = {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  };

  await adapter.sendMedia(target, { type: "image", path: imagePath, name: "shot.png", caption: "截图" });
  await adapter.sendMedia(target, { type: "file", path: filePath, name: "report.pdf", mimeType: "application/pdf" });

  assert.equal(factory.client.imageCreatePayloads.length, 1);
  assert.deepEqual(factory.client.imageCreatePayloads[0].data.image, Buffer.from([1, 2, 3]));
  assert.equal(factory.client.fileCreatePayloads.length, 1);
  assert.equal(factory.client.fileCreatePayloads[0].data.file_type, "pdf");
  assert.equal(factory.client.fileCreatePayloads[0].data.file_name, "report.pdf");
  const msgTypes = factory.client.replyPayloads.map((payload) => payload.data.msg_type);
  assert.deepEqual(msgTypes, ["post", "image", "file"]);
  assert.deepEqual(factory.client.replyPayloads.map((payload) => JSON.parse(payload.data.content)), [
    { zh_cn: { content: [[{ tag: "md", text: "截图" }]] } },
    { image_key: "img_upload" },
    { file_key: "file_upload" },
  ]);
});

test("FeishuAdapter sends images over 10 MB as ordinary files up to 30 MB", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  const filePath = path.join(tempDir("codex-feishu-large-image-"), "large.png");
  fs.writeFileSync(filePath, Buffer.alloc(10 * 1024 * 1024 + 1));
  await adapter.start();

  await adapter.sendMedia(targetWithOpenId(), {
    type: "image",
    path: filePath,
    name: "large.png",
    mimeType: "image/png",
  });

  assert.equal(factory.client.imageCreatePayloads.length, 0);
  assert.equal(factory.client.fileCreatePayloads.length, 1);
  assert.equal(factory.client.replyPayloads.at(-1)?.data.msg_type, "file");
});

test("FeishuAdapter reports over-30MB files without Drive folder token", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  const filePath = path.join(tempDir("codex-feishu-no-drive-"), "huge.zip");
  fs.writeFileSync(filePath, Buffer.alloc(30 * 1024 * 1024 + 1));
  await adapter.start();

  await assert.rejects(
    () => adapter.sendMedia(targetWithOpenId(), { type: "file", path: filePath, name: "huge.zip" }),
    (error) => error instanceof ChannelMediaDeliveryError
      && error.stage === "validate"
      && error.reasonCode === "feishu_drive_folder_token_missing"
      && /FEISHU_DRIVE_FOLDER_TOKEN/.test(error.message),
  );
  assert.equal(factory.client.fileCreatePayloads.length, 0);
});

test("FeishuAdapter uploads over-30MB files to Drive and grants current open_id only", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.driveUploadFinishResponse = { code: 0, data: { file_token: "box_file_1" } };
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_1",
        doc_type: "file",
        title: "huge.zip",
        owner_id: "ou_bot",
        create_time: "1",
        latest_modify_user: "ou_bot",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_1",
      }],
    },
  };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
    connectOnStart: false,
  });
  const filePath = path.join(tempDir("codex-feishu-drive-"), "huge.zip");
  fs.writeFileSync(filePath, Buffer.alloc(30 * 1024 * 1024 + 1));
  await adapter.start();

  await adapter.sendMedia(targetWithOpenId("ou_requester"), {
    type: "file",
    path: filePath,
    name: "huge.zip",
  });

  assert.equal(factory.client.driveFileUploadPreparePayloads.length, 1);
  assert.ok(factory.client.driveFileUploadPartPayloads.length > 0);
  assert.equal(factory.client.driveFileUploadPartPayloads[0]?.data.file instanceof Buffer, true);
  assert.equal(factory.client.driveFileUploadFinishPayloads.length, 1);
  assert.equal(factory.client.requestPayloads.some((payload) => payload.url.includes("/drive/v1/files/upload_part")), false);
  assert.ok(factory.client.requestPayloads.some((payload) => payload.url.includes("/drive/v1/metas/batch_query")));
  const permissionPayload = factory.client.requestPayloads.find((payload) => payload.url.includes("/permissions/box_file_1/members"));
  assert.ok(permissionPayload);
  assert.deepEqual(permissionPayload.data, {
    member_type: "openid",
    member_id: "ou_requester",
    perm: "view",
  });
  assert.match(factory.client.sentTexts().at(-1) ?? "", /https:\/\/tenant\.feishu\.cn\/file\/box_file_1/);
});

test("FeishuAdapter caches bare Drive folder links as pending config candidates without invoking the agent", async () => {
  const factory = new FakeFeishuTransportFactory();
  const stateDir = tempDir("codex-feishu-drive-config-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, stateDir });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "https://my.feishu.cn/drive/folder/WImjfx4RnlAV6tdHS4lcDTkKnRc" }),
    },
  }));

  assert.equal(fs.existsSync(path.join(stateDir, "accounts", "work", "credentials.local.json")), false);
  assert.equal(received, 0);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /收到飞书云空间文件夹链接/);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /帮我配置这个中转文件夹/);
});

test("FeishuAdapter saves Drive folder token only when direct messages include config intent", async () => {
  const factory = new FakeFeishuTransportFactory();
  const stateDir = tempDir("codex-feishu-drive-config-intent-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, stateDir });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_intent",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "帮我配置这个中转文件夹 https://my.feishu.cn/drive/folder/WImjfx4RnlAV6tdHS4lcDTkKnRc" }),
    },
  }));

  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "accounts", "work", "credentials.local.json"), "utf-8")) as {
    credentials?: Record<string, string>;
  };
  assert.equal(saved.credentials?.appId, credentials.appId);
  assert.equal(saved.credentials?.appSecret, credentials.appSecret);
  assert.equal(saved.credentials?.driveFolderToken, "WImjfx4RnlAV6tdHS4lcDTkKnRc");
  assert.equal(received, 0);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /已配置飞书云空间中转文件夹/);
});

test("FeishuAdapter applies the previous Drive folder link when the next direct message asks to configure it", async () => {
  const factory = new FakeFeishuTransportFactory();
  const stateDir = tempDir("codex-feishu-drive-config-followup-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, stateDir });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_pending",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "https://my.feishu.cn/drive/folder/WImjfx4RnlAV6tdHS4lcDTkKnRc" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_followup",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "帮我进行配置" }),
    },
  }));

  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "accounts", "work", "credentials.local.json"), "utf-8")) as {
    credentials?: Record<string, string>;
  };
  assert.equal(saved.credentials?.driveFolderToken, "WImjfx4RnlAV6tdHS4lcDTkKnRc");
  assert.equal(received, 0);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /已配置飞书云空间中转文件夹/);
});

test("FeishuAdapter lists configured Drive relay folder contents without invoking the agent", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.driveFileListResponse = {
    code: 0,
    data: {
      files: [
        {
          token: "box_file_ppt",
          name: "方案.pptx",
          type: "file",
          url: "https://tenant.feishu.cn/file/box_file_ppt",
          modified_time: "1710000000",
        },
        {
          token: "fld_child",
          name: "资料",
          type: "folder",
          url: "https://tenant.feishu.cn/drive/folder/fld_child",
        },
      ],
      has_more: false,
    },
  };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
  });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_list",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "你帮我看看这个中转站里面有什么文件" }),
    },
  }));

  assert.equal(received, 0);
  assert.deepEqual(factory.client.driveFileListPayloads[0], {
    params: {
      folder_token: "fld_relay",
      page_size: 20,
      order_by: "EditedTime",
      direction: "DESC",
    },
  });
  assert.match(factory.client.sentTexts().at(-1) ?? "", /中转文件夹里有 2 项/);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /方案\.pptx/);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /资料/);
});

test("FeishuAdapter downloads a recently listed relay folder jpg without invoking the agent", async () => {
  const factory = new FakeFeishuTransportFactory();
  const desktopDir = tempDir("codex-feishu-drive-listed-desktop-");
  factory.client.driveDownloadBuffer = Buffer.from("jpg bytes");
  factory.client.driveFileListResponse = {
    code: 0,
    data: {
      files: [
        {
          token: "box_file_jpg",
          name: "mmexport1779460084949.jpg",
          type: "file",
          url: "https://tenant.feishu.cn/file/box_file_jpg",
        },
        {
          token: "box_file_ppt",
          name: "test.pptx",
          type: "file",
          url: "https://tenant.feishu.cn/file/box_file_ppt",
        },
      ],
      has_more: false,
    },
  };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
    desktopDir,
  });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_list_before_download",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "你帮我看看这个中转站里面有什么文件" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_download_jpg",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "这个jpg你保存到本地电脑桌面" }),
    },
  }));

  const card = latestFeishuActionCard(factory);
  const actions = feishuCardActionValues(card);
  assert.equal(received, 0);
  assert.match(card.elements?.[0]?.content ?? "", /确认下载飞书云空间文件/);
  assert.match(card.elements?.[0]?.content ?? "", /mmexport1779460084949\.jpg/);
  assert.match(card.elements?.[0]?.content ?? "", new RegExp(escapeRegExp(desktopDir)));
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);

  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_folder_download_jpg",
    token: "callback-token",
    open_id: "ou_user",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[0] } },
  });

  const expectedPath = path.join(desktopDir, "mmexport1779460084949.jpg");
  await waitFor(() => assert.deepEqual(fs.readFileSync(expectedPath), Buffer.from("jpg bytes")));
  assert.deepEqual(factory.client.driveFileDownloadPayloads[0], { path: { file_token: "box_file_jpg" } });
});

test("FeishuAdapter clarifies recently listed relay folder file references without invoking the agent", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.driveFileListResponse = {
    code: 0,
    data: {
      files: [{
        token: "box_file_jpg",
        name: "mmexport1779460084949.jpg",
        type: "file",
        url: "https://tenant.feishu.cn/file/box_file_jpg",
      }],
      has_more: false,
    },
  };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
  });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_list_before_clarify",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "你帮我看看这个中转站里面有什么文件" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_clarify_jpg",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "我说的是中转云盘里的那个jpg文件" }),
    },
  }));

  assert.equal(received, 0);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /mmexport1779460084949\.jpg/);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /保存到桌面/);
  assert.equal(factory.client.replyPayloads.some((payload) => payload.data.msg_type === "interactive"), false);
});

test("FeishuAdapter keeps clarified relay folder file for follow-up desktop downloads", async () => {
  const factory = new FakeFeishuTransportFactory();
  const desktopDir = tempDir("codex-feishu-drive-clarified-desktop-");
  factory.client.driveDownloadBuffer = Buffer.from("clarified jpg bytes");
  factory.client.driveFileListResponse = {
    code: 0,
    data: {
      files: [
        {
          token: "box_file_jpg",
          name: "mmexport1779460084949.jpg",
          type: "file",
          url: "https://tenant.feishu.cn/file/box_file_jpg",
        },
        {
          token: "box_file_pdf",
          name: "会议纪要.pdf",
          type: "file",
          url: "https://tenant.feishu.cn/file/box_file_pdf",
        },
      ],
      has_more: false,
    },
  };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    desktopDir,
    transportFactory: factory,
  });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_list_before_followup_download",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "你帮我看看这个中转站里面有什么文件" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_clarify_before_followup_download",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "我说的是中转云盘里的那个jpg文件" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_followup_download_desktop",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "保存到桌面" }),
    },
  }));

  assert.equal(received, 0);
  const card = latestFeishuActionCard(factory);
  assert.match(card.elements?.[0]?.content ?? "", /确认下载飞书云空间文件/);
  assert.match(card.elements?.[0]?.content ?? "", /mmexport1779460084949\.jpg/);
  assert.match(card.elements?.[0]?.content ?? "", new RegExp(escapeRegExp(desktopDir)));
  const actions = feishuCardActionValues(card);
  assert.match(actions[0] ?? "", /^local:feishu-drive-download:approve:/);
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);

  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_folder_followup_download_desktop",
    token: "callback-token",
    open_id: "ou_user",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[0] } },
  });

  const expectedPath = path.join(desktopDir, "mmexport1779460084949.jpg");
  await waitFor(() => assert.deepEqual(fs.readFileSync(expectedPath), Buffer.from("clarified jpg bytes")));
  assert.deepEqual(factory.client.driveFileDownloadPayloads[0], { path: { file_token: "box_file_jpg" } });
});

test("FeishuAdapter lists configured Drive relay folder contents from mentioned group messages", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.driveFileListResponse = {
    code: 0,
    data: {
      files: [{
        token: "box_file_group",
        name: "群文件.zip",
        type: "file",
        url: "https://tenant.feishu.cn/file/box_file_group",
      }],
      has_more: false,
    },
  };
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
    groupEnabled: true,
  });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_drive_folder_list",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 你帮我看看这个中转站里面有什么文件" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 0);
  assert.equal(factory.client.driveFileListPayloads.length, 1);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /群文件\.zip/);
});

test("FeishuAdapter explains missing Drive relay folder config for folder listing requests", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_folder_list_missing",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "看一下中转站里面有什么文件" }),
    },
  }));

  assert.equal(received, 0);
  assert.equal(factory.client.driveFileListPayloads.length, 0);
  assert.match(factory.client.sentTexts().at(-1) ?? "", /还没有配置飞书云空间中转文件夹/);
});

test("FeishuAdapter does not save Drive folder token from group messages", async () => {
  const factory = new FakeFeishuTransportFactory();
  const stateDir = tempDir("codex-feishu-drive-config-group-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, stateDir, groupEnabled: true });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_drive_folder",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 帮我配置这个中转文件夹 https://my.feishu.cn/drive/folder/WImjfx4RnlAV6tdHS4lcDTkKnRc" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(fs.existsSync(path.join(stateDir, "accounts", "work", "credentials.local.json")), false);
  assert.equal(received, 1);
});

test("FeishuAdapter treats bare Drive file links as ordinary messages", async () => {
  const factory = new FakeFeishuTransportFactory();
  const downloadRoot = tempDir("codex-feishu-drive-download-bare-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: downloadRoot });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_file_bare",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "https://tenant.feishu.cn/file/box_file_download" }),
    },
  }));

  assert.equal(received, 1);
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);
  assert.equal(factory.client.replyPayloads.some((payload) => payload.data.msg_type === "interactive"), false);
});

test("FeishuAdapter asks before downloading Drive files and saves approved files to the default upload root", async () => {
  const factory = new FakeFeishuTransportFactory();
  const downloadRoot = tempDir("codex-feishu-drive-download-default-");
  factory.client.driveDownloadBuffer = Buffer.from("pptx bytes");
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_download",
        doc_type: "file",
        title: "deck.pptx",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_download",
      }],
    },
  };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: downloadRoot });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_file_download",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "下载这个文件 https://tenant.feishu.cn/file/box_file_download" }),
    },
  }));

  const card = latestFeishuActionCard(factory);
  const actions = feishuCardActionValues(card);
  assert.equal(received, 0);
  assert.match(card.elements?.[0]?.content ?? "", /deck\.pptx/);
  assert.match(card.elements?.[0]?.content ?? "", new RegExp(escapeRegExp(downloadRoot)));
  assert.equal(actions.length, 2);
  assert.match(actions[0] ?? "", /^local:feishu-drive-download:approve:/);
  assert.match(actions[1] ?? "", /^local:feishu-drive-download:cancel:/);
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);

  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_download_approve",
    token: "callback-token",
    open_id: "ou_user",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[0] } },
  });

  const expectedPath = path.join(downloadRoot, "deck.pptx");
  await waitFor(() => assert.deepEqual(fs.readFileSync(expectedPath), Buffer.from("pptx bytes")));
  assert.deepEqual(factory.client.driveFileDownloadPayloads[0], { path: { file_token: "box_file_download" } });
  await waitFor(() => assert.match(latestUpdatedCardText(factory), /已下载/));
  assert.match(latestUpdatedCardText(factory), /deck\.pptx/);
});

test("FeishuAdapter saves approved Drive downloads to the configured desktop directory", async () => {
  const factory = new FakeFeishuTransportFactory();
  const desktopDir = tempDir("codex-feishu-drive-desktop-");
  factory.client.driveDownloadBuffer = Buffer.from("desktop bytes");
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_desktop",
        doc_type: "file",
        title: "desktop.zip",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_desktop",
      }],
    },
  };
  const options: ConstructorParameters<typeof FeishuAdapter>[0] & { desktopDir: string } = {
    ...credentials,
    transportFactory: factory,
    desktopDir,
  };
  const adapter = new FeishuAdapter(options);

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_file_desktop",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "下载到桌面 https://tenant.feishu.cn/file/box_file_desktop" }),
    },
  }));

  const actions = feishuCardActionValues(latestFeishuActionCard(factory));
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_download_desktop",
    token: "callback-token",
    open_id: "ou_user",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[0] } },
  });

  const expectedPath = path.join(desktopDir, "desktop.zip");
  await waitFor(() => assert.deepEqual(fs.readFileSync(expectedPath), Buffer.from("desktop bytes")));
});

test("FeishuAdapter rejects Drive download requests that name a missing absolute directory", async () => {
  const factory = new FakeFeishuTransportFactory();
  const missingDir = path.join(tempDir("codex-feishu-drive-missing-parent-"), "missing");
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_missing_dir",
        doc_type: "file",
        title: "missing.pdf",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_missing_dir",
      }],
    },
  };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_file_missing_dir",
      chat_id: "oc_user",
      content: JSON.stringify({ text: `下载到 ${missingDir} https://tenant.feishu.cn/file/box_file_missing_dir` }),
    },
  }));

  assert.match(factory.client.sentTexts().at(-1) ?? "", /目录不存在/);
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);
});

test("FeishuAdapter keeps existing files by adding a suffix to Drive downloads", async () => {
  const factory = new FakeFeishuTransportFactory();
  const downloadRoot = tempDir("codex-feishu-drive-download-conflict-");
  fs.writeFileSync(path.join(downloadRoot, "deck.pptx"), "existing");
  factory.client.driveDownloadBuffer = Buffer.from("new bytes");
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_conflict",
        doc_type: "file",
        title: "deck.pptx",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_conflict",
      }],
    },
  };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: downloadRoot });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_file_conflict",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "帮我下载 https://tenant.feishu.cn/file/box_file_conflict" }),
    },
  }));

  const actions = feishuCardActionValues(latestFeishuActionCard(factory));
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_download_conflict",
    token: "callback-token",
    open_id: "ou_user",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[0] } },
  });

  const expectedPath = path.join(downloadRoot, "deck (1).pptx");
  assert.equal(fs.readFileSync(path.join(downloadRoot, "deck.pptx"), "utf-8"), "existing");
  await waitFor(() => assert.deepEqual(fs.readFileSync(expectedPath), Buffer.from("new bytes")));
});

test("FeishuAdapter cancels Drive downloads from the confirmation card", async () => {
  const factory = new FakeFeishuTransportFactory();
  const downloadRoot = tempDir("codex-feishu-drive-download-cancel-");
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_cancel",
        doc_type: "file",
        title: "cancel.pdf",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_cancel",
      }],
    },
  };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: downloadRoot });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_file_cancel",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "下载这个文件 https://tenant.feishu.cn/file/box_file_cancel" }),
    },
  }));

  const actions = feishuCardActionValues(latestFeishuActionCard(factory));
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_download_cancel",
    token: "callback-token",
    open_id: "ou_user",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[1] } },
  });

  await waitFor(() => assert.match(latestUpdatedCardText(factory), /已取消/));
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);
  assert.equal(fs.existsSync(path.join(downloadRoot, "cancel.pdf")), false);
});

test("FeishuAdapter rejects Drive download approvals from a different Feishu open_id", async () => {
  const factory = new FakeFeishuTransportFactory();
  const downloadRoot = tempDir("codex-feishu-drive-download-owner-");
  factory.client.driveDownloadBuffer = Buffer.from("owner bytes");
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "box_file_owner",
        doc_type: "file",
        title: "owner.pdf",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/file/box_file_owner",
      }],
    },
  };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, inboundMediaRootDir: downloadRoot });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    sender: { sender_id: { open_id: "ou_requester" } },
    message: {
      message_id: "om_drive_file_owner",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "下载这个文件 https://tenant.feishu.cn/file/box_file_owner" }),
    },
  }));

  const actions = feishuCardActionValues(latestFeishuActionCard(factory));
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_drive_download_other_user",
    token: "callback-token",
    open_id: "ou_other",
    open_chat_id: "oc_user",
    open_message_id: "om_reply",
    action: { value: { action: actions[0] } },
  });

  await waitFor(() => assert.match(latestUpdatedCardText(factory), /只有发起人可以确认下载/));
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);
  assert.equal(fs.existsSync(path.join(downloadRoot, "owner.pdf")), false);
});

test("FeishuAdapter reports unsupported Drive doc types instead of downloading them", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.driveMetaResponse = {
    code: 0,
    data: {
      metas: [{
        doc_token: "doccn_online",
        doc_type: "docx",
        title: "online doc",
        owner_id: "ou_user",
        create_time: "1",
        latest_modify_user: "ou_user",
        latest_modify_time: "1",
        url: "https://tenant.feishu.cn/docx/doccn_online",
      }],
    },
  };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_drive_docx_download",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "下载这个文件 https://tenant.feishu.cn/file/doccn_online" }),
    },
  }));

  assert.match(factory.client.sentTexts().at(-1) ?? "", /暂不支持下载飞书在线文档/);
  assert.equal(factory.client.driveFileDownloadPayloads.length, 0);
});

test("FeishuAdapter refuses Drive fallback without current message open_id", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({
    ...credentials,
    driveFolderToken: "fld_relay",
    transportFactory: factory,
    connectOnStart: false,
  });
  const filePath = path.join(tempDir("codex-feishu-drive-no-openid-"), "huge.zip");
  fs.writeFileSync(filePath, Buffer.alloc(30 * 1024 * 1024 + 1));
  await adapter.start();

  await assert.rejects(
    () => adapter.sendMedia(targetWithOpenId("", "user_id_fallback"), {
      type: "file",
      path: filePath,
      name: "huge.zip",
    }),
    (error) => error instanceof ChannelMediaDeliveryError
      && error.stage === "permission"
      && error.reasonCode === "feishu_sender_open_id_missing",
  );
  assert.equal(factory.client.requestPayloads.some((payload) => payload.url.includes("/permissions/")), false);
  assert.equal(factory.client.sentTexts().some((text) => text.includes("tenant.feishu.cn")), false);
});

test("FeishuAdapter updates text messages through Feishu message update API", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  const result = await adapter.updateText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
  }, "om_progress", "任务进度:\n正在处理");

  assert.equal(result.messageId, "om_update");
  assert.equal(factory.client.requestPayloads.length, 2);
  const payload = factory.client.requestPayloads[1];
  assert.equal(payload.method, "PATCH");
  assert.equal(payload.url, "/open-apis/im/v1/messages/om_progress");
  assert.deepEqual(payload.data, {
    msg_type: "post",
    content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: "任务进度:\n正在处理" }]] } }),
  });
});

test("FeishuAdapter patches action messages as interactive status cards", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();
  const target = {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  };

  const sent = await adapter.sendActionMessage(target, {
    text: "需要审批",
    buttonGroups: [[{ text: "允许", action: "cmd:/1 a001", style: "primary" }]],
  });
  await adapter.updateText(target, sent.messageId, "审批已处理：已批准");

  assert.equal(factory.client.cardIdConvertPayloads.length, 1);
  assert.deepEqual(factory.client.cardIdConvertPayloads[0], { data: { message_id: "om_reply" } });
  assert.equal(factory.client.cardUpdatePayloads.length, 1);
  const data = factory.client.cardUpdatePayloads[0].data.card.data;
  const card = JSON.parse(data) as {
    config?: { update_multi?: boolean };
    elements?: Array<{ tag?: string; content?: string; actions?: unknown[] }>;
  };
  assert.equal(card.config?.update_multi, true);
  assert.equal(card.elements?.[0]?.content, "审批已处理：已批准");
  assert.equal(card.elements?.some((element) => element.tag === "action"), false);
});
test("FeishuAdapter reports update failures", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.updateResponse = { code: 999, msg: "update denied" };
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await assert.rejects(adapter.updateText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
  }, "om_progress", "任务进度"), /update denied/);
  assert.equal((await adapter.getStatus()).details?.phase, "update-failed");
});

test("FeishuAdapter updates action status cards when metadata marks action kind", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await adapter.updateText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
  }, "om_card", "已处理", { metadata: { messageKind: "action" } });

  assert.equal(factory.client.cardIdConvertPayloads.length, 1);
  assert.deepEqual(factory.client.cardIdConvertPayloads[0], { data: { message_id: "om_card" } });
  assert.equal(factory.client.cardUpdatePayloads.length, 1);
  const data = factory.client.cardUpdatePayloads[0].data.card.data;
  const card = JSON.parse(data) as {
    config?: { update_multi?: boolean };
    elements?: Array<{ tag?: string; content?: string; actions?: unknown[] }>;
  };
  assert.equal(card.config?.update_multi, true);
  assert.equal(card.elements?.[0]?.content, "已处理");
  assert.equal(card.elements?.some((element) => element.tag === "action"), false);
});

test("FeishuAdapter sends action messages as interactive cards", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  const result = await adapter.sendActionMessage({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, {
    text: "需要审批",
    buttonGroups: [[
      { text: "允许", action: "cmd:/OK", style: "primary" },
      { text: "拒绝", action: "cmd:/NO", style: "danger" },
    ]],
  });

  assert.equal(result.messageId, "om_reply");
  assert.equal(factory.client.replyPayloads.length, 1);
  assert.equal(factory.client.replyPayloads[0].data.msg_type, "interactive");
  const card = JSON.parse(factory.client.replyPayloads[0].data.content) as {
    config?: { wide_screen_mode?: boolean; update_multi?: boolean };
    elements?: Array<{ tag?: string; content?: string; actions?: Array<{ text?: { content?: string }; type?: string; value?: { action?: string; routeKey?: string } }> }>;
  };
  assert.equal(card.config?.wide_screen_mode, true);
  assert.equal(card.config?.update_multi, true);
  assert.equal(card.elements?.[0]?.content, "需要审批");
  assert.deepEqual(card.elements?.[1]?.actions?.map((action) => action.text?.content), ["允许", "拒绝"]);
  assert.deepEqual(card.elements?.[1]?.actions?.map((action) => action.type), ["primary", "danger"]);
  assert.deepEqual(card.elements?.[1]?.actions?.map((action) => action.value?.action), ["cmd:/OK", "cmd:/NO"]);
  assert.deepEqual(card.elements?.[1]?.actions?.map((action) => action.value?.routeKey), ["feishu:work:direct:oc_user", "feishu:work:direct:oc_user"]);
});

test("FeishuAdapter renders each button group as a separate action row", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await adapter.sendActionMessage({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, {
    text: "请选择",
    buttonGroups: [
      [{ text: "执行：自动模式", action: "cmd:/plan-execute", style: "primary" }],
      [{ text: "执行：逐项审批", action: "cmd:/plan-edit", style: "default" }],
      [{ text: "修改计划", action: "cmd:/replan", style: "default" }],
    ],
  });

  const card = JSON.parse(factory.client.replyPayloads[0].data.content) as {
    elements?: Array<{ tag?: string; actions?: Array<{ text?: { content?: string }; value?: { action?: string; routeKey?: string } }> }>;
  };
  const actionRows = card.elements?.filter((element) => element.tag === "action") ?? [];
  assert.deepEqual(actionRows.map((row) => row.actions?.map((action) => action.text?.content)), [["执行：自动模式"], ["执行：逐项审批"], ["修改计划"]]);
  assert.deepEqual(actionRows.map((row) => row.actions?.map((action) => action.value?.action)), [["cmd:/plan-execute"], ["cmd:/plan-edit"], ["cmd:/replan"]]);
  assert.deepEqual(actionRows.map((row) => row.actions?.map((action) => action.value?.routeKey)), [["feishu:work:direct:oc_user"], ["feishu:work:direct:oc_user"], ["feishu:work:direct:oc_user"]]);
});

test("FeishuAdapter converts card actions to command ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, now: () => 1_700_000_000_000 });
  let receivedText = "";
  let routeKey = "";
  let senderId = "";
  adapter.onMessage(async (message) => {
    receivedText = message.text ?? "";
    routeKey = message.routeKey;
    senderId = message.sender.id;
  });

  await adapter.start();
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_card_1",
    open_message_id: "om_card_1",
    open_id: "ou_user",
    open_chat_id: "oc_direct",
    action: { value: { action: "cmd:/plan-execute", routeKey: "feishu:work:group:oc_direct" } },
  });

  assert.equal(receivedText, "/plan-execute");
  assert.equal(routeKey, "feishu:work:group:oc_direct");
  assert.equal(senderId, "ou_user");
  assert.equal((await adapter.getStatus()).details?.phase, "card-action-received");
});
test("FeishuAdapter converts nested card action callbacks to command ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, now: () => 1_700_000_000_000 });
  let receivedText = "";
  let routeKey = "";
  let senderId = "";
  adapter.onMessage(async (message) => {
    receivedText = message.text ?? "";
    routeKey = message.routeKey;
    senderId = message.sender.id;
  });

  await adapter.start();
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event: {
      event_id: "ev_nested_card_1",
      operator: { open_id: "ou_nested" },
      context: { open_chat_id: "oc_direct", open_message_id: "om_card_nested" },
      action: { value: { action: "cmd:/1 approval-key", routeKey: "feishu:work:direct:oc_bound" } },
    },
  });

  assert.equal(receivedText, "/1 approval-key");
  assert.equal(routeKey, "feishu:work:direct:oc_bound");
  assert.equal(senderId, "ou_nested");
  assert.equal((await adapter.getStatus()).details?.phase, "card-action-received");
});
test("FeishuAdapter exposes original card message id for action status updates", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let sourceMessageId = "";
  let messageId = "";
  adapter.onMessage(async (message) => {
    messageId = message.id;
    const raw = message.raw as { sourceMessageId?: string } | undefined;
    sourceMessageId = raw?.sourceMessageId ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitCardAction({
    event_id: "ev_card_action_1",
    app_id: credentials.appId,
    open_id: "ou_user",
    chat_id: "oc_direct",
    open_message_id: "om_card_original",
    action: { value: { action: "reply:1", routeKey: "feishu:work:direct:oc_direct" } },
  });

  assert.equal(messageId, "ev_card_action_1");
  assert.equal(sourceMessageId, "om_card_original");
});

test("FeishuAdapter returns an empty card action response and uses callback token to update the card", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let releaseHandler: (() => void) | undefined;
  adapter.onMessage(async () => {
    await new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
  });

  await adapter.start();
  const responsePromise = factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event: {
      event_id: "ev_card_action_fast_response",
      token: "callback-token",
      operator: { open_id: "ou_user" },
      context: { open_chat_id: "oc_direct", open_message_id: "om_card_original" },
      action: { value: { action: "cmd:/1 approval-key", routeKey: "feishu:work:direct:oc_direct" } },
    },
  });
  const response = await Promise.race([
    responsePromise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
  ]);
  releaseHandler?.();

  assert.notEqual(response, "timeout");
  assert.deepEqual(response, {});
  const updatePayload = factory.client.requestPayloads.find((payload) => payload.method === "POST" && payload.url === "/open-apis/interactive/v1/card/update");
  assert.ok(updatePayload);
  assert.equal((updatePayload.data as { token?: string }).token, "callback-token");
  const card = (updatePayload.data as { card?: { elements?: Array<{ tag?: string; content?: string; actions?: unknown[] }> } }).card;
  assert.ok(card);
  assert.match(card.elements?.[0]?.content ?? "", /审批已处理/);
  assert.equal(card.elements?.some((element) => element.tag === "action"), false);
});

test("FeishuAdapter converts reply card actions to plain ChannelMessage text", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, now: () => 1_700_000_000_000 });
  let receivedText = "";
  let routeKey = "";
  adapter.onMessage(async (message) => {
    receivedText = message.text ?? "";
    routeKey = message.routeKey;
  });

  await adapter.start();
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_reply_1",
    open_message_id: "om_card_1",
    open_id: "ou_user",
    open_chat_id: "oc_direct",
    action: { value: { action: "reply:2", routeKey: "feishu:work:group:oc_direct" } },
  });

  assert.equal(receivedText, "2");
  assert.equal(routeKey, "feishu:work:group:oc_direct");
});

test("FeishuAdapter does not deduplicate distinct card actions from the same card", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, now: () => 1_700_000_000_000 });
  const received: string[] = [];
  adapter.onMessage(async (message) => {
    received.push(message.text ?? "");
  });

  await adapter.start();
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_reply_1",
    open_message_id: "om_same_card",
    open_id: "ou_user",
    open_chat_id: "oc_direct",
    action: { value: { action: "reply:1", routeKey: "feishu:work:direct:oc_direct" } },
  });
  await factory.dispatcher.emitCardAction({
    app_id: credentials.appId,
    event_id: "ev_reply_2",
    open_message_id: "om_same_card",
    open_id: "ou_user",
    open_chat_id: "oc_direct",
    action: { value: { action: "reply:2", routeKey: "feishu:work:direct:oc_direct" } },
  });

  assert.deepEqual(received, ["1", "2"]);
});

test("FeishuAdapter emits ChannelMessage for p2p text events and deduplicates message_id", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const received: string[] = [];
  adapter.onMessage(async (message) => {
    received.push(message.text ?? "");
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_once",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "/help" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_once",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "/help" }),
    },
  }));

  assert.deepEqual(received, ["/help"]);
  const status = await adapter.getStatus();
  assert.equal(status.lastInboundAt !== undefined, true);
  assert.equal(status.details?.lastSkipReason, "duplicate_message");
});

test("FeishuAdapter does not resolve private sender names through Feishu user API", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let senderId = "";
  let senderDisplayName: string | undefined;
  adapter.onMessage(async (message) => {
    senderId = message.sender.id;
    senderDisplayName = message.sender.displayName;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_resolve_name",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "hello" }),
    },
  }));

  assert.equal(senderId, "ou_user");
  assert.equal(senderDisplayName, undefined);
  assert.equal(factory.client.userGetPayloads.length, 0);
});

test("FeishuAdapter ignores private sender display names from event fields without API lookup", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let senderDisplayName: string | undefined;
  adapter.onMessage(async (message) => {
    senderDisplayName = message.sender.displayName;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    sender: { sender_name: "李四" },
    message: {
      message_id: "om_event_name",
      chat_id: "oc_user",
      content: JSON.stringify({ text: "event name" }),
    },
  }));

  assert.equal(senderDisplayName, undefined);
  assert.equal(factory.client.userGetPayloads.length, 0);
});

test("FeishuAdapter maps group receive events to group ChannelMessage internally", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, groupEnabled: true });
  let routeKey = "";
  let conversationKind = "";
  let text = "";
  adapter.onMessage(async (message) => {
    routeKey = message.routeKey;
    conversationKind = message.conversation.kind;
    text = message.text ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_once",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 看一下" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(routeKey, "feishu:work:group:oc_group");
  assert.equal(conversationKind, "group");
  assert.equal(text, "看一下");
  assert.equal(adapter.getCapabilities().group, true);
});

test("FeishuAdapter downloads group file resources before emitting ChannelMessage", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-group-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, groupEnabled: true, inboundMediaRootDir: uploadRoot });
  const fileBytes = Buffer.from("group report");
  factory.client.resourceBuffers.set("file_group_in_1", fileBytes);
  factory.client.resourceHeaders.set("file_group_in_1", { "content-type": "application/pdf" });
  let routeKey = "";
  let localPath = "";
  let downloadState = "";
  adapter.onMessage(async (message) => {
    const attachment = message.attachments?.[0];
    routeKey = message.routeKey;
    localPath = attachment?.localPath ?? "";
    downloadState = attachment?.downloadState ?? "";
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_file",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_group_in_1", file_name: "group-report.pdf", file_size: fileBytes.length }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(routeKey, "feishu:work:group:oc_group");
  assert.deepEqual(factory.client.messageResourceGetPayloads[0], {
    params: { type: "file" },
    path: { message_id: "om_group_file", file_key: "file_group_in_1" },
  });
  assert.equal(downloadState, "available");
  assert.ok(localPath.startsWith(uploadRoot));
  assert.deepEqual(fs.readFileSync(localPath), fileBytes);
});

test("FeishuAdapter skips group messages that do not mention the bot", async () => {
  const factory = new FakeFeishuTransportFactory();
  const uploadRoot = tempDir("codex-feishu-group-upload-");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, groupEnabled: true, inboundMediaRootDir: uploadRoot });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_no_mention",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "只是群里普通聊天" }),
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_at_all",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_all 看一下" }),
      mentions: [{
        key: "@_all",
        id: {},
        name: "所有人",
      }],
    },
  }));
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_file_no_mention",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_group_ignored", file_name: "ignored.pdf" }),
    },
  }));

  assert.equal(received, 0);
  assert.equal(factory.client.messageResourceGetPayloads.length, 0);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_bot_not_mentioned");
});

test("FeishuAdapter skips group receive events while group capability is disabled", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory });
  let received = 0;
  adapter.onMessage(async () => {
    received += 1;
  });

  await adapter.start();
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_disabled",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 看一下" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 0);
  assert.equal((await adapter.getStatus()).details?.lastSkipReason, "group_disabled");

  adapter.setGroupEnabled(true);
  await factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: "om_group_enabled",
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 再看一下" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }));

  assert.equal(received, 1);
  assert.equal(adapter.getCapabilities().group, true);
});

test("FeishuAdapter sendText replies to source message first", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  const result = await adapter.sendText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, "回复内容");

  assert.equal(result.messageId, "om_reply");
  assert.equal(factory.client.replyPayloads.length, 1);
  assert.equal(factory.client.replyPayloads[0].path.message_id, "om_source");
  assert.equal(factory.client.createPayloads.length, 0);
  assert.match(factory.client.sentTexts()[0], /回复内容/);
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function targetWithOpenId(openId = "ou_user", recipientId = openId ?? "user_id_fallback") {
  return {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: recipientId },
    context: {
      sourceMessageId: "om_source",
      ...(openId ? { feishuSenderOpenId: openId } : {}),
    },
  };
}

type TestFeishuCard = {
  elements?: Array<{
    tag?: string;
    content?: string;
    actions?: Array<{
      text?: { content?: string };
      value?: { action?: string; routeKey?: string };
    }>;
  }>;
};

function latestFeishuActionCard(factory: FakeFeishuTransportFactory): TestFeishuCard {
  const payload = factory.client.replyPayloads.at(-1);
  assert.equal(payload?.data.msg_type, "interactive");
  return JSON.parse(payload.data.content) as TestFeishuCard;
}

function feishuCardActionValues(card: TestFeishuCard): string[] {
  return card.elements
    ?.filter((element) => element.tag === "action")
    .flatMap((element) => element.actions?.map((action) => action.value?.action ?? "") ?? [])
    .filter(Boolean) ?? [];
}

function latestUpdatedCardText(factory: FakeFeishuTransportFactory): string {
  const payload = factory.client.cardUpdatePayloads.at(-1);
  if (!payload) return "";
  const card = JSON.parse(payload.data.card.data) as TestFeishuCard;
  return card.elements?.find((element) => element.tag === "markdown")?.content ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
  assert.fail("condition was not met before timeout");
}

test("FeishuAdapter sendText falls back to chat_id create when reply fails", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.replyError = new Error("reply unavailable");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  const result = await adapter.sendText({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, "回退发送");

  assert.equal(result.messageId, "om_create");
  assert.equal(factory.client.replyPayloads.length, 1);
  assert.equal(factory.client.createPayloads.length, 1);
  assert.equal(factory.client.createPayloads[0].params.receive_id_type, "chat_id");
  assert.equal(factory.client.createPayloads[0].data.receive_id, "oc_user");
  assert.match(factory.client.sentTexts().at(-1) ?? "", /回退发送/);
});

test("FeishuAdapter uses Typing reaction as typing indicator", async () => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();
  const target = {
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" as const },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  };

  await adapter.sendTyping(target, true);
  await adapter.sendTyping(target, true);
  await adapter.sendTyping(target, false);

  assert.equal(factory.client.reactionCreatePayloads.length, 1);
  assert.equal(factory.client.reactionCreatePayloads[0].path.message_id, "om_source");
  assert.equal(factory.client.reactionCreatePayloads[0].data.reaction_type.emoji_type, "Typing");
  assert.deepEqual(factory.client.reactionDeletePayloads, [{
    path: {
      message_id: "om_source",
      reaction_id: "react_typing_1",
    },
  }]);
});

test("FeishuAdapter typing reaction failure does not degrade channel", async () => {
  const factory = new FakeFeishuTransportFactory();
  factory.client.reactionCreateError = new Error("reaction permission denied");
  const adapter = new FeishuAdapter({ ...credentials, transportFactory: factory, connectOnStart: false });
  await adapter.start();

  await adapter.sendTyping({
    channelId: "feishu",
    routeKey: "feishu:work:direct:oc_user",
    accountId: "work",
    conversation: { id: "oc_user", kind: "direct" },
    recipient: { id: "ou_user" },
    context: { sourceMessageId: "om_source" },
  }, true);

  const status = await adapter.getStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.lastError, undefined);
  assert.match(String(status.details?.lastTypingError), /reaction permission denied/);
});
