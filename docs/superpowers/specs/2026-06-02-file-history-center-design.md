# 文件历史中心设计

日期：2026-06-02

## 背景

当前文件上下文分散在两处：

- `Bridge` 只记录最近一次 assistant 可见回复中的本地 deliverable，用于“发给我”触发 sendfile 审批。
- `FeishuAdapter` 单独记录最近一次飞书中转文件夹列表，用于“下载第 2 个到桌面”等飞书云盘操作。

这种分散状态容易导致自然语言引用错位。例如用户先提到一张本地图片，再查看飞书中转云盘，随后说“把云盘里的图片保存到桌面”，系统可能仍优先使用旧的本地图片上下文，或者把飞书云盘列表遗忘给后端 agent 处理。

## 目标

- 建立统一的最近文件上下文，覆盖 agent 生成文件、微信/飞书上传附件、飞书中转云盘列表项、飞书云盘下载后的本地文件。
- 支持 `/files` 查看当前会话最近文件，显示序号、来源、文件名、大小、路径或云盘链接。
- 支持自然语言引用最近文件，例如“发给我”“把刚才那个发给我”“下载第 2 个到桌面”“把云盘里的图片保存到桌面”。
- 保持安全边界：发送给用户仍必须弹 sendfile 审批卡；飞书云盘下载仍必须弹下载确认卡。
- 让 Codex 和 Claude Code 两个入口共用同一套文件历史规则，显示文案按入口保持现有 `Codex/Claude Code` 命名方式。

## 非目标

- 不做跨进程持久化；第一版使用内存 TTL。
- 不支持把文件转发给第三方用户或群。
- 不让机器人访问用户个人云盘，只处理已配置中转文件夹和用户显式发来的飞书云盘文件链接。
- 不把普通互联网链接自动加入文件历史；只有已物化为本地文件、聊天附件或飞书云盘文件项时才记录。
- 不改变 sendfile 内部协议，继续隐藏 `BRIDGE_SEND_FILE:`。

## 数据模型

新增 `FileHistoryStore`，按 `routeKey` 隔离。

每条记录包含：

- `id`：内部稳定 id。
- `routeKey`：会话路由。
- `source`：`agent_local | inbound_attachment | feishu_drive | feishu_drive_download`。
- `kind`：`image | file | video | voice | unknown`。
- `name`：展示名。
- `sizeBytes`：可选。
- `localPath`：本地文件存在时填写。
- `url`：飞书云盘或远程来源链接。
- `feishuFileToken`：飞书云盘普通文件 token。
- `createdAt`、`expiresAt`。
- `messageId`：来源消息，可选。

列表按最新记录靠前展示，但自然语言序号默认对应用户最近看到的 `/files` 或飞书中转列表顺序，避免“第 2 个”在列表刷新后突然改变。

## 组件

### FileHistoryStore

职责：

- `recordLocalDeliverables(routeKey, media[])`
- `recordInboundAttachments(routeKey, attachments[])`
- `recordFeishuDriveListing(routeKey, files[])`
- `recordFeishuDriveDownload(routeKey, localPath, metadata)`
- `list(routeKey)`
- `resolveReference(routeKey, text, options)`
- `clearExpired(routeKey)`

解析结果分为：

- `local_media`：可进入 sendfile 审批。
- `feishu_drive_file`：可进入飞书下载确认。
- `ambiguous`：需要提示用户用文件名或序号。
- `none`：交给正常消息流程。
- `unsupported`：类型不支持下载或发送。

### Bridge 集成

`Bridge` 负责统一本地文件和聊天附件历史：

- assistant 可见回复产生本地 deliverable 后记录到 `FileHistoryStore`。
- 用户上传的微信/飞书附件下载成功后记录到 `FileHistoryStore`。
- `/files` 命令返回当前 route 的最近文件列表。
- “发给我/把刚才那个发给我”先查 `FileHistoryStore`，命中本地文件后直接弹 sendfile 审批卡，不再启动 Codex/Claude Code。

### FeishuAdapter 集成

飞书中转文件夹仍由 `FeishuAdapter` 直接调用 Drive API，但列表结果同步写入同一个文件历史抽象：

- “看看中转站里有什么文件”列出文件后，记录 `feishu_drive` 项。
- “下载第 2 个到桌面”优先从最近展示的文件顺序解析。
- “把云盘里的图片保存到桌面”只匹配 `feishu_drive` 图片，不复用旧本地图片。
- 下载成功后把本地路径记录为 `feishu_drive_download`，之后用户可说“把刚下载的文件发给我”。

第一版可让 `FeishuAdapter` 使用同名 store 类的实例，不要求把飞书 Drive 行为搬进 `Bridge`，避免大改通道边界。

## 数据流

### agent 生成文件后发送给用户

1. 用户让 Codex/Claude Code 生成文件。
2. assistant 可见回复包含本地路径。
3. `Bridge` 记录本地 deliverable。
4. 用户说“发给我”。
5. `Bridge` 从 `FileHistoryStore` 解析到最新本地文件。
6. 弹 sendfile 审批卡。
7. 用户确认后发送。

### 飞书中转云盘下载到桌面

1. 用户在飞书说“看看中转站里有什么文件”。
2. `FeishuAdapter` 列出前 20 项并记录展示顺序。
3. 用户说“下载第 2 个到桌面”。
4. `FeishuAdapter` 从 `FileHistoryStore` 最近展示顺序解析第 2 项。
5. 弹飞书下载确认卡。
6. 用户确认后下载到桌面。
7. 下载成功的本地文件写回历史。

### 用户上传附件后再引用

1. 用户通过微信或飞书发送图片/文件。
2. 通道下载成功并生成 `localPath`。
3. `Bridge` 记录为 `inbound_attachment`。
4. 用户后续说“把刚才那张图发给我”时，命中该附件并弹 sendfile 审批卡。

## 冲突与优先级

解析时按以下优先级：

1. 显式序号：`第 2 个`、`2号`。
2. 显式来源：`云盘/中转站` 只匹配飞书云盘项；`本地/刚下载` 只匹配本地文件。
3. 类型词：`图片/照片/pdf/ppt`。
4. 文件名或扩展名。
5. 最近单项兜底：仅当候选唯一时启用。

如果候选超过一个，不自动选择，返回简短澄清列表。

## 安全与错误处理

- sendfile 仍必须审批；自然语言命中历史只创建审批请求，不直接发送。
- 飞书云盘下载仍必须审批；确认者必须是原请求用户。
- 缺少本地路径、路径不存在或文件不可读时，不发送，并从历史中标记失效。
- 飞书云盘项不是普通文件时提示暂不支持。
- 过期历史不参与解析。
- 群聊仍遵守现有安全策略，不新增群聊文件外发能力。

## 命令与文案

新增 `/files`：

```text
最近文件：
1. [飞书云盘] demo.png，2.1 MB
   https://tenant.feishu.cn/file/box_file_xxx
2. [本地] report.pdf，418 KB
   D:\tmp\report.pdf
```

无记录时：

```text
当前没有可引用的最近文件。
```

文案避免“当前后端”等抽象说法。涉及入口时使用现有 `Codex` 或 `Claude Code` 显示名。

## 测试

新增或扩展测试：

- `FileHistoryStore` 记录、过期、按 route 隔离。
- `/files` 展示本地文件、聊天附件、飞书云盘项。
- assistant 提到本地图片后，“发给我”弹 sendfile 审批，不启动后端。
- 飞书中转列表后，“下载第 2 个到桌面”按列表顺序解析。
- 飞书中转列表后，“把云盘里的图片保存到桌面”不复用旧本地图片。
- 用户上传附件后，下一条普通问题仍正常进入 Codex/Claude Code；只有明确发送/保存意图才命中文件历史。
- 多候选图片时返回澄清，不自动拿最近一张。
- 普通互联网链接不进入文件历史，不触发 sendfile。
- 微信和飞书附件下载成功都记录；下载失败不记录为可用项。
- sendfile 审批卡和飞书下载确认卡仍要求原请求用户确认。

## 文档与版本

这是用户可见新功能，实施时需要：

- README/README.zh-CN/README.en 同步说明 `/files` 和最近文件引用。
- 相关飞书文档补充中转云盘文件进入最近文件历史。
- 版本号按 minor bump，从 `0.3.3` 升到 `0.4.0`，同步 `package.json` 和 `npm-shrinkwrap.json`。
