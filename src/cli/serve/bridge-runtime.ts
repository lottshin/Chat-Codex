import { Bridge } from "../../bridge/bridge.js";
import { BridgeDelivery } from "../../bridge/delivery.js";
import { APPROVAL_SEND_RETRY_DELAY_MS } from "../../bridge/bridge-types.js";
import { ApprovalManager } from "../../approvals/approval-manager.js";
import { LimitedTurnScheduler } from "../../bridge/turn-scheduler.js";
import { ChannelRegistry } from "../../channels/registry.js";
import { ClaudeApprovalService } from "../../claude/approval-service.js";
import { createClaudeApprovalRuntime } from "../../claude/approval-runtime.js";
import { ClaudeExecAdapter } from "../../claude/claude-exec-adapter.js";
import { ClaudeSdkAdapter } from "../../claude/claude-sdk-adapter.js";
import { AppServerCodexAdapter } from "../../codex/app-server-codex-adapter.js";
import { ExecCodexAdapter } from "../../codex/exec-codex-adapter.js";
import type { CodexAdapter } from "../../codex/types.js";
import { ConsoleLogger } from "../../logging/logger.js";
import { ConsoleTranscriptSink } from "../../logging/transcript.js";
import { chatCodexTitle } from "../../runtime/package-info.js";
import { FileStateStore } from "../../state/file-state-store.js";
import type { ChannelActions } from "../actions/channel-actions.js";
import type { PreparedServeStartup, ServeChannelPlan } from "../launcher-types.js";
import { runRuntimeLogTui } from "../tui/run-runtime-log.js";
import { RuntimeLogStore, RuntimeTuiLogger, RuntimeTuiTranscriptSink } from "../tui/runtime-log.js";
import { formatFirstRoutePresetForUser, formatUnboundRoutePolicyForUser } from "../serve-wizard.js";
import { printRuntimeSummary } from "./formatters.js";
import { waitForShutdownSignal } from "./prompts.js";
import { formatClaudeStatusForCli, formatCodexStatusForCli } from "./summary.js";
import { isChannelGroupReceiveEnabled } from "../actions/channel-actions.js";

export async function startServeBridge(
  startup: PreparedServeStartup,
  plan: ServeChannelPlan,
  channelActions: ChannelActions,
  display: { tui?: boolean } = {},
): Promise<void> {
  const adapters = channelActions.createRuntimeAdapters();
  if (adapters.length === 0) {
    throw new Error("未发现可启动的渠道。请先运行 chat-codex，在“管理渠道”里添加并启用微信账号或飞书机器人。");
  }
  const runtimeLogs = display.tui ? new RuntimeLogStore() : undefined;
  const logger = runtimeLogs ? new RuntimeTuiLogger(runtimeLogs) : new ConsoleLogger(false);
  const registry = new ChannelRegistry({ channels: adapters, logger });
  const approvals = new ApprovalManager();
  const claudeRuntime = (startup.backend ?? "codex") === "claude" && startup.claudeAdapterMode !== "sdk"
    ? await createClaudeApprovalRuntime({
        channels: registry,
        approvals,
        logger,
        approvalSendRetryDelayMs: APPROVAL_SEND_RETRY_DELAY_MS,
        runPolicy: startup.policy,
        claudeCommand: startup.claudeStatus?.command,
      })
    : undefined;
  const sdkApprovalService = (startup.backend ?? "codex") === "claude" && startup.claudeAdapterMode === "sdk"
    ? new ClaudeApprovalService({
        approvals,
        delivery: new BridgeDelivery({
          channels: registry,
          approvals,
          logger,
          approvalSendRetryDelayMs: APPROVAL_SEND_RETRY_DELAY_MS,
        }),
        logger,
      })
    : undefined;
  const codex = claudeRuntime?.adapter ?? createRealCodexAdapter(startup, sdkApprovalService);
  const contextRefresh = startup.contextRefresh ?? channelActions.configStore.getContextRefreshDefaults();
  startup.contextRefresh = contextRefresh;
  const bridge = new Bridge({
    channels: registry,
    codex,
    backend: startup.backend,
    commandProfile: startup.commandProfile,
    state: new FileStateStore(),
    approvals,
    logger,
    transcript: runtimeLogs ? new RuntimeTuiTranscriptSink(runtimeLogs) : new ConsoleTranscriptSink(),
    cwd: startup.cwd,
    initialRouteBinding: plan.initialRouteBinding,
    unboundRoutePolicy: plan.unboundRoutePolicy,
    progressMode: startup.progressMode,
    contextRefresh: { defaultPolicy: contextRefresh },
    routeTrustMode: "real_channels",
    channelCapabilities: {
      setGroupEnabled: (channelId, enabled) => {
        const updated = channelActions.setChannelGroupEnabled(channelId, enabled);
        if (!updated) return { ok: false, message: `没有找到这个渠道实例：${channelId}` };
        const adapter = adapters.find((item) => item.id === channelId) as { setGroupEnabled?: (next: boolean) => void } | undefined;
        adapter?.setGroupEnabled?.(isChannelGroupReceiveEnabled(updated));
        return { ok: true, enabled: isChannelGroupReceiveEnabled(updated) };
      },
    },
    turnScheduler: startup.maxConcurrentTurns ? new LimitedTurnScheduler(startup.maxConcurrentTurns) : undefined,
  });

  await bridge.start();
  try {
    if (runtimeLogs) {
      runtimeLogs.add("system", "Bridge", "多渠道 AI 中间件已启动，正在等待微信 / 飞书消息。");
      if ((startup.backend ?? "codex") === "claude" && startup.claudeStatus) runtimeLogs.add("system", "Claude Code", formatClaudeStatusForCli(startup.claudeStatus));
      if ((startup.backend ?? "codex") === "codex" && startup.codexStatus) runtimeLogs.add("system", "Codex", formatCodexStatusForCli(startup.codexStatus));
      runtimeLogs.add("system", "渠道", adapters.map((adapter) => adapter.id).join(", "));
      runtimeLogs.add("system", "退出", "按 Ctrl+C 停止服务。");
      await runRuntimeLogTui({
        title: `${chatCodexTitle()} 运行中`,
        channels: adapters.map((adapter) => adapter.id),
        cwd: startup.cwd,
        policy: startup.policy,
        routePolicy: formatUnboundRoutePolicyForUser(plan.unboundRoutePolicy),
        codexStatus: startup.codexStatus,
      }, runtimeLogs);
    } else {
      printRuntimeSummary("多渠道 AI 中间件", startup, { progressDisabled: true });
      console.log(`- 已启动渠道: ${adapters.map((adapter) => adapter.id).join(", ")}`);
      console.log(`- 新聊天策略: ${formatUnboundRoutePolicyForUser(plan.unboundRoutePolicy)}`);
      if (plan.firstRouteBindingChoice) {
        console.log(`- 首个微信私聊: ${formatFirstRoutePresetForUser(plan.firstRouteBindingChoice, plan.initialSessionId, plan.initialSessionTitle)}`);
      }
      await waitForShutdownSignal();
    }
  } finally {
    await bridge.stop();
    await claudeRuntime?.stop();
  }
}

export function createRealCodexAdapter(startup: PreparedServeStartup, sdkApprovalService?: ClaudeApprovalService): CodexAdapter {
  if ((startup.backend ?? "codex") === "claude") {
    if (startup.claudeStatus && !startup.claudeStatus.available) {
      throw new Error(`Claude Code 不可用: ${startup.claudeStatus.error ?? "unknown error"}`);
    }
    if (startup.claudeAdapterMode === "sdk") return new ClaudeSdkAdapter({ runPolicy: startup.policy, approvalService: sdkApprovalService });
    return new ClaudeExecAdapter({ runPolicy: startup.policy, claudeCommand: startup.claudeStatus?.command });
  }
  if (startup.codexStatus && !startup.codexStatus.available) {
    throw new Error(`Codex 不可用: ${startup.codexStatus.error ?? "unknown error"}`);
  }
  const runPolicy = startup.policy;
  if (startup.adapterMode === "exec") {
    return new ExecCodexAdapter({ runPolicy, codexCommand: startup.codexStatus?.command });
  }
  return new AppServerCodexAdapter({ runPolicy, codexCommand: startup.codexStatus?.command });
}
