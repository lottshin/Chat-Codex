import type {
  CodexAdapter,
  CodexCollaborationMode,
  CodexCompactResult,
  CodexEvent,
  CodexModelListOptions,
  CodexModelOption,
  CodexModelPolicy,
  CodexProgressKind,
  CodexPromptInput,
  CodexRunApprovalContext,
  CodexRunApprovalContextRegistration,
  CodexResumeSessionOptions,
  CodexRunOptions,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionStatus,
  CodexSessionSummary,
  StartSessionInput,
} from "../codex/types.js";
import type { CodexRunPolicy, ClaudePermissionMode } from "../codex/codex-cli.js";
import { codexInputPlainText } from "../codex/input.js";
import { createClaudeSdkClient, type ClaudeSdkClient, type ClaudeSdkMessage, type ClaudeSdkOptions, type ClaudeSdkPermissionUpdate, type ClaudeSdkQuery, type ClaudeSdkSessionInfo } from "./claude-sdk-client.js";
import { type ClaudeApprovalContext, type ClaudeApprovalService, type ClaudePermissionPromptResult } from "./approval-service.js";

export interface ClaudeSdkAdapterOptions {
  client?: ClaudeSdkClient;
  runPolicy?: CodexRunPolicy;
  approvalService?: ClaudeApprovalService;
}

interface ClaudeSdkSessionRecord {
  session: CodexSession;
  routeKey?: string;
  status: CodexSessionStatus;
  actualSessionId?: string;
  updatedAt: string;
}

interface RunningClaudeSdkQuery {
  abortController: AbortController;
  query?: ClaudeSdkQuery;
  cancelRequested: boolean;
}

const CLAUDE_SDK_MODELS: CodexModelOption[] = [
  claudeSdkModel("opus", "opus", "Claude Opus alias", true, false, "high"),
  claudeSdkModel("sonnet", "sonnet", "Claude Sonnet alias", false, false, "high"),
  claudeSdkModel("haiku", "haiku", "Claude Haiku alias", false, false, "medium"),
  claudeSdkModel("claude-opus-4-7", "claude-opus-4-7", "Claude Opus 4.7", false, true, "high"),
  claudeSdkModel("claude-sonnet-4-6", "claude-sonnet-4-6", "Claude Sonnet 4.6", false, true, "high"),
  claudeSdkModel("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", false, true, "medium"),
];

export class ClaudeSdkAdapter implements CodexAdapter {
  private readonly client: ClaudeSdkClient;
  private readonly approvalService?: ClaudeApprovalService;
  private defaultRunPolicy: CodexRunPolicy;
  private defaultModelPolicy: CodexModelPolicy = {};
  private defaultCollaborationMode: CodexCollaborationMode = "default";
  private readonly sessionRunPolicies = new Map<string, CodexRunPolicy>();
  private readonly sessionModelPolicies = new Map<string, CodexModelPolicy>();
  private readonly sessionCollaborationModes = new Map<string, CodexCollaborationMode>();
  private readonly sessions = new Map<string, ClaudeSdkSessionRecord>();
  private readonly runningQueries = new Map<string, RunningClaudeSdkQuery>();
  private readonly promptSlashCommands = new Set<string>();
  private readonly promptSkills = new Set<string>();
  private readonly approvalContexts = new Map<string, ClaudeApprovalContext>();
  private sessionSequence = 0;
  private approvalContextSequence = 0;

  constructor(options: ClaudeSdkAdapterOptions = {}) {
    this.client = options.client ?? createClaudeSdkClient();
    this.approvalService = options.approvalService;
    this.defaultRunPolicy = cloneRunPolicy(options.runPolicy ?? { permissionMode: "approval", sandbox: "workspace-write" });
  }

  registerRunApprovalContext(context: CodexRunApprovalContext): CodexRunApprovalContextRegistration {
    const token = `claude-sdk-approval-${Date.now()}-${++this.approvalContextSequence}`;
    this.approvalContexts.set(token, context);
    return {
      token,
      dispose: () => {
        this.approvalContexts.delete(token);
      },
    };
  }

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    const session: CodexSession = {
      id: `claude-sdk-local-${Date.now()}-${++this.sessionSequence}`,
      cwd: input.cwd,
      title: input.title,
      backend: "claude",
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, {
      session,
      routeKey: input.routeKey,
      status: { type: "idle" },
      updatedAt: session.createdAt,
    });
    this.sessionRunPolicies.set(session.id, cloneRunPolicy(this.defaultRunPolicy));
    this.sessionModelPolicies.set(session.id, cloneModelPolicy(this.defaultModelPolicy));
    this.sessionCollaborationModes.set(session.id, this.defaultCollaborationMode);
    return session;
  }

  async resumeSession(sessionId: string, options: CodexResumeSessionOptions = {}): Promise<CodexSession> {
    const stored = this.sessions.get(sessionId);
    if (stored) return stored.session;
    const now = new Date().toISOString();
    const actualSessionId = options.backendSessionId ?? sessionId;
    const session: CodexSession = {
      id: sessionId,
      cwd: options.cwd ?? process.cwd(),
      title: options.title ?? `claude-sdk:${actualSessionId}`,
      backend: "claude",
      backendSessionId: actualSessionId,
      createdAt: options.createdAt ?? now,
    };
    this.sessions.set(session.id, {
      session,
      status: { type: "idle" },
      actualSessionId,
      updatedAt: now,
    });
    this.sessionRunPolicies.set(session.id, cloneRunPolicy(this.defaultRunPolicy));
    this.sessionModelPolicies.set(session.id, cloneModelPolicy(this.defaultModelPolicy));
    this.sessionCollaborationModes.set(session.id, this.defaultCollaborationMode);
    return session;
  }

  async *run(sessionId: string, prompt: CodexPromptInput, options: CodexRunOptions = {}): AsyncIterable<CodexEvent> {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`claude sdk session not found locally: ${sessionId}`);
    const promptText = codexInputPlainText(prompt);
    const turnId = `claude-sdk-turn-${Date.now()}`;
    const startedAt = new Date().toISOString();
    stored.status = withModelInfo({ type: "running", turnId, task: truncatePrompt(promptText), startedAt }, this.modelPolicyForSession(sessionId));
    stored.updatedAt = new Date().toISOString();
    yield { type: "turn.started", sessionId, turnId, startedAt };

    const running: RunningClaudeSdkQuery = { abortController: new AbortController(), cancelRequested: false };
    this.runningQueries.set(sessionId, running);
    let completedText = "";
    let completed = false;

    try {
      const query = this.client.query({
        prompt: promptText,
        options: this.buildQueryOptions(stored, running.abortController, options),
      });
      running.query = query;
      for await (const message of query) {
        const mapped = mapSdkMessage(message, sessionId, turnId);
        this.capturePromptCapabilities(mapped);
        if (mapped.actualSessionId) this.recordActualSessionId(stored, mapped.actualSessionId);
        if (mapped.text) completedText = mapped.text;
        for (const event of mapped.events) {
          if (event.type === "assistant.completed") completed = true;
          if (event.type === "turn.failed") stored.status = { type: "failed", error: event.error };
          yield event;
        }
      }
    } catch (error) {
      if (!running.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error);
        stored.status = { type: "failed", error: message };
        stored.updatedAt = new Date().toISOString();
        yield { type: "turn.failed", sessionId, turnId, error: message };
        return;
      }
    } finally {
      this.runningQueries.delete(sessionId);
    }

    if (running.cancelRequested) {
      stored.status = { type: "idle" };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.completed", sessionId, turnId };
      return;
    }
    if (!completed && completedText.trim()) {
      yield { type: "assistant.completed", sessionId, turnId, text: completedText.trim() };
    }
    stored.status = { type: "idle" };
    stored.updatedAt = new Date().toISOString();
    yield { type: "turn.completed", sessionId, turnId };
  }

  async cancel(sessionId: string): Promise<void> {
    const running = this.runningQueries.get(sessionId);
    const stored = this.sessions.get(sessionId);
    if (stored) {
      stored.status = { type: "idle" };
      stored.updatedAt = new Date().toISOString();
    }
    if (!running) return;
    running.cancelRequested = true;
    running.abortController.abort();
    running.query?.close();
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessions.get(sessionId)?.status ?? { type: "unknown", detail: "session not found" };
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    const localSessions = [...this.sessions.values()]
      .filter((record) => routeKey ? record.routeKey === routeKey : true)
      .map((record) => sessionSummaryForRecord(record));
    if (routeKey || !this.client.listSessions) return localSessions;
    try {
      const discovered = await this.client.listSessions({ limit: 100 });
      return mergeDiscoveredSessionSummaries(localSessions, discovered);
    } catch {
      return localSessions;
    }
  }

  getRunPolicy(sessionId?: string): CodexRunPolicy {
    return cloneRunPolicy(this.runPolicyForSession(sessionId));
  }

  setRunPolicy(policy: CodexRunPolicy, sessionId?: string): void {
    if (sessionId) {
      this.sessionRunPolicies.set(sessionId, cloneRunPolicy(policy));
      return;
    }
    this.defaultRunPolicy = cloneRunPolicy(policy);
  }

  getRunPolicyStatus(sessionId?: string): CodexRunPolicyStatus {
    const policy = this.getRunPolicy(sessionId);
    const permissionMode = claudeSdkPermissionModeForPolicy(policy, this.collaborationModeForSession(sessionId));
    return {
      policy,
      interactiveApprovals: Boolean(this.approvalService && permissionMode !== "bypassPermissions" && permissionMode !== "plan"),
      effectiveApprovalPolicy: this.approvalService && permissionMode !== "bypassPermissions" && permissionMode !== "plan" ? "on-request" : "never",
      note: this.approvalService && permissionMode !== "bypassPermissions" && permissionMode !== "plan"
        ? "Claude Agent SDK 工具审批已桥接到远程渠道；异常会 fail-closed 拒绝。"
        : `Claude Agent SDK 实验模式会通过 permissionMode=${permissionMode} 执行；当前未启用远程交互审批。`,
    };
  }

  async listModels(options: CodexModelListOptions = {}): Promise<CodexModelOption[]> {
    return CLAUDE_SDK_MODELS.filter((model) => options.includeHidden || !model.hidden);
  }

  getModelPolicy(sessionId?: string): CodexModelPolicy {
    return cloneModelPolicy(this.modelPolicyForSession(sessionId));
  }

  setModelPolicy(policy: CodexModelPolicy, sessionId?: string): void {
    const next = cloneModelPolicy(policy);
    if (sessionId) {
      this.sessionModelPolicies.set(sessionId, next);
      const stored = this.sessions.get(sessionId);
      if (stored) {
        stored.status = withModelInfo(stored.status, next);
        stored.updatedAt = new Date().toISOString();
      }
      return;
    }
    this.defaultModelPolicy = next;
  }

  getCollaborationMode(sessionId?: string): CodexCollaborationMode {
    return this.collaborationModeForSession(sessionId);
  }

  setCollaborationMode(mode: CodexCollaborationMode, sessionId?: string): void {
    if (sessionId) {
      this.sessionCollaborationModes.set(sessionId, mode);
      return;
    }
    this.defaultCollaborationMode = mode;
  }

  async compactSession(sessionId: string): Promise<CodexCompactResult> {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`claude sdk session not found locally: ${sessionId}`);
    return {
      sessionId,
      backend: "claude",
      backendSessionId: stored.actualSessionId ?? stored.session.backendSessionId,
      message: "Claude Agent SDK 实验模式暂不支持 /compact；请切回默认 Claude exec adapter。",
    };
  }

  listPromptSlashCommands(): readonly string[] {
    return [...new Set([...this.promptSlashCommands, ...this.promptSkills])].sort();
  }

  async refreshPromptSlashCommands(): Promise<readonly string[]> {
    return this.listPromptSlashCommands();
  }

  listPromptSkills(): readonly string[] {
    return [...this.promptSkills].sort();
  }

  async refreshPromptSkills(): Promise<readonly string[]> {
    return this.listPromptSkills();
  }

  private buildQueryOptions(stored: ClaudeSdkSessionRecord, abortController: AbortController, options: CodexRunOptions): ClaudeSdkOptions {
    const runPolicy = this.runPolicyForSession(stored.session.id);
    const collaborationMode = options.collaborationMode ?? this.collaborationModeForSession(stored.session.id);
    const permissionMode = options.claudePermissionMode ?? claudeSdkPermissionModeForPolicy(runPolicy, collaborationMode);
    const modelPolicy = this.modelPolicyForSession(stored.session.id);
    const queryOptions: ClaudeSdkOptions = {
      cwd: stored.session.cwd,
      resume: stored.actualSessionId ?? stored.session.backendSessionId,
      abortController,
      includePartialMessages: true,
      model: modelPolicy.model,
      effort: modelPolicy.claudeEffort,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions" ? true : undefined,
    };
    if (this.approvalService && permissionMode !== "bypassPermissions" && permissionMode !== "plan") {
      queryOptions.canUseTool = async (toolName, input, permissionOptions) => {

        const result = await this.approvalService?.requestPermission({
          tool_name: toolName,
          toolName,
          input,
          tool_input: input,
          tool_use_id: permissionOptions.toolUseID,
          toolUseId: permissionOptions.toolUseID,
          title: permissionOptions.title,
          displayName: permissionOptions.displayName,
          description: permissionOptions.description,
          blockedPath: permissionOptions.blockedPath,
          decisionReason: permissionOptions.decisionReason,
          suggestions: permissionOptions.suggestions,
        }, this.approvalContextFor(stored.session.id));
        return permissionResultForSdk(result, permissionOptions.toolUseID, input);
      };
    }
    return queryOptions;
  }

  private runPolicyForSession(sessionId?: string): CodexRunPolicy {
    return (sessionId ? this.sessionRunPolicies.get(sessionId) : undefined) ?? this.defaultRunPolicy;
  }

  private modelPolicyForSession(sessionId?: string): CodexModelPolicy {
    return (sessionId ? this.sessionModelPolicies.get(sessionId) : undefined) ?? this.defaultModelPolicy;
  }

  private collaborationModeForSession(sessionId?: string): CodexCollaborationMode {
    return (sessionId ? this.sessionCollaborationModes.get(sessionId) : undefined) ?? this.defaultCollaborationMode;
  }

  private approvalContextFor(sessionId: string): ClaudeApprovalContext | undefined {
    const contexts = [...this.approvalContexts.values()].filter((context) => context.sessionId === sessionId);
    if (contexts.length === 1) return contexts[0];
    return undefined;
  }

  private recordActualSessionId(stored: ClaudeSdkSessionRecord, actualSessionId: string): void {
    stored.actualSessionId = actualSessionId;
    stored.session.backendSessionId = actualSessionId;
    stored.updatedAt = new Date().toISOString();
  }

  private capturePromptCapabilities(mapped: MappedSdkMessage): void {
    if (mapped.promptSlashCommands) {
      for (const command of mapped.promptSlashCommands) this.promptSlashCommands.add(command);
    }
    if (mapped.promptSkills) {
      for (const skill of mapped.promptSkills) this.promptSkills.add(skill);
    }
  }
}

interface MappedSdkMessage {
  actualSessionId?: string;
  text?: string;
  events: CodexEvent[];
  promptSlashCommands?: string[];
  promptSkills?: string[];
}

function sessionSummaryForRecord(record: ClaudeSdkSessionRecord): CodexSessionSummary {
  return {
    id: record.session.id,
    routeKey: record.routeKey,
    title: record.session.title,
    cwd: record.session.cwd,
    status: record.status,
    updatedAt: record.updatedAt,
    backend: "claude",
    backendSessionId: record.actualSessionId ?? record.session.backendSessionId,
  };
}

function mergeDiscoveredSessionSummaries(localSessions: CodexSessionSummary[], discovered: ClaudeSdkSessionInfo[]): CodexSessionSummary[] {
  const knownBackendIds = new Set(localSessions.flatMap((session) => session.backendSessionId ? [session.backendSessionId] : []));
  const knownIds = new Set(localSessions.map((session) => session.id));
  const discoveredSummaries = discovered
    .filter((session) => session.sessionId && !knownIds.has(session.sessionId) && !knownBackendIds.has(session.sessionId))
    .map((session) => ({
      id: session.sessionId,
      title: session.customTitle ?? session.summary ?? session.firstPrompt,
      cwd: session.cwd,
      status: { type: "idle" } as const,
      updatedAt: new Date(session.lastModified).toISOString(),
      backend: "claude" as const,
      backendSessionId: session.sessionId,
    }));
  return [...localSessions, ...discoveredSummaries];
}


function permissionResultForSdk(result: ClaudePermissionPromptResult | undefined, toolUseID: string, input: Record<string, unknown>): { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: ClaudeSdkPermissionUpdate[] } | { behavior: "deny"; message: string; interrupt?: boolean; toolUseID: string } {
  if (result?.behavior === "allow") {
    return result.updatedPermissions ? { behavior: "allow", updatedInput: input, updatedPermissions: result.updatedPermissions } : { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: result?.message ?? "缺少远程审批上下文，已拒绝。", interrupt: true, toolUseID };
}

function mapSdkMessage(message: ClaudeSdkMessage, sessionId: string, turnId: string): MappedSdkMessage {
  const record = message as Record<string, unknown>;
  const actualSessionId = typeof record.session_id === "string" ? record.session_id : undefined;
  if (record.type === "assistant") {
    const plan = assistantPlan(record.message);
    const text = assistantText(record.message);
    const tool = assistantToolName(record.message);
    if (plan) return { actualSessionId, text: plan, events: [{ type: "assistant.plan", sessionId, turnId, text: plan }] };
    if (text) return { actualSessionId, text, events: [{ type: "assistant.delta", sessionId, turnId, text }] };
    if (tool) return { actualSessionId, events: [{ type: "assistant.progress", sessionId, turnId, text: `正在调用工具: ${tool}`, kind: progressKindForTool(tool) }] };
  }
  if (record.type === "stream_event") {
    const text = streamEventText(record.event);
    if (text) return { actualSessionId, events: [{ type: "assistant.delta", sessionId, turnId, text }] };
  }
  if (record.type === "result") {
    if (record.subtype === "success") {
      const text = typeof record.result === "string" ? record.result : "";
      return { actualSessionId, text, events: text ? [{ type: "assistant.completed", sessionId, turnId, text }] : [] };
    }
    const error = sdkResultError(record);
    return { actualSessionId, events: [{ type: "turn.failed", sessionId, turnId, error }] };
  }
  if (record.type === "system") {
    const progress = systemProgress(record);
    return {
      actualSessionId,
      events: progress ? [{ type: "assistant.progress", sessionId, turnId, text: progress, kind: "other" }] : [],
      promptSlashCommands: record.subtype === "init" ? promptSlashCommandsFromInit(record.slash_commands) : undefined,
      promptSkills: record.subtype === "init" ? promptSkillsFromInit(record.skills) : undefined,
    };
  }
  if (record.type === "tool_progress") {
    const name = typeof record.tool_name === "string" ? record.tool_name : "tool";
    return { actualSessionId, events: [{ type: "assistant.progress", sessionId, turnId, text: `工具运行中: ${name}`, kind: progressKindForTool(name) }] };
  }
  if (record.type === "tool_use_summary" && typeof record.summary === "string") {
    return { actualSessionId, events: [{ type: "assistant.progress", sessionId, turnId, text: record.summary, kind: "tool" }] };
  }
  return { actualSessionId, events: [] };
}

function assistantPlan(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  const tool = message.content.find((item) => isRecord(item) && item.type === "tool_use" && item.name === "ExitPlanMode" && isRecord(item.input) && typeof item.input.plan === "string");
  return isRecord(tool) && isRecord(tool.input) ? tool.input.plan as string : "";
}

function assistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function assistantToolName(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const tool = message.content.find((item) => isRecord(item) && item.type === "tool_use" && typeof item.name === "string");
  return isRecord(tool) ? tool.name as string : undefined;
}

function streamEventText(event: unknown): string {
  if (!isRecord(event)) return "";
  if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "text_delta" && typeof event.delta.text === "string") {
    return event.delta.text;
  }
  if (event.type === "content_block_delta" && isRecord(event.delta) && event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
    return event.delta.thinking;
  }
  return "";
}

function sdkResultError(record: Record<string, unknown>): string {
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((item): item is string => typeof item === "string")
    : [];
  if (errors.length > 0) return errors.join("\n");
  if (typeof record.subtype === "string") return record.subtype;
  return "Claude Agent SDK run failed";
}

function systemProgress(record: Record<string, unknown>): string | undefined {
  if (record.subtype === "status" && typeof record.status === "string") return `Claude 状态: ${record.status}`;
  if (record.subtype === "task_started" && typeof record.description === "string") return record.description;
  if (record.subtype === "task_progress") {
    if (typeof record.summary === "string" && record.summary) return record.summary;
    if (typeof record.description === "string") return record.description;
  }
  if (record.subtype === "task_notification" && typeof record.summary === "string") return record.summary;
  if (record.subtype === "permission_denied" && typeof record.message === "string") return record.message;
  return undefined;
}

function promptSlashCommandsFromInit(slashCommands: unknown): string[] | undefined {
  const commands = new Set<string>();
  for (const value of valuesFromUnknown(slashCommands)) {
    const normalized = normalizePromptSlashCommand(value);
    if (normalized) commands.add(normalized);
  }
  return commands.size > 0 ? [...commands].sort() : undefined;
}

function promptSkillsFromInit(skills: unknown): string[] | undefined {
  const commands = new Set<string>();
  for (const value of valuesFromUnknown(skills)) {
    const normalized = normalizePromptSlashCommand(value);
    if (normalized) commands.add(normalized);
  }
  return commands.size > 0 ? [...commands].sort() : undefined;
}

function valuesFromUnknown(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

function normalizePromptSlashCommand(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value
    : isRecord(value)
      ? stringField(value, "name") ?? stringField(value, "command")
      : undefined;
  const normalized = raw?.trim().replace(/^\/+/, "").toLowerCase();
  return normalized || undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function progressKindForTool(name: string): CodexProgressKind {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell")) return "command";
  if (lower.includes("read") || lower.includes("grep") || lower.includes("glob") || lower.includes("search")) return "search";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "file_change";
  if (lower.includes("todo")) return "todo";
  return "tool";
}

function claudeSdkPermissionModeForPolicy(policy: CodexRunPolicy, collaborationMode: CodexCollaborationMode): ClaudePermissionMode {
  if (collaborationMode === "plan") return "plan";
  if (policy.claudePermissionMode) return policy.claudePermissionMode;
  return policy.permissionMode === "full" ? "bypassPermissions" : "default";
}

function cloneRunPolicy(policy: CodexRunPolicy): CodexRunPolicy {
  return { ...policy };
}

function cloneModelPolicy(policy: CodexModelPolicy): CodexModelPolicy {
  return { ...policy };
}

function withModelInfo(status: CodexSessionStatus, policy: CodexModelPolicy): CodexSessionStatus {
  if (!policy.model) {
    const { model: _model, ...rest } = status;
    return rest;
  }
  return {
    ...status,
    model: {
      model: policy.model,
      provider: "Claude Code SDK",
      reasoningEffort: policy.reasoningEffort ?? policy.claudeEffort ?? null,
      serviceTier: policy.serviceTier ?? null,
    },
  };
}

function truncatePrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 77)}...`;
}

function claudeSdkModel(
  id: string,
  model: string,
  displayName: string,
  isDefault = false,
  hidden = false,
  defaultClaudeEffort?: CodexModelOption["defaultReasoningEffort"],
): CodexModelOption {
  const supportedReasoningEfforts = ["low", "medium", "high", "xhigh"] as const;
  return {
    id,
    model,
    displayName,
    hidden,
    supportedReasoningEfforts: supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: defaultClaudeEffort,
    isDefault,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
