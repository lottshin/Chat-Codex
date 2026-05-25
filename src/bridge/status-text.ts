import type { ApprovalManager } from "../approvals/approval-manager.js";
import { backendDisplayName, backendSupportsFeature, type AiBackend, type BackendCommandFeature, type CommandNamespaceProfile } from "../backend/metadata.js";
import type { CodexRunPolicyStatus } from "../codex/codex-cli.js";
import type {
  CodexAdapter,
  CodexCollaborationMode,
  CodexModelOption,
  CodexModelPolicy,
  CodexProgressKind,
  CodexSessionModelInfo,
  CodexSessionStatus,
} from "../codex/types.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelMessage } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { ContextRefreshEffectivePolicy } from "../context-refresh/types.js";
import { formatContextRefreshEffectivePolicyForUser } from "../context-refresh/types.js";
import { formatElapsedDurationSince } from "../time/display-time.js";
import type { CompactState, InitialRouteBinding, ProgressDeliveryMode, SessionListScope, SessionListState } from "./bridge-types.js";
import {
  formatApprovalSupport,
  formatChannelStateForStatus,
  formatCodexStatus,
  formatCollaborationModeForStatus,
  formatContextUsageLines,
  formatConversationContext,
  formatGoalStatusLines,
  formatModelInfo,
  formatModelInfoForStatus,
  formatModelOptionLine,
  formatModelPolicy,
  formatModelPolicyForStatus,
  formatPeerContext,
  formatPendingApprovalStatus,
  formatProgressLabelForStatus,
  formatProgressModeForStatus,
  formatRunPolicy,
  formatRunPolicyForStatus,
  formatUnboundSessionForStatus,
} from "./formatters.js";
import {
  buildSessionList,
  formatSessionListPage,
  pageNumberFromText,
  paginateSessionList,
  sessionListStateExpired,
  sessionPageAction,
} from "./session-list.js";
import type { PendingPlanWorkflow } from "./plan-workflow.js";
import { formatPlanWorkflowChoices } from "./plan-workflow.js";

function commandForProfile(_commandProfile: CommandNamespaceProfile, command: string): string {
  return command;
}

export interface BridgeStatusTextOptions {
  backend?: AiBackend;
  commandProfile: CommandNamespaceProfile;
  channels: ChannelRegistry;
  codex: CodexAdapter;
  state: MemoryStateStore;
  approvals: ApprovalManager;
  routeQueueLength(routeKey: string): number;
  deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy;
  shouldConsumePendingInitialRouteBinding(message: ChannelMessage): boolean;
  pendingInitialRouteBinding(): InitialRouteBinding | undefined;
  isRouteBusy(routeKey: string): boolean;
  routeSteerPendingCount(routeKey: string): number;
  pendingMediaCount(routeKey: string): number;
  compactStateForRoute(routeKey: string): CompactState;
  collaborationModeForRoute(routeKey: string, sessionId?: string): CodexCollaborationMode;
  progressModeFor(routeKey: string): ProgressDeliveryMode;
  contextRefreshFor(routeKey: string): ContextRefreshEffectivePolicy;
  runPolicyStatus(sessionId?: string): CodexRunPolicyStatus | undefined;
  planWorkflowForRoute(routeKey: string): PendingPlanWorkflow | undefined;
}

export class BridgeStatusText {
  private readonly backend?: AiBackend;
  private readonly commandProfile: CommandNamespaceProfile;
  private readonly channels: ChannelRegistry;
  private readonly codex: CodexAdapter;
  private readonly state: MemoryStateStore;
  private readonly approvals: ApprovalManager;
  private readonly routeQueueLength: BridgeStatusTextOptions["routeQueueLength"];
  private readonly deliveryPolicyFor: BridgeStatusTextOptions["deliveryPolicyFor"];
  private readonly shouldConsumePendingInitialRouteBinding: BridgeStatusTextOptions["shouldConsumePendingInitialRouteBinding"];
  private readonly pendingInitialRouteBinding: BridgeStatusTextOptions["pendingInitialRouteBinding"];
  private readonly isRouteBusy: BridgeStatusTextOptions["isRouteBusy"];
  private readonly routeSteerPendingCount: BridgeStatusTextOptions["routeSteerPendingCount"];
  private readonly pendingMediaCount: BridgeStatusTextOptions["pendingMediaCount"];
  private readonly compactStateForRoute: BridgeStatusTextOptions["compactStateForRoute"];
  private readonly collaborationModeForRoute: BridgeStatusTextOptions["collaborationModeForRoute"];
  private readonly progressModeFor: BridgeStatusTextOptions["progressModeFor"];
  private readonly contextRefreshFor: BridgeStatusTextOptions["contextRefreshFor"];
  private readonly runPolicyStatus: BridgeStatusTextOptions["runPolicyStatus"];
  private readonly planWorkflowForRoute: BridgeStatusTextOptions["planWorkflowForRoute"];
  private readonly sessionListStates = new Map<string, SessionListState>();

  constructor(options: BridgeStatusTextOptions) {
    this.backend = options.backend;
    this.commandProfile = options.commandProfile;
    this.channels = options.channels;
    this.codex = options.codex;
    this.state = options.state;
    this.approvals = options.approvals;
    this.routeQueueLength = options.routeQueueLength;
    this.deliveryPolicyFor = options.deliveryPolicyFor;
    this.shouldConsumePendingInitialRouteBinding = options.shouldConsumePendingInitialRouteBinding;
    this.pendingInitialRouteBinding = options.pendingInitialRouteBinding;
    this.isRouteBusy = options.isRouteBusy;
    this.routeSteerPendingCount = options.routeSteerPendingCount;
    this.pendingMediaCount = options.pendingMediaCount;
    this.compactStateForRoute = options.compactStateForRoute;
    this.collaborationModeForRoute = options.collaborationModeForRoute;
    this.progressModeFor = options.progressModeFor;
    this.contextRefreshFor = options.contextRefreshFor;
    this.runPolicyStatus = options.runPolicyStatus;
    this.planWorkflowForRoute = options.planWorkflowForRoute;
  }

  async statusText(message: ChannelMessage): Promise<string> {
    const routeKey = message.routeKey;
    const channelStatus = await this.channels.getStatus(message.channelId);
    const binding = this.state.getBinding(routeKey);
    const pendingInitialBinding = !binding
      ? this.state.getPendingBindingForMessage(message)?.binding
        ?? (this.shouldConsumePendingInitialRouteBinding(message) ? this.pendingInitialRouteBinding() : undefined)
      : undefined;
    const localSession = binding ? this.state.getSession(binding.sessionId) : undefined;
    const adapterStatus: CodexSessionStatus = binding
      ? await this.codex.getStatus(binding.sessionId)
      : { type: "unknown", detail: "no active session" };
    const statusFromAdapterOrLocal: CodexSessionStatus = adapterStatus.type === "unknown" && localSession
      ? localSession.status
      : adapterStatus;
    const sessionStatus = withLocalStartedAt(statusFromAdapterOrLocal, localSession?.status);
    const approvals = this.approvals.list(routeKey);
    const planWorkflow = this.planWorkflowForRoute(routeKey);
    const compactState = this.compactStateForRoute(routeKey);
    const compactRunning = compactState.type === "running";
    const workerRunning = this.isRouteBusy(routeKey) || compactRunning;
    const policyStatus = this.runPolicyStatus(binding?.sessionId);
    const policy = policyStatus?.policy ?? this.codex.getRunPolicy?.(binding?.sessionId);
    const modelPolicy = this.codex.getModelPolicy?.(binding?.sessionId);
    const deliveryPolicy = this.deliveryPolicyFor(message);
    const goal = binding && this.codex.getGoal
      ? await this.codex.getGoal(binding.sessionId).catch(() => undefined)
      : undefined;
    const sessionLines = [
      `- 当前会话: ${binding ? `\`${binding.sessionId}\`` : formatUnboundSessionForStatus(pendingInitialBinding)}`,
      binding?.backend ? `- 后端: \`${binding.backend}\`` : undefined,
      binding?.backend === "claude" && localSession?.backendSessionId ? `- Claude session: \`${localSession.backendSessionId}\`` : undefined,
      `- 运行状态: ${formatCodexStatus(sessionStatus)}`,
      `- 当前模型: ${formatModelInfoForStatus(sessionStatus.model)}`,
      ...formatContextUsageLines(sessionStatus.context),
      binding ? `- 工作目录: \`${localSession?.session.cwd ?? "未知"}\`` : undefined,
    ];
    const runtimeLines = [
      `- 处理状态: ${workerRunning ? "正在处理" : "空闲"}`,
      formatCurrentTurnDurationLine(sessionStatus),
      `- 排队消息: \`${this.routeQueueLength(routeKey)}\``,
      `- 待投递补充消息: \`${this.routeSteerPendingCount(routeKey)}\``,
      `- 待处理附件: \`${this.pendingMediaCount(routeKey)}\``,
      ...formatCompactStatusLines(compactState, this.commandProfile),
      `- 协作模式: ${formatCollaborationModeForStatus(this.collaborationModeForRoute(routeKey, binding?.sessionId))}`,
      `- 上下文刷新: ${formatContextRefreshEffectivePolicyForUser(this.contextRefreshFor(routeKey))}`,
      ...formatGoalStatusLines(goal),
      `- 待审批: \`${approvals.length}\``,
      ...formatPendingApprovalStatus(approvals.at(-1)),
      ...formatPendingPlanWorkflowStatus(planWorkflow, this.commandProfile),
      this.progressStatusLine(routeKey, deliveryPolicy),
      modelPolicy ? `- 模型覆盖: ${formatModelPolicyForStatus(modelPolicy)}` : undefined,
      policy ? `- 权限模式: ${formatRunPolicyForStatus(policy)}` : undefined,
      policyStatus && !policyStatus.interactiveApprovals ? `- 审批入口: ${formatApprovalSupport(policyStatus)}` : undefined,
      formatStatusNextStep({
        binding: Boolean(binding),
        workerRunning,
        compactState,
        pendingApprovals: approvals.length,
        hasPlanWorkflow: Boolean(planWorkflow),
      }),
      compactRunning ? "- 可用操作: 等待上下文压缩完成；当前不支持中途取消 `/compact`，可发送 `/status` 刷新查看" : undefined,
      workerRunning && binding && !compactRunning ? "- 可用操作: 发送 `/stop` 终止当前任务" : undefined,
    ];
    const channelLines = [
      `- 渠道: \`${channelStatus.channelId}\``,
      `- 连接状态: ${formatChannelStateForStatus(channelStatus.state)}`,
      channelStatus.lastError ? `- 最近错误: ${channelStatus.lastError}` : undefined,
    ];
    return [
      `**${backendDisplayName(this.backend)} 状态**`,
      "",
      ...formatStatusSection("会话", sessionLines),
      ...formatStatusSection("运行", runtimeLines),
      ...formatStatusSection("渠道", channelLines),
    ].join("\n");
  }

  async usageText(message: ChannelMessage): Promise<string> {
    const routeKey = message.routeKey;
    const binding = this.state.getBinding(routeKey);
    if (!binding) {
      return [
        `**${backendDisplayName(this.backend)} 使用量**`,
        "",
        "- **会话**",
        "  - 当前会话: 未绑定",
        "  - 当前会话暂无 token 用量数据。",
        "  - 下一步：发送普通消息创建会话，或发送 `/new` / `/resume` 明确选择会话。",
      ].join("\n");
    }

    const localSession = this.state.getSession(binding.sessionId);
    const adapterStatus = await this.codex.getStatus(binding.sessionId).catch(() => localSession?.status ?? { type: "unknown" as const, detail: "status unavailable" });
    const sessionStatus = withLocalStartedAt(adapterStatus, localSession?.status);
    const compactState = this.compactStateForRoute(routeKey);
    const workerRunning = this.isRouteBusy(routeKey) || compactState.type === "running";
    const contextLines = formatContextUsageLines(sessionStatus.context);
    const usageLines = sessionStatus.context
      ? contextLines
      : ["- 当前会话暂无 token 用量数据；后端完成一轮并上报 usage 后会显示。"];

    return [
      `**${backendDisplayName(this.backend)} 使用量**`,
      "",
      "- **会话**",
      `  - 当前会话: \`${binding.sessionId}\``,
      binding.backend ? `  - 后端: \`${binding.backend}\`` : undefined,
      binding.backend === "claude" && localSession?.backendSessionId ? `  - Claude session: \`${localSession.backendSessionId}\`` : undefined,
      `  - 运行状态: ${formatCodexStatus(sessionStatus)}`,
      `  - 当前模型: ${formatModelInfoForStatus(sessionStatus.model)}`,
      "- **Token / Context**",
      ...usageLines.map((line) => `  ${line}`),
      "- **运行**",
      `  - 处理状态: ${workerRunning ? "正在处理" : "空闲"}`,
      formatCurrentTurnDurationLine(sessionStatus)?.replace(/^- /, "  - "),
      `  - 排队消息: \`${this.routeQueueLength(routeKey)}\``,
      `  - 待投递补充消息: \`${this.routeSteerPendingCount(routeKey)}\``,
      `  - 待处理附件: \`${this.pendingMediaCount(routeKey)}\``,
      `  - 上下文压缩: ${formatCompactStateForUsage(compactState)}`,
    ].filter(Boolean).join("\n");
  }

  async showText(message: ChannelMessage, args: string[] = [], commandName = "show"): Promise<string> {
    const [topic = "", ...rest] = args;
    switch (topic.toLowerCase()) {
      case "":
      case "context":
        return this.showContextText(message);
      case "status":
        return this.statusText(message);
      case "usage":
      case "token":
      case "tokens":
        return this.usageText(message);
      case "session":
      case "sessions":
        return this.sessionsText(message, rest, commandName);
      case "whoami":
      case "identity":
        return this.whoamiText(message);
      case "debug":
        return this.debugText(message);
      case "file":
      case "files":
      case "attachments":
        return this.showFilesText(message);
      case "approval":
      case "approvals":
        return this.showApprovalsText(message);
      case "plan":
        return this.showPlanText(message);
      default:
        return this.showHelpText(topic);
    }
  }

  private async showContextText(message: ChannelMessage): Promise<string> {
    const binding = this.state.getBinding(message.routeKey);
    const localSession = binding ? this.state.getSession(binding.sessionId) : undefined;
    const sessionStatus: CodexSessionStatus = binding
      ? await this.codex.getStatus(binding.sessionId).catch(() => localSession?.status ?? { type: "unknown", detail: "status unavailable" })
      : { type: "unknown", detail: "no active session" };
    const policyStatus = this.runPolicyStatus(binding?.sessionId);
    const policy = policyStatus?.policy ?? this.codex.getRunPolicy?.(binding?.sessionId);
    const modelPolicy = this.codex.getModelPolicy?.(binding?.sessionId);
    const deliveryPolicy = this.deliveryPolicyFor(message);
    const approvals = this.approvals.list(message.routeKey);
    const planWorkflow = this.planWorkflowForRoute(message.routeKey);
    return [
      `**${backendDisplayName(this.backend)} 上下文**`,
      "",
      "- **Route**",
      `  - Route: \`${message.routeKey}\``,
      `  - Channel: \`${message.channelId}\``,
      `  - Account: \`${message.accountId ?? "default"}\``,
      `  - Conversation: \`${formatConversationContext(message.conversation.kind, message.conversation.id, message.conversation.displayName)}\``,
      `  - Sender: \`${formatPeerContext(message.sender.id, message.sender.displayName)}\``,
      "- **Session**",
      `  - 当前会话: ${binding ? `\`${binding.sessionId}\`` : "未绑定"}`,
      binding?.backend ? `  - 后端: \`${binding.backend}\`` : undefined,
      binding?.backend === "claude" && localSession?.backendSessionId ? `  - Claude session: \`${localSession.backendSessionId}\`` : undefined,
      `  - 运行状态: ${formatCodexStatus(sessionStatus)}`,
      `  - 当前模型: ${formatModelInfoForStatus(sessionStatus.model)}`,
      ...formatContextUsageLines(sessionStatus.context).map((line) => `  ${line}`),
      binding ? `  - 工作目录: \`${localSession?.session.cwd ?? "未知"}\`` : undefined,
      "- **Runtime**",
      `  - 处理状态: ${this.isRouteBusy(message.routeKey) ? "正在处理" : "空闲"}`,
      `  - 排队消息: \`${this.routeQueueLength(message.routeKey)}\``,
      `  - 待投递补充消息: \`${this.routeSteerPendingCount(message.routeKey)}\``,
      `  - 待处理附件: \`${this.pendingMediaCount(message.routeKey)}\``,
      `  - 待审批: \`${approvals.length}\``,
      `  - 待处理计划: ${planWorkflow ? "有" : "无"}`,
      `  - 协作模式: ${formatCollaborationModeForStatus(this.collaborationModeForRoute(message.routeKey, binding?.sessionId))}`,
      `  - 上下文刷新: ${formatContextRefreshEffectivePolicyForUser(this.contextRefreshFor(message.routeKey))}`,
      `  ${this.progressStatusLine(message.routeKey, deliveryPolicy)}`,
      modelPolicy ? `  - 模型覆盖: ${formatModelPolicyForStatus(modelPolicy)}` : undefined,
      policy ? `  - 权限模式: ${formatRunPolicyForStatus(policy)}` : undefined,
      "",
      "子命令：`/show status`、`/show usage`、`/show sessions`、`/show files`、`/show approvals`、`/show plan`、`/show whoami`、`/show debug`。",
    ].filter(Boolean).join("\n");
  }

  private showFilesText(message: ChannelMessage): string {
    const count = this.pendingMediaCount(message.routeKey);
    return [
      "**文件上下文**",
      `- Route: \`${message.routeKey}\``,
      `- 待处理附件: \`${count}\``,
      count > 0
        ? "下一步：发送普通消息会把待处理附件带入本轮；发送 `/cancel` 可取消待发送附件。"
        : "暂无待处理附件。需要允许最终回复发送本地文件时，使用 `/sendfile <任务内容>`。",
    ].join("\n");
  }

  private showApprovalsText(message: ChannelMessage): string {
    const approvals = this.approvals.list(message.routeKey);
    return [
      "**审批上下文**",
      `- 待审批: \`${approvals.length}\``,
      ...formatPendingApprovalStatus(approvals.at(-1)),
      approvals.length > 0
        ? "下一步：按审批提示发送 `/OK`、`/P`、`/NO` 或数字选项。"
        : "当前没有待处理审批。",
    ].join("\n");
  }

  private showPlanText(message: ChannelMessage): string {
    const workflow = this.planWorkflowForRoute(message.routeKey);
    return [
      "**计划上下文**",
      `- 待处理计划: ${workflow ? "有" : "无"}`,
      ...formatPendingPlanWorkflowStatus(workflow, this.commandProfile),
      workflow
        ? "下一步：发送 `/plan-execute`、`/plan-edit`、`/replan` 或 `/plan-cancel`。"
        : "当前没有待处理计划。",
    ].join("\n");
  }

  private showHelpText(topic: string): string {
    return [
      `未知 /show 子命令: \`${topic}\``,
      "可用子命令: `status`、`usage`、`sessions`、`files`、`approvals`、`plan`、`whoami`、`debug`。",
    ].join("\n");
  }

  async sessionsText(message: ChannelMessage, args: string[] = [], commandName = "sessions"): Promise<string> {
    const request = parseSessionListRequest(commandName, args);
    const stateKey = sessionListStateKey(message.routeKey, request.scope);
    const existing = this.sessionListStates.get(stateKey);
    const reusableState = request.action && existing?.scope === request.scope && !sessionListStateExpired(existing.createdAt)
      ? existing
      : undefined;
    const items = reusableState
      ? reusableState.items
      : await buildSessionList({
        state: this.state,
        codex: this.codex,
        routeKey: message.routeKey,
        scope: request.scope,
      });
    const basePage = reusableState?.page ?? 1;
    const requestedPage = request.action
      ? basePage + (request.action === "next" ? 1 : -1)
      : request.page ?? 1;
    const page = paginateSessionList(items, request.scope, requestedPage);
    this.sessionListStates.set(stateKey, {
      scope: request.scope,
      page: page.page,
      pageSize: page.pageSize,
      createdAt: Date.now(),
      items,
    });
    return formatSessionListPage(page, {
      title: "会话",
      scopeLabel: request.scope === "all" ? "全部可发现" : "当前聊天",
      emptyText: request.scope === "all"
        ? "下一步：发送 `/new` 创建新会话。"
        : "下一步：发送 `/new` 创建新会话，或发送 `/resume` 进入会话选择。",
      pageCommand: request.scope === "all" ? "/sessions all" : "/sessions",
    });
  }

  whoamiText(message: ChannelMessage): string {
    return [
      "**当前通道身份**",
      `- Route: \`${message.routeKey}\``,
      `- Channel: \`${message.channelId}\``,
      `- Account: \`${message.accountId ?? "default"}\``,
      `- Conversation: \`${formatConversationContext(message.conversation.kind, message.conversation.id, message.conversation.displayName)}\``,
      `- Sender: \`${formatPeerContext(message.sender.id, message.sender.displayName)}\``,
    ].join("\n");
  }

  async debugText(message: ChannelMessage): Promise<string> {
    const status = await this.statusText(message);
    const capabilities = this.channels.getCapabilities(message.channelId);
    const sessions = this.state.listSessions(message.routeKey);
    return [
      status,
      "",
      "Capabilities:",
      JSON.stringify(capabilities, null, 2),
      "",
      `Local sessions: ${sessions.length}`,
    ].join("\n");
  }

  helpText(message?: ChannelMessage): string {
    const deliveryPolicy = this.deliveryPolicyFor(message);
    const commands: HelpCommand[] = [
      { command: "/help", description: "查看命令。" },
      { command: "/new", description: "创建新会话。" },
      { command: "/dir [path|set path|create path]", description: "查看或设置后续新会话默认工作目录；不会切换当前已绑定会话。" },
      { command: "/clear", description: "清空当前聊天上下文并创建新会话；需 `/clear confirm` 确认。" },
      { command: "/status", description: "查看状态、运行耗时、队列、审批和上下文 token 用量。" },
      { command: "/usage", description: "查看当前会话模型、上下文窗口/token 用量和基础队列状态。" },
      { command: "/show [status|usage|sessions|files|approvals|plan|whoami|debug]", description: "查看当前聊天上下文、用量、会话、文件、审批和计划信息。" },
      {
        command: "/context-refresh [off|detect|reload|inherit]",
        description: "设置当前聊天发送前是否检测本机会话上下文更新。",
        aliases: ["/ctx-refresh", "/context", "/ctx"],
        details: [
          "`/context-refresh`: 查看当前聊天设置。",
          "`/context-refresh off`: 关闭发送前检测。",
          "`/context-refresh detect`: 发现本机会话上下文外部更新时只提醒，本条消息继续发送。",
          "`/context-refresh reload`: 发现本机会话上下文外部更新时先重新加载当前 session，再发送。",
          "`/context-refresh inherit`: 清除当前聊天覆盖，跟随全局默认。",
        ],
      },
      ...(isFeishuDirectMessage(message)
        ? [{
            command: "/group on|off",
            description: "开启或关闭当前飞书机器人实例的群聊接收；每个群仍需单独配对。",
          }]
        : []),
      ...(isFeishuGroupMessage(message)
        ? [
            {
              command: "/name <名称>",
              description: "登记你在当前飞书群里的展示名；普通群聊消息需要先登记。",
            },
            {
              command: "/name",
              description: "查看你在当前飞书群里的展示名登记状态。",
            },
            {
              command: "/whoami",
              description: "查看当前飞书群员身份、登记状态和群配对状态。",
            },
          ]
        : []),
      { command: "/sessions", description: "列出当前聊天上下文拥有、绑定过或本地记录相关的会话。", aliases: ["/session"] },
      { command: "/sessions all", description: "列出本机全部可发现的历史会话。", aliases: ["/all-sessions"] },
      { command: "/resume [session|编号]", description: "恢复并绑定已有会话；不带参数时进入编号选择。" },
      { command: "/use [session|编号]", description: "切换到已有会话；不带参数时进入编号选择。" },
      { command: "/cancel", description: "取消当前等待中的交互，例如会话选择、压缩确认或待发送文件。" },
      ...(isFeishuGroupMessage(message) ? [] : [{ command: "/whoami", description: "查看当前通道身份。" }]),
      { command: "/debug", description: "查看调试状态。" },
      { command: "/plan [任务]", description: "进入 Chat-Codex 计划模式；带任务时立即用计划模式处理，计划完成后会显示 Chat-Codex 快捷回复。", feature: "collaborationMode" },
      { command: "/code [任务]", description: "切回默认执行模式，或用默认模式处理任务。", aliases: ["/default [任务]"], feature: "collaborationMode" },
      { command: "/plan-execute", description: "执行待处理计划，继续按当前权限/审批策略处理工具请求。", aliases: ["/1"], feature: "collaborationMode" },
      { command: "/plan-edit", description: "按当前权限策略执行待处理计划；如需 Claude acceptEdits，请先明确切换权限模式。", aliases: ["/plan-accept-edits", "/2"], feature: "collaborationMode" },
      { command: "/replan <补充>", description: "基于待处理计划继续规划/修改计划，不执行代码修改。", aliases: ["/3 <补充>"], feature: "collaborationMode" },
      { command: "/plan-cancel", description: "取消待处理计划。", aliases: ["/4"], feature: "collaborationMode" },
      {
        command: "/goal [目标]",
        description: "查看或设置当前会话的实验 Goal 长期目标。",
        feature: "goal",
        details: [
          "`/goal pause`: 暂停 Goal，保留目标但暂时不让后端按它持续推进。",
          "`/goal resume`: 恢复 Goal，继续按已暂停的目标推进。",
          "`/goal clear`: 清除 Goal，退出当前会话的 Goal 追踪。",
        ],
      },
      {
        command: "/progress [brief|detailed|silent]",
        description: "查看或设置当前上下文的进度投递详细程度。",
        aliases: ["/mode"],
        hideWhenProgressDisabled: true,
        details: [
          "`brief`: 摘要模式，发送计划、推理自言自语、搜索、文件变更和其他摘要，隐藏命令和工具细节。",
          "`detailed`: 详细模式，发送所有可见进度，包括命令和工具调用细节。",
          "`silent`: 静默模式，不发送进度文本，但仍保留开始提示、审批和最终回复。",
          "发送 `/progress brief`、`/progress detailed` 或 `/progress silent` 设置模式；`/mode` 是同一命令的别名。",
          "别名值：`normal`=`brief`，`verbose`/`debug`=`detailed`，`quiet`/`off`/`none`=`silent`。",
        ],
      },
      {
        command: "/sendfile <任务内容>",
        description: "本轮允许当前后端在最终回复中声明要发送的本地文件。",
        details: [
          "普通消息里的本地路径、Markdown 链接或 file:// 引用不会自动作为附件发送。",
          "最终回复必须声明 `BRIDGE_SEND_FILE: /absolute/path/to/file`，Bridge 会剥离协议行后发送文件。",
          "渠道必须支持图片/文件发送；发送失败会汇总为文件发送结果。",
        ],
        feature: "sendfile",
      },
      {
        command: "/compact",
        description: "压缩当前会话的历史上下文。",
        details: ["`/compact confirm`: 确认并开始压缩。", "`/cancel`: 取消等待中的压缩确认。"],
        feature: "compact",
      },
      {
        command: "/model [list|all|模型|编号|default|effort]",
        description: "查看可用模型，或切换当前会话后续任务的模型和思考程度。",
        details: [
          "`/model` 或 `/model list`: 查看常用模型列表。",
          "`/model all`: 包含隐藏模型。",
          "`/model 2 high`: 按上方列表编号选择模型并设置思考程度。",
          "`/model <模型> <effort>`: 按模型名或 id 设置模型和思考程度。",
          "`/model effort medium`: 只调整当前模型的后续思考程度。",
          "`/model default`、`/model reset`、`/model clear`: 清除模型覆盖。",
          "effort 关键字也支持 `thinking` / `reasoning`。",
        ],
        feature: "model",
      },
      {
        command: "/permission [approval|full confirm|default|auto|acceptEdits|dontAsk|plan|bypassPermissions confirm]",
        description: "查看或切换当前绑定会话的权限模式。",
        aliases: ["/permissions", "/perm", "/policy"],
        details: [
          "`/permission approval`: 切回较安全的审批模式，使用 `workspace-write` sandbox。",
          "`/permission full confirm`: 高风险完全权限；完成后建议切回 `/permission approval`。",
          "Claude Code modes 会映射到 `--permission-mode`：`default`、`auto`、`acceptEdits`、`dontAsk`、`plan`。",
          "`/permission bypassPermissions confirm`: Claude Code 高风险模式，会跳过权限检查。",
        ],
        feature: "runtimePermissionSwitch",
      },
      {
        command: "/OK",
        description: "批准当前审批。",
        details: ["别名：`/yes`、`/approve`；带选项提示时也可直接回复数字 `/1`-`/4`。"],
        feature: "interactiveApprovals",
      },
      { command: "/P", description: "按当前会话批准审批，后续同类操作尽量不再询问。", details: ["别名：`/yes-session`、`/ok-session`、`/approve-session`。"], feature: "interactiveApprovals" },
      { command: "/NO", description: "拒绝当前审批。", details: ["别名：`/deny`、`/reject`。"], feature: "interactiveApprovals" },
      { command: "/stop", description: "终止当前正在处理的任务。" },
    ];
    const visibleCommands = [
      ...(deliveryPolicy.progressCommand === "disabled"
        ? commands.filter((entry) => !entry.hideWhenProgressDisabled && this.commandSupported(entry))
        : commands.filter((entry) => this.commandSupported(entry))),
      ...deliveryPolicy.refreshCommands.map((command): HelpCommand => ({ command: `/${command.command}`, description: command.description })),
    ].map((entry) => ({
      ...entry,
      command: commandForProfile(this.commandProfile, entry.command),
      aliases: entry.aliases?.map((alias) => commandForProfile(this.commandProfile, alias)),
      details: entry.details,
    }));
    return [
      "**可用命令**",
      this.commandProfile === "claude" ? "Claude profile：已知 Chat-Codex 命令可直接使用根 `/...`；旧 `/bridge-*` 别名仍兼容；未知 slash 命令会在 Claude Code 支持时转发。" : undefined,
      "",
      "**常用下一步**",
      ...formatHelpNextStepLines(this.commandProfile),
      "",
      "**完整命令**",
      ...visibleCommands.flatMap(formatHelpCommandLines),
    ].filter(Boolean).join("\n").trimEnd();
  }

  private commandSupported(entry: HelpCommand): boolean {
    return !entry.feature || backendSupportsFeature(this.backend, entry.feature);
  }

  progressModeText(routeKey: string): string {
    const mode = this.progressModeFor(routeKey);
    const progressCommand = commandForProfile(this.commandProfile, "/progress");
    const modeCommand = commandForProfile(this.commandProfile, "/mode");
    const sendFileCommand = commandForProfile(this.commandProfile, "/sendfile");
    return [
      "**进度投递**",
      `- 当前模式: \`${mode}\``,
      "",
      "**模式说明**",
      "- `brief`: 摘要模式，发送计划、推理自言自语、搜索、文件变更和其他摘要，隐藏命令和工具细节。",
      "- `detailed`: 详细模式，发送所有可见进度，包括命令和工具调用细节。",
      "- `silent`: 静默模式，不发送进度文本，但仍保留开始提示、审批和最终回复。",
      "",
      "**用法**",
      `- 发送 \`${progressCommand} brief\` 使用摘要模式。`,
      `- 发送 \`${progressCommand} detailed\` 查看命令和工具细节。`,
      `- 发送 \`${progressCommand} silent\` 静默进度文本。`,
      `- 发送 \`${modeCommand} <模式>\` 也可以设置同一选项。`,
      "",
      "**别名值**",
      "- `normal` = `brief`；`verbose` / `debug` = `detailed`；`quiet` / `off` / `none` = `silent`。",
      "",
      `文件不会由进度模式自动发送；需要本轮允许发文件时使用 \`${sendFileCommand} <任务内容>\`。`,
    ].join("\n");
  }

  invalidProgressModeText(value: string): string {
    const progressCommand = commandForProfile(this.commandProfile, "/progress");
    return [
      `未知进度模式: \`${value}\``,
      "可用值: `brief`、`detailed`、`silent`。",
      "别名: `normal`=`brief`，`verbose`/`debug`=`detailed`，`quiet`/`off`/`none`=`silent`。",
      `下一步：发送 \`${progressCommand}\` 查看当前模式和示例。`,
    ].join("\n");
  }

  contextRefreshText(routeKey: string): string {
    const effective = this.contextRefreshFor(routeKey);
    return [
      "**上下文刷新**",
      `- 当前模式: ${formatContextRefreshEffectivePolicyForUser(effective)}`,
      "- `off`: 发送前不检测本机 Codex 历史是否被外部更新。",
      "- `detect`: 发送前检测，发现更新时只提醒，不重载。",
      "- `reload`: 发送前检测，发现更新时先重新加载当前 session，再发送。",
      "- `inherit`: 当前聊天跟随全局默认。",
      "",
      "用法: `/context-refresh reload`、`/context-refresh detect`、`/context-refresh off`、`/context-refresh inherit`。",
    ].join("\n");
  }

  modelText(
    models: CodexModelOption[],
    policy: CodexModelPolicy,
    currentModel: CodexSessionModelInfo | undefined,
    sessionId: string | undefined,
    includeHidden: boolean,
  ): string {
    const modelCommand = commandForProfile(this.commandProfile, "/model");
    return [
      "**模型设置**",
      `- 作用范围: ${sessionId ? `当前会话 \`${sessionId}\`` : "默认策略（后续新会话）"}`,
      `- 当前模型: ${formatModelInfo(currentModel)}`,
      `- 模型覆盖: ${formatModelPolicy(policy)}`,
      `- 显示范围: ${includeHidden ? "包含隐藏模型" : "常用模型"}`,
      "",
      "**可用模型**",
      ...(models.length > 0 ? models.map(formatModelOptionLine) : ["无可用模型。"]),
      "",
      "**用法**",
      `- 发送 \`${modelCommand} all\` 可包含隐藏模型。`,
      `- 发送 \`${modelCommand} 2 high\` 可按编号选择上方列表项。`,
      `- 发送 \`${modelCommand} <模型或 id> <effort>\` 可按名称/id 选择。`,
      `- 发送 \`${modelCommand} effort medium\` 只修改后续思考程度。`,
      `- 发送 \`${modelCommand} default\` 清除模型覆盖。`,
    ].join("\n");
  }

  permissionText(sessionId?: string): string {
    const policyStatus = this.runPolicyStatus(sessionId);
    const policy = policyStatus?.policy ?? this.codex.getRunPolicy?.(sessionId);
    const permissionCommand = commandForProfile(this.commandProfile, "/permission");
    return [
      "**权限模式**",
      "",
      "**当前状态**",
      `- 作用范围: ${sessionId ? `当前会话 \`${sessionId}\`` : "默认策略（后续新会话）"}`,
      `- 当前模式: \`${policy ? formatRunPolicy(policy) : "unknown"}\``,
      policyStatus ? `- 审批支持: ${formatApprovalSupport(policyStatus)}` : undefined,
      policyStatus?.note ? `- 说明: ${policyStatus.note}` : undefined,
      "",
      "**Codex / bridge 权限模式**",
      "- `approval`: 使用 `workspace-write` sandbox；如当前后端支持，会在聊天里发起审批。",
      "- `full`: 完全权限，会跳过审批或权限检查，当前后端可以直接执行命令并修改文件，风险很高，需要 `confirm`。",
      "",
      "**Claude Code 权限模式**",
      "- `default`、`auto`、`acceptEdits`、`dontAsk`、`plan`: 映射到 Claude Code `--permission-mode`。",
      "- `bypassPermissions`: 高风险模式，会跳过 Claude Code 权限检查，需要 `confirm`。",
      "",
      "**下一步**",
      `- 切回审批模式: \`${permissionCommand} approval\``,
      `- 切到完全权限: \`${permissionCommand} full confirm\``,
      `- Claude acceptEdits: \`${permissionCommand} acceptEdits\``,
      `- Claude bypassPermissions: \`${permissionCommand} bypassPermissions confirm\``,
    ].filter(Boolean).join("\n");
  }

  shouldDeliverProgress(routeKey: string, kind: CodexProgressKind | undefined): boolean {
    const mode = this.progressModeFor(routeKey);
    if (mode === "silent") return false;
    if (mode === "detailed") return true;
    return kind === "reasoning" || kind === "todo" || kind === "search" || kind === "file_change" || kind === "other";
  }

  progressStatusLine(routeKey: string, policy: ChannelDeliveryPolicy): string {
    if (policy.progress === "suppress") {
      const label = policy.statusProgressLabel ?? "disabled";
      const detail = policy.statusProgressDescription ? `（${policy.statusProgressDescription}）` : "";
      return `- 进度投递: ${formatProgressLabelForStatus(label)}${detail}`;
    }
    const suffix = policy.progress === "aggregate" ? "（渠道聚合）" : "";
    return `- 进度投递: ${formatProgressModeForStatus(this.progressModeFor(routeKey))}${suffix}`;
  }
}

function formatCompactStateForUsage(state: CompactState): string {
  if (state.type === "none") return "无";
  if (state.type === "confirming") return `等待确认（会话 \`${state.sessionId}\`）`;
  return `进行中（会话 \`${state.sessionId}\`）`;
}

function isFeishuDirectMessage(message: ChannelMessage | undefined): boolean {
  if (!message || message.conversation.kind !== "direct") return false;
  return message.channelId === "feishu"
    || message.channelId.startsWith("feishu-")
    || message.channelId === "lark"
    || message.channelId.startsWith("lark-");
}

function isFeishuGroupMessage(message: ChannelMessage | undefined): boolean {
  if (!message || message.conversation.kind !== "group") return false;
  return message.channelId === "feishu"
    || message.channelId.startsWith("feishu-")
    || message.channelId === "lark"
    || message.channelId.startsWith("lark-");
}

interface HelpCommand {
  command: string;
  description: string;
  aliases?: string[];
  details?: string[];
  hideWhenProgressDisabled?: boolean;
  feature?: BackendCommandFeature;
  commandName?: string;
}

function formatHelpNextStepLines(commandProfile: CommandNamespaceProfile): string[] {
  const statusCommand = commandForProfile(commandProfile, "/status");
  const newCommand = commandForProfile(commandProfile, "/new");
  const sessionsCommand = commandForProfile(commandProfile, "/sessions");
  const useCommand = commandForProfile(commandProfile, "/use");
  return [
    "- 继续任务：直接发送普通消息。",
    `- 查看状态：发送 \`${statusCommand}\`。`,
    `- 新建会话：发送 \`${newCommand}\`。`,
    `- 切换会话：发送 \`${sessionsCommand}\` 查看列表，或发送 \`${useCommand}\` 进入编号选择。`,
    "- 遇到审批：按审批提示发送 `/OK`、`/P`、`/NO` 或数字选项。",
    `- 不确定命令：先发送 \`${statusCommand}\` 看当前状态和下一步。`,
  ];
}

function formatHelpCommandLines(entry: HelpCommand): string[] {
  return [
    `- \`${entry.command}\`: ${entry.description}`,
    ...(entry.aliases && entry.aliases.length > 0 ? [`  - 别名：${entry.aliases.map((alias) => `\`${alias}\``).join("、")}`] : []),
    ...(entry.details ?? []).map((detail) => `  - ${detail}`),
  ];
}

function formatStatusSection(title: string, lines: Array<string | undefined>): string[] {
  return [
    `- **${title}**`,
    ...lines.filter((line): line is string => Boolean(line)).map(formatStatusChildLine),
  ];
}

function formatStatusChildLine(line: string): string {
  if (line.includes("\n")) return line;
  return line.startsWith("- ") ? `  ${line}` : `  - ${line}`;
}

interface SessionListRequest {
  scope: Exclude<SessionListScope, "selectable">;
  page?: number;
  action?: "next" | "prev";
}

function parseSessionListRequest(commandName: string, args: string[]): SessionListRequest {
  let scope: SessionListRequest["scope"] = commandName === "all-sessions" ? "all" : "route";
  let tokens = args;
  if (commandName !== "all-sessions" && args[0]?.toLowerCase() === "all") {
    scope = "all";
    tokens = args.slice(1);
  }
  const token = tokens[0] ?? "";
  return {
    scope,
    page: pageNumberFromText(token),
    action: sessionPageAction(token),
  };
}

function sessionListStateKey(routeKey: string, scope: SessionListRequest["scope"]): string {
  return `${routeKey}:${scope}`;
}

function formatCurrentTurnDurationLine(status: CodexSessionStatus): string | undefined {
  if (!isActiveCodexStatus(status.type)) return undefined;
  const startedAt = "startedAt" in status ? status.startedAt : undefined;
  if (!startedAt) return undefined;
  return `- 当前任务耗时: \`${formatElapsedDurationSince(startedAt)}\``;
}

function isActiveCodexStatus(status: CodexSessionStatus["type"]): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_input";
}

function withLocalStartedAt(status: CodexSessionStatus, localStatus: CodexSessionStatus | undefined): CodexSessionStatus {
  if (!isActiveCodexStatus(status.type) || ("startedAt" in status && status.startedAt)) return status;
  if (!localStatus || !isActiveCodexStatus(localStatus.type) || !("startedAt" in localStatus) || !localStatus.startedAt) return status;
  if (!isSameActiveTurn(status, localStatus)) return status;
  if (status.type === "running") return { ...status, startedAt: localStatus.startedAt };
  if (status.type === "waiting_approval") return { ...status, startedAt: localStatus.startedAt };
  if (status.type === "waiting_input") return { ...status, startedAt: localStatus.startedAt };
  return status;
}

function isSameActiveTurn(left: CodexSessionStatus, right: CodexSessionStatus): boolean {
  const leftTurnId = "turnId" in left ? left.turnId : undefined;
  const rightTurnId = "turnId" in right ? right.turnId : undefined;
  return !leftTurnId || !rightTurnId || leftTurnId === rightTurnId;
}

function formatStatusNextStep(options: {
  binding: boolean;
  workerRunning: boolean;
  compactState: CompactState;
  pendingApprovals: number;
  hasPlanWorkflow: boolean;
}): string {
  if (options.compactState.type !== "none") return "- 下一步：按上下文压缩提示继续处理。";
  if (options.pendingApprovals > 0) return "- 下一步：请处理待审批项，可发送审批提示中的 `/OK`、`/P`、`/NO` 或数字选项。";
  if (options.hasPlanWorkflow) return "- 下一步：请处理待处理计划，可发送 `/1` 执行、`/2` 按当前权限执行、`/3` 重新规划或 `/4` 取消。";
  if (options.workerRunning) return "- 下一步：当前任务正在执行；如需中断，请发送 `/stop`。";
  if (!options.binding) return "- 下一步：发送普通消息创建或绑定会话；如需明确选择，请发送 `/new` 或 `/resume`。";
  return "- 下一步：发送普通消息继续任务；如需查看命令，请发送 `/help`。";
}

function formatPendingPlanWorkflowStatus(workflow: PendingPlanWorkflow | undefined, commandProfile: CommandNamespaceProfile): string[] {
  if (!workflow) return [];
  return [
    "",
    "**待处理计划**",
    `- 生成时间: ${workflow.createdAt}`,
    `- 会话: \`${workflow.sessionId}\``,
    "```text\n" + formatPlanWorkflowChoices(commandProfile) + "\n```",
  ];
}

function formatCompactStatusLines(state: CompactState, commandProfile: CommandNamespaceProfile): string[] {
  if (state.type === "none") return ["- 上下文压缩: 无"];
  if (state.type === "confirming") {
    return [
      "- 上下文压缩: 等待确认",
      `- 压缩会话: \`${state.sessionId}\``,
      "- 可用操作: 发送 `/compact confirm` 开始，或发送 `/cancel` 取消",
      "- 下一步：确认要压缩请发送确认命令；不想压缩请发送 `/cancel`。",
    ];
  }
  return [
    "- 上下文压缩: 进行中",
    `- 压缩会话: \`${state.sessionId}\``,
    "- 可用操作: 等待上下文压缩完成；当前不支持中途取消 `/compact`，可发送 `/status` 刷新查看。",
  ];
}
