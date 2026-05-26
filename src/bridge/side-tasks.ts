import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { CodexAdapter, CodexCollaborationMode, CodexProgressKind, CodexRunApprovalContextRegistration } from "../codex/types.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { TurnScheduler } from "./turn-scheduler.js";
import type { BridgeDelivery } from "./delivery.js";
import { BridgeProgressDelivery } from "./progress-delivery.js";
import { commandBody, truncateForChannel } from "./formatters.js";

export interface BridgeSideTasksOptions {
  codex: CodexAdapter;
  state: MemoryStateStore;
  approvals: ApprovalManager;
  turnScheduler: TurnScheduler;
  transcript?: TranscriptSink;
  delivery: BridgeDelivery;
  defaultWorkdir(): string;
  currentSessionCwd(routeKey: string): string | undefined;
  currentCollaborationMode(routeKey: string): CodexCollaborationMode | undefined;
  deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy;
  shouldDeliverProgressWithPolicy(
    policy: ChannelDeliveryPolicy,
    routeKey: string,
    kind: CodexProgressKind | undefined,
  ): boolean;
}

export class BridgeSideTasks {
  private readonly codex: CodexAdapter;
  private readonly state: MemoryStateStore;
  private readonly approvals: ApprovalManager;
  private readonly turnScheduler: TurnScheduler;
  private readonly delivery: BridgeDelivery;
  private readonly defaultWorkdir: BridgeSideTasksOptions["defaultWorkdir"];
  private readonly currentSessionCwd: BridgeSideTasksOptions["currentSessionCwd"];
  private readonly currentCollaborationMode: BridgeSideTasksOptions["currentCollaborationMode"];
  private readonly deliveryPolicyFor: BridgeSideTasksOptions["deliveryPolicyFor"];
  private readonly progressDelivery: BridgeProgressDelivery;
  private readonly tasks = new Map<string, Promise<void>>();
  private nextId = 1;

  constructor(options: BridgeSideTasksOptions) {
    this.codex = options.codex;
    this.state = options.state;
    this.approvals = options.approvals;
    this.turnScheduler = options.turnScheduler;
    this.delivery = options.delivery;
    this.defaultWorkdir = options.defaultWorkdir;
    this.currentSessionCwd = options.currentSessionCwd;
    this.currentCollaborationMode = options.currentCollaborationMode;
    this.deliveryPolicyFor = options.deliveryPolicyFor;
    this.progressDelivery = new BridgeProgressDelivery({
      delivery: this.delivery,
      transcript: options.transcript,
      shouldDeliverProgress: options.shouldDeliverProgressWithPolicy,
    });
  }

  get size(): number {
    return this.tasks.size;
  }

  async start(message: ChannelMessage, target: ChannelTarget, rawText: string): Promise<void> {
    const prompt = commandBody(rawText, "btw");
    if (!prompt) {
      await this.delivery.sendText(target, "用法: `/btw <后台任务>`。后台任务会在旁路 session 中执行，不会切换当前会话。");
      return;
    }
    const taskId = this.nextTaskId();
    const task = this.runTask(taskId, message, target, prompt).finally(() => {
      this.tasks.delete(taskId);
    });
    this.tasks.set(taskId, task);
    await this.delivery.sendText(target, `已启动 BTW 后台任务 \`${taskId}\`。完成后会在这里回报。`);
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.all([...this.tasks.values()]);
    }
  }

  clearAll(): void {
    this.tasks.clear();
    this.progressDelivery.clearAll();
  }

  private async runTask(taskId: string, message: ChannelMessage, target: ChannelTarget, prompt: string): Promise<void> {
    const cwd = this.currentSessionCwd(message.routeKey) ?? this.defaultWorkdir();
    const session = await this.codex.startSession({
      routeKey: `${message.routeKey}:btw:${taskId}`,
      cwd,
      title: `btw:${taskId}`,
    });
    const syntheticRouteKey = this.progressKey(taskId, message.routeKey);
    const deliveryPolicy = this.deliveryPolicyFor(message);
    let currentTurnStartedAt: string | undefined;
    let finalText = "";
    let approvalContextRegistration: CodexRunApprovalContextRegistration | undefined;

    try {
      await this.turnScheduler.run({
        routeKey: syntheticRouteKey,
        sessionId: session.id,
        enqueuedAt: new Date().toISOString(),
      }, async () => {
        for await (const event of this.codex.run(session.id, prompt, this.currentCollaborationMode(message.routeKey) ? { collaborationMode: this.currentCollaborationMode(message.routeKey) } : undefined)) {
          if (event.type === "turn.started") {
            currentTurnStartedAt = event.startedAt ?? new Date().toISOString();
            const registeredApprovalContext = this.codex.registerRunApprovalContext?.({
              routeKey: message.routeKey,
              requestedBy: message.sender.id,
              target,
              sessionId: session.id,
              turnId: event.turnId,
              cwd: session.cwd,
            });
            if (registeredApprovalContext) approvalContextRegistration = registeredApprovalContext;
            this.state.setSessionStatus(session.id, {
              type: "running",
              turnId: event.turnId,
              task: truncateForChannel(prompt, 120),
              startedAt: currentTurnStartedAt,
            });
          } else if (event.type === "assistant.progress") {
            await this.progressDelivery.handleProgress({
              routeKey: syntheticRouteKey,
              target,
              policy: deliveryPolicy,
              text: `BTW ${taskId}: ${event.text}`,
              kind: event.kind,
            });
          } else if (event.type === "assistant.delta") {
            finalText += event.text;
          } else if (event.type === "assistant.completed") {
            finalText = event.text;
          } else if (event.type === "approval.requested") {
            this.state.setSessionStatus(session.id, {
              type: "waiting_approval",
              detail: event.approval.reason ?? event.approval.kind,
              startedAt: currentTurnStartedAt,
            });
            const pending = this.approvals.create(message.routeKey, message.sender.id, event.approval);
            await this.delivery.sendApprovalTextUntilDelivered(message.routeKey, target, pending);
          } else if (event.type === "turn.completed") {
            this.state.setSessionStatus(session.id, { type: "idle" });
          } else if (event.type === "turn.failed") {
            this.state.setSessionStatus(session.id, { type: "failed", error: event.error });
            await this.finishWithFallback(syntheticRouteKey, target, deliveryPolicy, `BTW 任务 ${taskId} 失败: ${event.error}`);
            return;
          }
        }
        await this.progressDelivery.flushRoute(syntheticRouteKey);
        if (finalText.trim()) {
          await this.finishWithFallback(syntheticRouteKey, target, deliveryPolicy, `BTW 任务 ${taskId} 完成:\n${finalText.trim()}`);
        }
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.state.setSessionStatus(session.id, { type: "failed", error: messageText });
      await this.finishWithFallback(syntheticRouteKey, target, deliveryPolicy, `BTW 任务 ${taskId} 失败: ${messageText}`);
    } finally {
      await approvalContextRegistration?.dispose();
      await this.progressDelivery.flushRoute(syntheticRouteKey);
      this.progressDelivery.clearRoute(syntheticRouteKey);
    }
  }

  private async finishWithFallback(routeKey: string, target: ChannelTarget, policy: ChannelDeliveryPolicy, text: string): Promise<void> {
    const updated = await this.progressDelivery.finishRoute(routeKey, target, policy, text);
    if (!updated) await this.delivery.sendText(target, text);
  }

  private nextTaskId(): string {
    return `btw-${this.nextId++}`;
  }

  private progressKey(taskId: string, routeKey: string): string {
    return `${routeKey}:btw:${taskId}`;
  }
}
