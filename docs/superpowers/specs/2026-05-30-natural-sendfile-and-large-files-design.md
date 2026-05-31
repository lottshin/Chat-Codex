# 自然语言 Sendfile 与大文件发送设计

日期：2026-05-30

## 背景

当前只有 `/sendfile <任务>` 会启用本轮文件发送授权。用户用自然语言说“把这个本地文件发给我”时，Bridge 仍按普通文本处理，不会给后端追加 `BRIDGE_SEND_FILE:` 协议说明，也不会解析最终回复里的文件声明。

另一个问题是文件发送失败信息过粗。`sendRequestedFiles()` 只汇总“有 N 个文件发送失败”，渠道上传阶段的具体原因没有反馈给用户。用户观察到约 5MB 文件发送失败；项目代码没有显式 5MB 限制，优先怀疑上传链路稳定性、渠道限制和错误吞噬。

## 目标

- 用户可以用明确自然语言授权当前轮发送本地文件，不必记住 `/sendfile`。
- `/sendfile` 继续保留，作为显式强制入口。
- 文件发送只在本轮授权后启用，不因为普通回复里出现路径就自动外发。
- 文件发送失败时反馈文件名、大小、渠道、阶段和可理解原因。
- 微信不加人为小文件限制，补充 CDN 上传重试和错误分类。
- 飞书按官方聊天附件限制预检，并为超限文件提供 Drive 中转方案。

## 非目标

- 不支持自然语言把本地文件发给第三方用户或群。
- 不默认开启飞书群聊文件发送。
- 不让机器人直接访问用户个人云盘。
- 不做用户 OAuth 云盘授权。
- 不把 Drive 大文件伪装成飞书 IM 附件；Drive 上传后发送链接。

## 自然语言授权

新增一个 sendfile 意图判断层，在普通消息入队前运行。

触发条件必须同时满足：

- 文本表达的是“发送/发给我/作为附件/传给我/把文件发来”等交付动作。
- 文本包含明确本地路径，或上下文表达“刚生成的文件/报告/压缩包/图片”等可由后端产出的交付物。
- 目标是当前会话请求者，不包含第三方收件人、群、邮箱等外发对象。

不触发的情况：

- 只是提到路径让 agent 查看、分析、修改。
- 日志、报错、搜索结果里出现文件路径。
- 用户要求发给别人或发到群。
- 表达模糊，无法判断是否授权发送本地文件。

触发后等价于本轮 `/sendfile`：route queue 设置 `sendFile: true`，formatter 追加现有 `BRIDGE_SEND_FILE:` 内部协议说明。最终仍只发送后端在最终回复中声明的文件。

## Bridge 发送结果

把 `trySendMedia()` 从 boolean 改成结构化结果：

- `status`: `sent | failed | skipped`
- `path`
- `fileName`
- `sizeBytes`
- `channelId`
- `stage`: `resolve | validate | upload | send | permission | link`
- `reasonCode`
- `message`

`sendRequestedFiles()` 汇总结构化结果。成功时保持安静或只给简短摘要；失败时发送一条可读摘要，例如：

```text
文件发送失败：report.zip（8.4 MB）
渠道：飞书
阶段：upload
原因：飞书聊天附件最大 30 MB；已配置 Drive 中转后可发送为云空间链接。
```

## 微信方案

微信当前上传流程没有项目内 5MB 限制。改动集中在稳定性和错误透明化：

- CDN 上传增加有限重试，优先覆盖网络抖动、5xx、缺失响应头等可重试错误。
- 保留现有尺寸字段语义：文件 `len` 用原始尺寸，CDN `filesize` 用加密后尺寸。
- 上传失败抛出带阶段和原因的错误，由 Bridge 汇总给用户。
- 不添加 5MB 人工限制。

## 飞书方案

飞书 IM 附件按官方限制预检：

- 图片消息最大 10 MB。
- 普通文件消息最大 30 MB。
- 图片超过 10 MB 且不超过 30 MB 时，降级为普通文件发送。
- 普通文件超过 30 MB 时，走 Drive 中转。

Drive 中转使用机器人 AppID/AppSecret 的应用身份：

- 新增配置 `FEISHU_DRIVE_FOLDER_TOKEN`。
- 该 token 是飞书云空间中转文件夹 URL 的 `/drive/folder/` 后缀 token。
- 中转文件夹必须给机器人所在群可编辑权限，让应用身份能上传。这个群只作为飞书权限配置手段，不代表 Chat-Codex 启用群聊收发，也不把文件发到该群。
- 上传完成后，程序从当前消息事件里的 `sender.sender_id.open_id` 取当前请求者 open_id。
- 程序调用 Drive 权限 API，只给当前请求者授予该文件 `view` 权限。
- 程序把云空间文件链接发回当前 `chat_id`。

安全限制：

- `open_id` 不允许用户配置或覆盖，只能来自当前消息事件。
- Drive 授权不能直接信任 `ChannelTarget.recipient.id`，因为现有映射可能在缺少 open_id 时 fallback 到 user_id 或 union_id；实现时必须从飞书原始事件提取 open_id，并通过 `ChannelTarget.context` 或 `SendOptions.metadata` 显式传递。
- 没有 `open_id` 时不做 Drive 授权。
- 没有 `FEISHU_DRIVE_FOLDER_TOKEN` 时不尝试 Drive 上传，直接给配置提示。
- 不支持“发给张三”“发到某个群”。

配置方式：

```env
FEISHU_DRIVE_FOLDER_TOKEN=WImjfx4RnlAV6tdHS4lcDTkKnRc
```

管理员操作：

1. 在飞书建一个文件中转群。
2. 把机器人拉进群。
3. 在云空间建一个中转文件夹。
4. 把文件夹共享给这个群，并给可编辑权限。
5. 从文件夹 URL 的 `/drive/folder/` 后复制 token 到 `FEISHU_DRIVE_FOLDER_TOKEN`；也可在飞书私聊机器人时只发送该文件夹链接，让机器人自动保存当前账号的中转文件夹配置。

## 数据流

1. 用户发送消息。
2. Bridge 判断是否是显式 `/sendfile` 或自然语言文件发送授权。
3. 若授权，当前 turn 设置 `sendFile: true`，并向后端注入现有文件声明协议。
4. 后端最终回复 `BRIDGE_SEND_FILE: <absolute path>`。
5. Bridge 提取并剥离协议行。
6. Bridge 校验路径存在、数量限制、文件类型和大小。
7. Bridge/Target 保留当前飞书事件的 open_id，供飞书 Drive 权限 API 使用。
8. 渠道适配器发送媒体；飞书超限时转 Drive 链接。
9. Drive 上传返回 file_token 后，适配器获取或生成可访问链接；授权当前 open_id 后发回当前 chat_id。
10. Bridge 反馈结构化结果。

## 测试

新增或扩展测试：

- 自然语言“把 D:\tmp\a.pdf 发给我”会启用 sendfile。
- 普通“分析 D:\tmp\a.pdf”不会启用 sendfile。
- “发给张三/发到群”不会启用 sendfile。
- `/sendfile` 旧行为保持不变。
- Bridge 对单文件失败输出文件名、大小、阶段、原因。
- 微信 CDN 上传可重试错误会重试，最终成功不报失败。
- 微信 CDN 上传最终失败会带 `upload` 阶段原因。
- 飞书图片 >10 MB 且 <=30 MB 降级普通文件。
- 飞书文件 >30 MB 且未配置 Drive token 时返回配置提示。
- 飞书 Drive 路径只给当前消息 `open_id` 授权。
- 飞书缺少 `open_id` 时不尝试授权或发送链接。
- 飞书映射 fallback 到 `user_id/union_id` 时，Drive 授权必须失败并提示缺少 open_id。

## 文档与版本

这是用户可见新能力，需要：

- README 和 `docs/technical-design.zh-CN.md` 更新自然语言 sendfile 行为。
- 飞书文档补充 `FEISHU_DRIVE_FOLDER_TOKEN` 配置和中转群操作步骤。
- 版本号按 minor bump，从 `0.1.8` 升到 `0.2.0`。
