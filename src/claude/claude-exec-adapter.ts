import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CodexAdapter,
  CodexCollaborationMode,
  CodexEvent,
  CodexModelListOptions,
  CodexModelOption,
  CodexModelPolicy,
  CodexCompactResult,
  CodexProgressKind,
  CodexPromptInput,
  CodexResumeSessionOptions,
  CodexRunOptions,
  CodexRunApprovalContext,
  CodexRunApprovalContextRegistration,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionStatus,
  CodexSessionSummary,
  StartSessionInput,
} from "../codex/types.js";
import type { ClaudeApprovalContext } from "./approval-service.js";
import type { CodexRunPolicy, ClaudePermissionMode } from "../codex/codex-cli.js";
import { codexInputPlainText } from "../codex/input.js";
import { createClaudeSdkClient, type ClaudeSdkClient, type ClaudeSdkSessionInfo } from "./claude-sdk-client.js";
import { resolveClaudeCommand, spawnClaude, type ClaudeCommandResolution } from "./claude-process.js";

export interface ClaudeExecAdapterOptions {
  claudeBin?: string;
  claudeCommand?: ClaudeCommandResolution;
  runPolicy?: CodexRunPolicy;
  permissionPromptTool?: string;
  mcpConfigPath?: string;
  strictMcpConfig?: boolean;
  sdkClient?: ClaudeSdkClient;
}

interface ClaudeSessionRecord {
  session: CodexSession;
  routeKey?: string;
  status: CodexSessionStatus;
  actualSessionId?: string;
  updatedAt: string;
}

interface RunningClaudeProcess {
  child: ChildProcess;
  cancelRequested: boolean;
}

const CLAUDE_MODELS: CodexModelOption[] = [
  claudeModel("opus", "opus", "Claude Opus alias", true, false, "high"),
  claudeModel("sonnet", "sonnet", "Claude Sonnet alias", false, false, "high"),
  claudeModel("haiku", "haiku", "Claude Haiku alias", false, false, "medium"),
  claudeModel("claude-opus-4-7", "claude-opus-4-7", "Claude Opus 4.7", false, true, "high"),
  claudeModel("claude-sonnet-4-6", "claude-sonnet-4-6", "Claude Sonnet 4.6", false, true, "high"),
  claudeModel("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", false, true, "medium"),
];

export class ClaudeExecAdapter implements CodexAdapter {
  private readonly claudeCommand: ClaudeCommandResolution;
  private defaultRunPolicy: CodexRunPolicy;
  private defaultModelPolicy: CodexModelPolicy = {};
  private defaultCollaborationMode: CodexCollaborationMode = "default";
  private readonly permissionPromptTool?: string;
  private readonly mcpConfigPath?: string;
  private readonly strictMcpConfig: boolean;
  private readonly sdkClient: ClaudeSdkClient;
  private readonly sessionRunPolicies = new Map<string, CodexRunPolicy>();
  private readonly sessionModelPolicies = new Map<string, CodexModelPolicy>();
  private readonly sessionCollaborationModes = new Map<string, CodexCollaborationMode>();
  private readonly sessions = new Map<string, ClaudeSessionRecord>();
  private readonly runningProcesses = new Map<string, RunningClaudeProcess>();
  private readonly promptSlashCommands = new Set<string>();
  private readonly promptSkills = new Set<string>();
  private promptCapabilityRefresh: Promise<void> | undefined;
  private readonly approvalContexts = new Map<string, ClaudeApprovalContext>();
  private sessionSequence = 0;
  private approvalContextSequence = 0;

  constructor(options: ClaudeExecAdapterOptions = {}) {
    this.claudeCommand = options.claudeCommand ?? resolveClaudeCommand({ claudeBin: options.claudeBin });
    this.defaultRunPolicy = cloneRunPolicy(options.runPolicy ?? { permissionMode: "approval", sandbox: "workspace-write" });
    this.permissionPromptTool = normalizePermissionPromptTool(options.permissionPromptTool ?? process.env.CHAT_CLAUDE_PERMISSION_PROMPT_TOOL);
    this.mcpConfigPath = normalizeOptionalString(options.mcpConfigPath ?? process.env.CHAT_CLAUDE_MCP_CONFIG);
    this.strictMcpConfig = options.strictMcpConfig ?? process.env.CHAT_CLAUDE_STRICT_MCP_CONFIG === "1";
    this.sdkClient = options.sdkClient ?? createClaudeSdkClient();
  }

  registerRunApprovalContext(context: CodexRunApprovalContext): CodexRunApprovalContextRegistration {
    const token = `claude-approval-${Date.now()}-${++this.approvalContextSequence}`;
    this.approvalContexts.set(token, context);
    return {
      token,
      dispose: () => {
        this.approvalContexts.delete(token);
      },
    };
  }

  getApprovalContext(token: string): ClaudeApprovalContext | undefined {
    return this.approvalContexts.get(token);
  }

  getOnlyActiveApprovalContext(): ClaudeApprovalContext | undefined {
    if (this.approvalContexts.size !== 1) return undefined;
    return [...this.approvalContexts.values()][0];
  }

  activeApprovalContextCount(): number {
    return this.approvalContexts.size;
  }

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    const session: CodexSession = {
      id: `claude-local-${Date.now()}-${++this.sessionSequence}`,
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
      title: options.title ?? `claude:${actualSessionId}`,
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
    if (!stored) throw new Error(`claude session not found locally: ${sessionId}`);
    const promptText = codexInputPlainText(prompt);
    const turnId = `claude-turn-${Date.now()}`;
    const startedAt = new Date().toISOString();
    stored.status = { type: "running", turnId, task: truncatePrompt(promptText), startedAt };
    stored.updatedAt = new Date().toISOString();
    yield { type: "turn.started", sessionId, turnId, startedAt };

    const child = spawnClaude(this.claudeCommand, this.buildArgs(stored, promptText, { collaborationMode: options.collaborationMode, claudePermissionMode: options.claudePermissionMode }), {
      cwd: stored.session.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      throw new Error("claude print stdio is unavailable");
    }
    const running: RunningClaudeProcess = { child, cancelRequested: false };
    this.runningProcesses.set(sessionId, running);
    const closePromise = new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });
    let stderr = "";
    let stdoutText = "";
    let completed = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseClaudeJsonLine(line, sessionId, turnId);
        if (parsed?.actualSessionId) {
          stored.actualSessionId = parsed.actualSessionId;
          stored.session.backendSessionId = parsed.actualSessionId;
          stored.updatedAt = new Date().toISOString();
        }
        this.capturePromptCapabilities(parsed);
        if (parsed?.text) stdoutText += parsed.text;
        const event = parsed?.event;
        if (!event) continue;
        if (event.type === "assistant.completed") completed = true;
        if (event.type === "turn.failed") stored.status = { type: "failed", error: event.error };
        yield event;
      }
    } catch (error) {
      if (!running.cancelRequested) throw error;
    }

    const code = await closePromise;
    this.runningProcesses.delete(sessionId);
    if (running.cancelRequested) {
      stored.status = { type: "idle" };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.completed", sessionId, turnId };
      return;
    }
    if (code === 0) {
      if (!completed && stdoutText.trim()) {
        yield { type: "assistant.completed", sessionId, turnId, text: stdoutText.trim() };
      }
      stored.status = { type: "idle" };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.completed", sessionId, turnId };
    } else {
      const error = stderr || `claude exited with code ${code}`;
      stored.status = { type: "failed", error };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.failed", sessionId, turnId, error };
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const running = this.runningProcesses.get(sessionId);
    const stored = this.sessions.get(sessionId);
    if (stored) {
      stored.status = { type: "idle" };
      stored.updatedAt = new Date().toISOString();
    }
    if (!running) return;
    running.cancelRequested = true;
    if (!running.child.kill("SIGTERM")) {
      running.child.kill("SIGKILL");
      return;
    }
    const timer = setTimeout(() => {
      if (this.runningProcesses.get(sessionId) === running) {
        running.child.kill("SIGKILL");
      }
    }, 2000);
    timer.unref?.();
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessions.get(sessionId)?.status ?? { type: "unknown", detail: "session not found" };
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    const localSessions = [...this.sessions.values()]
      .filter((record) => routeKey ? record.routeKey === routeKey : true)
      .map((record) => ({
        id: record.session.id,
        routeKey: record.routeKey,
        title: record.session.title,
        cwd: record.session.cwd,
        status: record.status,
        updatedAt: record.updatedAt,
        backend: "claude" as const,
        backendSessionId: record.actualSessionId ?? record.session.backendSessionId,
      }));
    if (routeKey || !this.sdkClient.listSessions) return localSessions;
    try {
      const discovered = await this.sdkClient.listSessions({ limit: 100 });
      return mergeDiscoveredClaudeSessionSummaries(localSessions, discovered);
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
    const permissionMode = claudePermissionModeForPolicy(policy, this.collaborationModeForSession(sessionId));
    const remoteApprovalsEnabled = Boolean(this.permissionPromptTool && this.mcpConfigPath && permissionMode !== "bypassPermissions");
    return {
      policy,
      interactiveApprovals: remoteApprovalsEnabled,
      effectiveApprovalPolicy: remoteApprovalsEnabled ? "on-request" : "never",
      note: remoteApprovalsEnabled
        ? `Claude Code 工具审批已通过 ${this.permissionPromptTool} 桥接到远程渠道；异常会 fail-closed 拒绝。`
        : `Claude Code print 模式会通过 --permission-mode ${permissionMode} 执行；当前未启用远程审批 MCP transport。`,
    };
  }

  async listModels(options: CodexModelListOptions = {}): Promise<CodexModelOption[]> {
    return CLAUDE_MODELS.filter((model) => options.includeHidden || !model.hidden);
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
    if (!stored) throw new Error(`claude session not found locally: ${sessionId}`);
    const summaryPrompt = [
      "请压缩当前 Claude Code 会话上下文。",
      "输出一份后续继续工作所需的完整中文摘要，包含：当前目标、关键决策、已修改/需修改的文件、未完成事项、重要约束和用户偏好。",
      "只输出摘要正文，不要继续执行代码修改。",
    ].join("\n");
    const summary = await this.runOneShot(stored, summaryPrompt, { resume: true, permissionMode: "plan" });
    const seedPrompt = [
      "以下是上一段会话压缩后的上下文摘要。请把它作为后续工作的背景记住，不要执行任何代码修改，只回复一句：已载入压缩上下文。",
      "",
      summary,
    ].join("\n");
    const previousActualSessionId = stored.actualSessionId;
    stored.actualSessionId = undefined;
    const seed = await this.runOneShot(stored, seedPrompt, { resume: false, permissionMode: "plan" });
    stored.status = { type: "idle" };
    stored.updatedAt = new Date().toISOString();
    stored.session.backendSessionId = stored.actualSessionId;
    return {
      sessionId,
      backend: "claude",
      backendSessionId: stored.actualSessionId,
      message: [
        "Claude Code 会话上下文已压缩。",
        previousActualSessionId ? `原 Claude session: ${previousActualSessionId}` : undefined,
        stored.actualSessionId ? `新 Claude session: ${stored.actualSessionId}` : undefined,
        seed.trim() ? `种子回复: ${seed.trim()}` : undefined,
      ].filter(Boolean).join("\n"),
    };
  }

  buildArgsForTest(sessionId: string, prompt: string, options: CodexRunOptions = {}): string[] {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`claude session not found locally: ${sessionId}`);
    return this.buildArgs(stored, prompt, { collaborationMode: options.collaborationMode });
  }

  listPromptSlashCommands(): readonly string[] {
    return [...new Set([...this.promptSlashCommands, ...this.promptSkills])].sort();
  }

  async refreshPromptSlashCommands(): Promise<readonly string[]> {
    await this.refreshPromptCapabilities();
    return this.listPromptSlashCommands();
  }

  listPromptSkills(): readonly string[] {
    return [...this.promptSkills].sort();
  }

  async refreshPromptSkills(): Promise<readonly string[]> {
    await this.refreshPromptCapabilities();
    return this.listPromptSkills();
  }

  private async refreshPromptCapabilities(): Promise<void> {
    if (this.promptSlashCommands.size > 0 || this.promptSkills.size > 0) return;
    this.promptCapabilityRefresh ??= this.probePromptCapabilities().finally(() => {
      this.promptCapabilityRefresh = undefined;
    });
    await this.promptCapabilityRefresh;
  }

  private async probePromptCapabilities(): Promise<void> {
    const args = ["-p", "/context", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"];
    const child = spawnClaude(this.claudeCommand, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) return;
    const closePromise = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.stderr.resume();
    const turnId = `claude-slash-probe-${Date.now()}`;
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseClaudeJsonLine(line, "claude-slash-probe", turnId);
      this.capturePromptCapabilities(parsed);
      if (parsed?.promptSlashCommands || parsed?.promptSkills) {
        child.kill("SIGTERM");
        break;
      }
    }
    await closePromise;
  }

  private async runOneShot(stored: ClaudeSessionRecord, prompt: string, options: { resume: boolean; permissionMode?: ClaudePermissionMode } = { resume: true }): Promise<string> {
    const args = this.buildArgs(stored, prompt, {
      resume: options.resume,
      permissionMode: options.permissionMode,
    });
    const child = spawnClaude(this.claudeCommand, args, {
      cwd: stored.session.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) throw new Error("claude print stdio is unavailable");
    const closePromise = new Promise<number | null>((resolve) => child.on("close", resolve));
    let stderr = "";
    let text = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const turnId = `claude-oneshot-${Date.now()}`;
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseClaudeJsonLine(line, stored.session.id, turnId);
      if (parsed?.actualSessionId) {
        stored.actualSessionId = parsed.actualSessionId;
        stored.session.backendSessionId = parsed.actualSessionId;
      }
      this.capturePromptCapabilities(parsed);
      if (parsed?.text) text += parsed.text;
      if (parsed?.event?.type === "turn.failed") stderr += parsed.event.error;
    }
    const code = await closePromise;
    stored.updatedAt = new Date().toISOString();
    if (code !== 0) throw new Error(stderr || `claude exited with code ${code}`);
    return text.trim();
  }

  private buildArgs(stored: ClaudeSessionRecord, prompt: string, overrides: { resume?: boolean; permissionMode?: ClaudePermissionMode; claudePermissionMode?: ClaudePermissionMode; collaborationMode?: CodexCollaborationMode } = {}): string[] {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (overrides.resume !== false && stored.actualSessionId) args.unshift("--resume", stored.actualSessionId);
    const modelPolicy = this.modelPolicyForSession(stored.session.id);
    if (modelPolicy.model) args.push("--model", modelPolicy.model);
    if (modelPolicy.claudeEffort) args.push("--effort", modelPolicy.claudeEffort);
    const runPolicy = this.runPolicyForSession(stored.session.id);
    const collaborationMode = overrides.collaborationMode ?? this.collaborationModeForSession(stored.session.id);
    const permissionMode = overrides.permissionMode ?? overrides.claudePermissionMode ?? claudePermissionModeForPolicy(runPolicy, collaborationMode);
    args.push("--permission-mode", permissionMode);
    if (this.mcpConfigPath && permissionMode !== "bypassPermissions") {
      args.push("--mcp-config", this.mcpConfigPath);
      if (this.strictMcpConfig) args.push("--strict-mcp-config");
    }
    if (this.permissionPromptTool && permissionMode !== "bypassPermissions") {
      args.push("--permission-prompt-tool", this.permissionPromptTool);
    }
    if (runPolicy.permissionMode === "full") {
      args.push("--allow-dangerously-skip-permissions");
    }
    return args;
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

  private capturePromptCapabilities(parsed: ParsedClaudeJsonLine | undefined): void {
    if (!parsed) return;
    if (parsed.promptSlashCommands) {
      for (const command of parsed.promptSlashCommands) this.promptSlashCommands.add(command);
    }
    if (parsed.promptSkills) {
      for (const skill of parsed.promptSkills) this.promptSkills.add(skill);
    }
  }
}

function mergeDiscoveredClaudeSessionSummaries(localSessions: CodexSessionSummary[], discovered: ClaudeSdkSessionInfo[]): CodexSessionSummary[] {
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

function cloneRunPolicy(policy: CodexRunPolicy): CodexRunPolicy {
  return { ...policy };
}

function normalizePermissionPromptTool(value: string | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function cloneModelPolicy(policy: CodexModelPolicy): CodexModelPolicy {
  return { ...policy };
}

function claudePermissionModeForPolicy(policy: CodexRunPolicy, collaborationMode: CodexCollaborationMode): ClaudePermissionMode {
  if (collaborationMode === "plan") return "plan";
  if (policy.claudePermissionMode) return policy.claudePermissionMode;
  return policy.permissionMode === "full" ? "bypassPermissions" : "default";
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
      provider: "Claude Code",
      reasoningEffort: policy.reasoningEffort ?? policy.claudeEffort ?? null,
      serviceTier: policy.serviceTier ?? null,
    },
  };
}

function claudeModel(
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

export interface ParsedClaudeJsonLine {
  actualSessionId?: string;
  text?: string;
  event?: CodexEvent;
  promptSlashCommands?: string[];
  promptSkills?: string[];
}

export function parseClaudeJsonLine(line: string, sessionId: string, turnId: string): ParsedClaudeJsonLine | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      session_id?: string;
      message?: {
        content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
      };
      delta?: { type?: string; text?: string };
      result?: string;
      error?: string | { message?: string };
      tool_use?: { name?: string };
      name?: string;
      slash_commands?: unknown;
      skills?: unknown;
    };
    const actualSessionId = parsed.session_id;
    if (parsed.type === "assistant" && parsed.message?.content?.length) {
      const text = parsed.message.content
        .filter((item) => item.type === "text" && item.text)
        .map((item) => item.text)
        .join("\n");
      const tool = parsed.message.content.find((item) => item.type === "tool_use");
      if (text) return { actualSessionId, text, event: { type: "assistant.delta", sessionId, turnId, text } };
      if (tool?.name === "ExitPlanMode" && isObject(tool.input)) {
        const plan = stringField(tool.input, "plan");
        if (plan) return { actualSessionId, text: plan, event: { type: "assistant.plan", sessionId, turnId, text: plan } };
      }
      if (tool?.name) {
        return { actualSessionId, event: { type: "assistant.progress", sessionId, turnId, text: `正在调用工具: ${tool.name}`, kind: progressKindForTool(tool.name) } };
      }
    }
    if (parsed.type === "content_block_delta" && parsed.delta?.text) {
      return { actualSessionId, text: parsed.delta.text, event: { type: "assistant.delta", sessionId, turnId, text: parsed.delta.text } };
    }
    if (parsed.type === "result" && parsed.result) {
      return { actualSessionId, text: parsed.result, event: { type: "assistant.completed", sessionId, turnId, text: parsed.result } };
    }
    if (parsed.type === "error") {
      return { actualSessionId, event: { type: "turn.failed", sessionId, turnId, error: errorText(parsed.error) } };
    }
    if (parsed.type === "system" && parsed.subtype) {
      const progress = claudeSystemProgress(parsed.subtype);
      return {
        actualSessionId,
        event: progress ? { type: "assistant.progress", sessionId, turnId, text: progress, kind: "other" } : undefined,
        promptSlashCommands: parsed.subtype === "init" ? promptSlashCommandsFromInit(parsed.slash_commands) : undefined,
        promptSkills: parsed.subtype === "init" ? promptSkillsFromInit(parsed.skills) : undefined,
      };
    }
    return actualSessionId ? { actualSessionId } : undefined;
  } catch {
    return { text: line };
  }
}

function claudeSystemProgress(subtype: string): string | undefined {
  if (subtype === "init" || subtype === "task_started" || subtype === "task_notification") return undefined;
  return `Claude Code: ${subtype}`;
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
    : isObject(value)
      ? stringField(value, "name") ?? stringField(value, "command")
      : undefined;
  const normalized = raw?.trim().replace(/^\/+/, "").toLowerCase();
  return normalized || undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function errorText(error: string | { message?: string } | undefined): string {
  if (!error) return "claude error";
  if (typeof error === "string") return error;
  return error.message ?? "claude error";
}

function progressKindForTool(name: string): CodexProgressKind {
  const normalized = name.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("file")) return "file_change";
  if (normalized.includes("search") || normalized.includes("web")) return "search";
  if (normalized.includes("todo") || normalized.includes("task")) return "todo";
  return "tool";
}

function truncatePrompt(prompt: string, maxLength = 120): string {
  const normalized = prompt.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
