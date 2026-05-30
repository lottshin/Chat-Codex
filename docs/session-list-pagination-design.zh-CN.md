# Session 列表展示与分页设计

## 背景

聊天侧现在已经支持：

- `/sessions`
- `/sessions all`
- `/all-sessions`
- `/resume [session|编号]`
- `/use [session|编号]`

但当前展示和选择逻辑分散在两条路径里：

- `/sessions` 和 `/sessions all` 走 `BridgeStatusText.sessionsText()`。
- `/resume` 和 `/use` 不带参数时走 `BridgeSessionFlow.sessionChoicesForRoute()`。

这导致同一批 session 在不同命令里的排序、字段、标题和可选状态展示不完全一致。`/sessions all` 在历史 session 很多时还会一次性刷出很长消息，不适合微信、飞书这类聊天渠道。

本文只设计聊天侧 session 列表和分页交互，不改 Codex session 发现、owner 归属、安全策略和 TUI 页面。

## 当前行为确认

### `/sessions`

`/sessions` 当前等价于：

```ts
sessions(message.routeKey)
```

它只展示当前 route 相关的 session。这里的“当前 route 相关”不是单纯“当前 active session”，而是当前聊天上下文已经拥有、绑定过或本地状态仍记录为当前 route 的 session。

当前数据来源：

- `MemoryStateStore.listSessions(routeKey)`
- `CodexAdapter.listSessions(routeKey)`

输出标题是：

```text
当前上下文 Codex 会话:
```

### `/sessions all`

`/sessions all` 和 `/all-sessions` 当前等价于：

```ts
sessions(undefined)
```

它展示本机可发现的所有 Codex 历史 session。真实 adapter 会从本地 Codex 历史记录中发现 session，包括当前 Bridge 进程内记录和 Codex 历史文件/索引里的 session。

输出标题是：

```text
全部可发现 Codex 会话:
```

### `/resume` 和 `/use`

`/resume` 与 `/use` 当前共用同一套绑定逻辑。

- 带 session id：尝试直接绑定该 session。
- 带数字：按当前实时计算出来的选择列表索引绑定。
- 不带参数：进入编号选择模式，用户回复编号完成绑定，回复“取消”退出。

选择列表当前会合并：

- `MemoryStateStore.listSessions()`
- `CodexAdapter.listSessions(undefined)`

并过滤掉已被其它 route 拥有的 session。排序规则是：

1. 当前 active session 排最前。
2. 其它 session 按 `updatedAt` 倒序。

当前问题是：`/resume`/`/use` 的选择列表和 `/sessions all` 的展示列表不是同一个格式化器，也不是同一套分页状态。

## 问题

1. **展示字段顺序不稳定**

   当前 `/sessions` 行内混合 `id`、状态、时间、标题、cwd。用户真正需要先看的是 session id、最近活跃时间、标题。

2. **标题和路径容易撑开聊天窗口**

   标题、cwd 可能很长。当前虽然部分位置会截断标题，但 `/sessions`、`/resume`、`/use` 没有统一宽度和层级。

3. **`/sessions all` 缺少分页**

   Codex 历史 session 很多时，一次性输出会刷屏，也可能触发渠道消息长度限制。

4. **编号选择和列表展示不一致**

   用户可能先看 `/sessions all`，再发送 `/use 3`。但 `/use 3` 当前按另一套实时选择列表解释，容易和用户看到的第 3 项不一致。

5. **命令别名不完整**

   用户自然会尝试 `/session`。当前只有 `/sessions` 和 `/all-sessions`，设计上应让 `/session` 与 `/sessions` 等价。

## 设计目标

- `/sessions` 和 `/session` 完全等价。
- `/sessions all` 和 `/session all` 完全等价。
- `/all-sessions` 保留为兼容别名。
- `/sessions` 默认只展示当前 route 相关 session。
- `/sessions all` 展示本机可发现的所有历史 session，但必须分页。
- `/resume` 和 `/use` 的选择列表复用同一套 session 列表模型、排序和格式化。
- 展示字段顺序统一为：Session、最近活跃、标题。
- 可选的状态、工作目录、当前标记、不可选原因放在缩进子项里。
- 不改变 session owner 规则：已被其它 route 拥有的 session 不能被当前 route 绑定。
- 不改变 busy guard：Codex 正在执行时，`/resume`、`/use` 和编号选择仍属于会话绑定修改，必须被当前 route 阻断。

## 统一数据模型

建议新增 Bridge 侧纯展示模块，例如：

```text
src/bridge/session-list.ts
```

核心类型：

```ts
type SessionListScope = "route" | "all" | "selectable";

interface SessionListItem {
  id: string;
  current: boolean;
  selectable: boolean;
  ownerRouteKey?: string;
  unavailableReason?: string;
  title?: string;
  cwd?: string;
  status: CodexSessionStatus;
  updatedAt: string;
  source: "state" | "codex" | "merged";
}

interface SessionListPage {
  scope: SessionListScope;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: SessionListItem[];
}
```

数据合并规则：

1. 以 `session.id` 去重。
2. Bridge state 里的 active/current/owner 信息优先。
3. Codex 历史里的 title、cwd、updatedAt 可补充 state 缺失字段。
4. 如果同一 session 两边都有 `updatedAt`，取较新的一个作为最近活跃时间。
5. 如果 session 被其它 route 拥有：
   - `/sessions all` 可以展示，但必须标注“已绑定到其它聊天”，默认不可选。
   - `/resume`/`/use` 选择列表默认隐藏或列入“不可选”分组，不能允许编号绑定。

排序规则：

1. 当前 active session 排最前。
2. 可选 session 排在不可选 session 前。
3. 其余按最近活跃时间倒序。
4. 时间相同按 session id 升序，保证稳定。

## 展示格式

聊天渠道里不要用宽表格。微信和飞书 markdown 对等宽表格支持并不稳定，长标题也容易破坏对齐。推荐使用编号列表加缩进字段：

```md
**Codex 会话**

- 范围: 当前聊天
- 页码: `1 / 1`
- 数量: `2`

1. Session: `019e3037-42f4-72e0-a5b5-a85ff5140eb6`（当前）
   - 最近活跃: `2026-05-17 23:25:10（Asia/Shanghai）`
   - 标题: 修复微信进度投递
   - 状态: 运行中
   - 工作目录: `.../codex-openclaw-wechat`
2. Session: `019df...`
   - 最近活跃: `2026-05-17 21:10:00（Asia/Shanghai）`
   - 标题: 新增飞书渠道
   - 状态: 空闲
```

字段约束：

- `Session` 永远第一行，且必须保留完整 session id，方便复制。
- Claude Code 会话优先把 Claude 原生 session UUID 放在 `Session` 行；如果有旧的 bridge-local id，则只在辅助字段显示 `Bridge session`，用于兼容旧绑定和排查。
- `最近活跃` 永远第二行，使用本机时区展示。
- `标题` 永远第三行，没有标题时显示 `无标题`。
- `状态`、`工作目录`、`不可选原因` 是辅助字段。
- 标题最大建议 60 字符。
- 工作目录用 `formatCompactPath()` 压缩，避免长路径刷屏。

## 命令设计

### 列表命令

```text
/sessions
/session
```

展示当前 route 相关 session，第一页。

`/help` 里的描述应明确：`/sessions` 不是只看当前 active session，而是列出当前聊天上下文拥有、绑定过或本地记录相关的 Codex 会话。

```text
/sessions all
/session all
/all-sessions
```

展示全部可发现 session，第一页。

`/help` 里的描述应明确：`/sessions all` 是列出本机全部可发现的 Codex 历史会话，避免用户误以为只看当前聊天。

分页参数：

```text
/sessions 2
/sessions next
/sessions prev
/sessions all 2
/sessions all next
/sessions all prev
```

说明：

- `/sessions 2` 表示当前 route session 列表第 2 页。
- `/sessions all 2` 表示全量 session 列表第 2 页。
- `next` / `prev` 依赖当前 route 最近一次 session list 状态；没有状态时按第一页处理。
- 页码超出范围时应 clamp 到最后一页，并在顶部提示。

### 选择命令

```text
/resume
/use
```

进入可选 session 的分页选择模式。第一页展示与 `/sessions all` 相同字段，但只允许选择当前 route 可绑定的 session。

分页交互：

```text
回复编号选择；回复 n 下一页；回复 p 上一页；回复 取消 退出。
```

支持中文别名：

- 下一页：`n`、`next`、`下一页`
- 上一页：`p`、`prev`、`上一页`
- 退出：`取消`、`退出`、`cancel`、`q`、`quit`

选择模式里的编号只代表当前页的编号。这样每页都是 `1..pageSize`，不会出现第 27 项需要用户回复 `27` 的长列表体验。

直接命令仍支持：

```text
/use <session-id>
/resume <session-id>
```

建议保留 `/use 3` 和 `/resume 3` 的兼容行为，但后续文案应引导用户优先在选择模式里回复编号，避免它和 `/sessions all` 某页编号产生歧义。

## 分页状态

建议新增 route 级列表状态：

```ts
interface SessionListState {
  scope: "route" | "all" | "selectable";
  page: number;
  pageSize: number;
  createdAt: number;
  items: SessionListItem[];
}
```

状态保存位置：

- 普通 `/sessions` / `/sessions all`：保存最近一次列表状态，用于 `next` / `prev`。
- `/resume` / `/use` 选择模式：保存选择状态，用于编号、`n`、`p`、取消。

过期策略：

- 列表状态建议 10 分钟过期。
- 过期后收到 `next` / `prev`，重新生成第一页并提示“列表已刷新”。
- 选择状态过期后收到编号，提示重新发送 `/resume` 或 `/use`。

默认页大小：

- 聊天渠道默认 `10`。
- 如果未来某渠道消息长度更紧，可通过 channel capability 或 delivery policy 配置更小 page size。

## `/sessions` 与 `/resume` 的关系

`/sessions` 是查看，不进入选择模式。

`/resume` / `/use` 是选择或绑定，进入选择模式。

原因：

- `/sessions` 是只读命令，busy route 下也应该能即时查看。
- `/resume` / `/use` 会改变当前 route 的 active session，busy route 下必须阻断。
- 如果 `/sessions` 也进入选择模式，用户只想查看时可能误触切换。

可在 `/sessions` 底部加提示：

```text
发送 /use 进入切换选择；发送 /resume <session-id> 直接绑定。
```

## 多渠道与权限边界

本设计不改变已有多渠道 session owner 规则。

- 当前 route 已拥有的 session 可以显示和选择。
- 未被任何 route 拥有的历史 session 可以被当前 route 认领。
- 已被其它 route 拥有的 session 不允许普通 `/use` / `/resume` 绑定。
- `/sessions all` 是否展示其它 route 拥有的 session，沿用当前行为；如果后续要做管理员权限或脱敏，应单独设计，不和分页改造混在一起。

## 实施建议

第一步：抽统一 session list builder。

- 合并 state 和 Codex adapter session。
- 输出稳定排序后的 `SessionListItem[]`。
- 覆盖当前 route、全部历史、可选 session 三种 scope。

第二步：抽统一 formatter。

- `/sessions`、`/sessions all`、`/resume`、`/use` 共用。
- 格式固定为 Session、最近活跃、标题、状态、目录。

第三步：接入分页。

- `/sessions [page|next|prev]`
- `/sessions all [page|next|prev]`
- `/resume` / `/use` 选择模式里的 `n` / `p`。

第四步：补 alias。

- `/session` 等价 `/sessions`。
- `/session all` 等价 `/sessions all`。
- 保留 `/all-sessions`。

## 测试计划

单元测试：

- session list builder 去重、字段合并、owner 过滤。
- 当前 active session 永远置顶。
- 最近活跃时间倒序。
- 分页总页数、页码 clamp、空列表。
- formatter 截断长标题、压缩 cwd、保持 session id 完整。

集成测试：

- `/sessions` 只展示当前 route 相关 session。
- `/session` 与 `/sessions` 输出一致。
- `/sessions all` 分页展示大量 session。
- `/sessions all next` / `prev` 按当前 route 状态翻页。
- `/resume` / `/use` 使用同一格式进入选择模式。
- 选择模式回复 `n` / `p` 翻页，回复编号只选择当前页项目。
- busy route 下 `/sessions` 仍可查看，`/resume` / `/use` 和编号选择仍被拒绝。
- 已被其它 route 拥有的 session 不可被当前 route 选择。

## 非目标

- 不在本设计里改 TUI session 选择页。
- 不改变 Codex 历史 session 的发现方式。
- 不改变 session owner 唯一归属规则。
- 不引入跨 route 迁移 session 的管理员命令。
- 不把 `/sessions all` 改成管理员能力；权限/脱敏后续单独讨论。
