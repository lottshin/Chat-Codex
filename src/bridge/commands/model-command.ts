import { CLAUDE_EFFORT_LEVELS, type CodexAdapter, type CodexModelOption, type CodexModelPolicy, type ClaudeEffortLevel } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import type { BridgeStatusText } from "../status-text.js";
import {
  currentModelOption,
  formatModelScope,
  invalidReasoningEffortText,
  isModelAllToken,
  isModelListToken,
  modelSupportsEffort,
  parseModelCommandArgs,
  parseReasoningEffort,
  resolveModelReference,
  unsupportedReasoningEffortText,
} from "../formatters.js";

export interface ModelCommandOptions {
  codex: CodexAdapter;
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
  statusText: BridgeStatusText;
}

export async function handleModelCommand(
  options: ModelCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
): Promise<void> {
  const listModels = options.codex.listModels?.bind(options.codex);
  const getModelPolicy = options.codex.getModelPolicy?.bind(options.codex);
  const setModelPolicy = options.codex.setModelPolicy?.bind(options.codex);
  if (!listModels || !getModelPolicy || !setModelPolicy) {
    await options.delivery.sendText(target, "当前后端不支持模型列表或运行时模型切换。");
    return;
  }

  const includeHidden = args.some(isModelAllToken);
  const commandArgs = args.filter((arg) => !isModelAllToken(arg) && !isModelListToken(arg));
  const binding = options.state.getBinding(message.routeKey);
  const sessionId = binding?.sessionId;
  const parsed = parseModelCommandArgs(commandArgs);
  if (parsed.type === "error") {
    await options.delivery.sendText(target, parsed.message);
    return;
  }
  if (parsed.type === "reset") {
    setModelPolicy({}, sessionId);
    await options.delivery.sendText(target, [
      "已清除模型覆盖。",
      `作用范围: ${formatModelScope(sessionId)}`,
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }

  let models: CodexModelOption[];
  try {
    models = await listModels({ includeHidden });
  } catch (error) {
    await options.delivery.sendText(target, `获取模型列表失败: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const policy = getModelPolicy(sessionId);
  const status = binding ? await options.codex.getStatus(binding.sessionId).catch(() => undefined) : undefined;

  if (parsed.type === "list") {
    await options.delivery.sendText(target, options.statusText.modelText(models, policy, status?.model, sessionId, includeHidden));
    return;
  }

  if (parsed.type === "effort") {
    let currentModel = currentModelOption(models, policy, status?.model);
    if (!currentModel && !includeHidden) {
      currentModel = currentModelOption(await listModels({ includeHidden: true }), policy, status?.model);
    }
    if (!currentModel) {
      await options.delivery.sendText(target, "无法确认当前模型，不能只设置思考程度。请使用 `/model <模型> <effort>`。");
      return;
    }
    const effort = parseBackendEffort(parsed.effort, currentModel);
    if (!effort) {
      await options.delivery.sendText(target, invalidReasoningEffortText(parsed.effort));
      return;
    }
    if (effort.type === "codex" && !modelSupportsEffort(currentModel, effort.value)) {
      await options.delivery.sendText(target, unsupportedReasoningEffortText(currentModel, effort.value));
      return;
    }
    const nextPolicy: CodexModelPolicy = effort.type === "claude"
      ? { ...policy, claudeEffort: effort.value, reasoningEffort: undefined }
      : { ...policy, reasoningEffort: effort.value, claudeEffort: undefined };
    setModelPolicy(nextPolicy, sessionId);
    await options.delivery.sendText(target, [
      "已设置思考程度。",
      `作用范围: ${formatModelScope(sessionId)}`,
      `Model: \`${nextPolicy.model ?? currentModel.model}\``,
      `Effort: \`${effort.value}\``,
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }

  const resolved = resolveModelReference(parsed.modelRef, models);
  if (resolved.type === "error") {
    await options.delivery.sendText(target, resolved.message);
    return;
  }
  const model = resolved.model;
  const requestedEffort = parsed.effort ? parseBackendEffort(parsed.effort, model) : model.defaultReasoningEffort ? { type: "codex" as const, value: model.defaultReasoningEffort } : undefined;
  if (parsed.effort && !requestedEffort) {
    await options.delivery.sendText(target, invalidReasoningEffortText(parsed.effort));
    return;
  }
  if (requestedEffort?.type === "codex" && !modelSupportsEffort(model, requestedEffort.value)) {
    await options.delivery.sendText(target, unsupportedReasoningEffortText(model, requestedEffort.value));
    return;
  }
  const nextPolicy: CodexModelPolicy = {
    model: model.model,
    ...(requestedEffort?.type === "claude" ? { claudeEffort: requestedEffort.value } : {}),
    ...(requestedEffort?.type === "codex" ? { reasoningEffort: requestedEffort.value } : {}),
  };
  setModelPolicy(nextPolicy, sessionId);
  await options.delivery.sendText(target, [
    "已设置模型。",
    `作用范围: ${formatModelScope(sessionId)}`,
    `Model: \`${model.model}\`${model.id !== model.model ? ` (id \`${model.id}\`)` : ""}`,
    `Effort: \`${requestedEffort?.value ?? "default"}\``,
    options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
  ].filter(Boolean).join("\n"));
}

function parseBackendEffort(value: string, model: CodexModelOption): { type: "codex"; value: NonNullable<CodexModelPolicy["reasoningEffort"]> } | { type: "claude"; value: ClaudeEffortLevel } | undefined {
  const codexEffort = parseReasoningEffort(value);
  if (codexEffort) return { type: "codex", value: codexEffort };
  const normalized = value.trim().toLowerCase();
  if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(normalized) && isClaudeModelOption(model)) {
    return { type: "claude", value: normalized as ClaudeEffortLevel };
  }
  return undefined;
}

function isClaudeModelOption(model: CodexModelOption): boolean {
  return model.model === "opus" || model.model === "sonnet" || model.model === "haiku" || model.model.startsWith("claude-");
}
