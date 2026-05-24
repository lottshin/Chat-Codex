import type { ApprovalDecision } from "../approvals/types.js";
import { decisionForNumericApprovalChoice } from "../approvals/choices.js";
import { backendSupportsFeature, unsupportedCommandMessage, type AiBackend, type BackendCommandFeature, type CommandNamespaceProfile } from "../backend/metadata.js";
import type { Logger } from "../logging/logger.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy, ChannelRefreshCommandPolicy } from "../protocol/delivery-policy.js";
import { normalizeDeliveryCommandName } from "../protocol/delivery-policy.js";
import type { CodexCollaborationMode } from "../codex/types.js";
import { ROUTE_BUSY_MUTATION_REJECT_TEXT } from "./bridge-types.js";
import { isRouteBusyMutationCommand } from "./formatters.js";
import type { BridgeDelivery } from "./delivery.js";
import type { PlanWorkflowChoice } from "./plan-workflow.js";

const BRIDGE_COMMAND_NAMES = new Set([
  "help",
  "new",
  "clear",
  "status",
  "session",
  "sessions",
  "all-sessions",
  "use",
  "resume",
  "cancel",
  "whoami",
  "debug",
  "plan",
  "plan-execute",
  "plan-edit",
  "plan-accept-edits",
  "replan",
  "plan-cancel",
  "code",
  "default",
  "goal",
  "progress",
  "mode",
  "context-refresh",
  "ctx-refresh",
  "context",
  "ctx",
  "group",
  "grop",
  "name",
  "sendfile",
  "model",
  "permission",
  "permissions",
  "perm",
  "policy",
  "ok",
  "yes",
  "1",
  "2",
  "3",
  "4",
  "p",
  "yes-session",
  "ok-session",
  "approve-session",
  "no",
  "approve",
  "deny",
  "reject",
  "stop",
  "compact",
]);

export function canonicalBridgeCommandName(name: string): string | undefined {
  const normalized = name.toLowerCase();
  if (isBridgeCommandName(normalized)) return normalized;
  if (normalized.startsWith("bridge-")) {
    const stripped = normalized.slice("bridge-".length);
    return isBridgeCommandName(stripped) ? stripped : undefined;
  }
  return undefined;
}

export function isBridgeAliasCommandName(name: string): boolean {
  return name.toLowerCase().startsWith("bridge-") && Boolean(canonicalBridgeCommandName(name));
}

export function isBridgeCommandName(name: string): boolean {
  return BRIDGE_COMMAND_NAMES.has(name.toLowerCase());
}

export interface BridgeCommandHandlers {
  help(message: ChannelMessage): string;
  createNewSession(message: ChannelMessage, target: ChannelTarget, args: string[], rawText: string): Promise<unknown>;
  status(message: ChannelMessage): Promise<string>;
  sessions(message: ChannelMessage, args: string[], commandName: string): Promise<string>;
  resumeOrUseSession(message: ChannelMessage, target: ChannelTarget, sessionRef: string | undefined): Promise<void>;
  cancel(message: ChannelMessage, target: ChannelTarget): Promise<void>;
  whoami(message: ChannelMessage): string;
  debug(message: ChannelMessage): Promise<string>;
  collaborationMode(
    message: ChannelMessage,
    target: ChannelTarget,
    mode: CodexCollaborationMode,
    rawText: string,
    commandName: string,
  ): Promise<void>;
  goal(message: ChannelMessage, target: ChannelTarget, rawText: string): Promise<void>;
  progressMode(message: ChannelMessage, target: ChannelTarget, rawMode: string | undefined): Promise<void>;
  contextRefresh(message: ChannelMessage, target: ChannelTarget, rawMode: string | undefined): Promise<void>;
  groupReceive(message: ChannelMessage, target: ChannelTarget, args: string[], commandName: string): Promise<void>;
  groupName(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
  sendFile(message: ChannelMessage, target: ChannelTarget, rawText: string, commandName: string): Promise<void>;
  model(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
  permission(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
  approval(message: ChannelMessage, target: ChannelTarget, args: string[], decision: ApprovalDecision): Promise<void>;
  latestApprovalDecisions?(routeKey: string): { availableDecisions?: ApprovalDecision[] } | undefined;
  hasPlanWorkflow?(routeKey: string): boolean;
  planWorkflow(message: ChannelMessage, target: ChannelTarget, choice: PlanWorkflowChoice, args: string[]): Promise<void>;
  stop(message: ChannelMessage, target: ChannelTarget): Promise<void>;
  compact(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
}

export interface BridgeCommandRouterOptions {
  backend?: AiBackend;
  commandProfile: CommandNamespaceProfile;
  logger: Logger;
  delivery: BridgeDelivery;
  deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy;
  isRouteExecutionBusy(routeKey: string): Promise<boolean>;
  handlers: BridgeCommandHandlers;
}

export class BridgeCommandRouter {
  private readonly backend?: AiBackend;
  private readonly commandProfile: CommandNamespaceProfile;
  private readonly logger: Logger;
  private readonly delivery: BridgeDelivery;
  private readonly deliveryPolicyFor: BridgeCommandRouterOptions["deliveryPolicyFor"];
  private readonly isRouteExecutionBusy: BridgeCommandRouterOptions["isRouteExecutionBusy"];
  private readonly handlers: BridgeCommandHandlers;

  constructor(options: BridgeCommandRouterOptions) {
    this.backend = options.backend;
    this.commandProfile = options.commandProfile;
    this.logger = options.logger;
    this.delivery = options.delivery;
    this.deliveryPolicyFor = options.deliveryPolicyFor;
    this.isRouteExecutionBusy = options.isRouteExecutionBusy;
    this.handlers = options.handlers;
  }

  async handle(
    message: ChannelMessage,
    target: ChannelTarget,
    name: string,
    args: string[],
    rawText: string,
  ): Promise<void> {
    const deliveryPolicy = this.deliveryPolicyFor(message);
    const refreshCommand = refreshCommandFor(deliveryPolicy, name);
    if (refreshCommand) {
      this.logger.info("channel refresh command received", {
        channel: message.channelId,
        command: refreshCommand.command,
        routeKey: message.routeKey,
      });
      if (!refreshCommand.silent) {
        await this.delivery.sendText(target, refreshCommand.replyText ?? "已刷新。");
      }
      return;
    }
    const canonicalName = canonicalBridgeCommandName(name) ?? name.toLowerCase();
    if (isRouteBusyMutationCommand(canonicalName, args, rawText) && await this.isRouteExecutionBusy(message.routeKey)) {
      await this.delivery.sendText(target, ROUTE_BUSY_MUTATION_REJECT_TEXT);
      return;
    }
    switch (canonicalName) {
      case "help":
        await this.delivery.sendText(target, this.handlers.help(message));
        return;
      case "new":
        await this.handlers.createNewSession(message, target, args, rawText);
        return;
      case "clear":
        await this.handlers.createNewSession(message, target, ["clear", ...args], rawText);
        return;
      case "status":
        await this.delivery.sendText(target, await this.handlers.status(message));
        return;
      case "session":
      case "sessions":
        await this.delivery.sendText(target, await this.handlers.sessions(message, args, name));
        return;
      case "all-sessions":
        await this.delivery.sendText(target, await this.handlers.sessions(message, args, name));
        return;
      case "use":
      case "resume":
        await this.handlers.resumeOrUseSession(message, target, args[0]);
        return;
      case "cancel":
        await this.handlers.cancel(message, target);
        return;
      case "whoami":
        await this.delivery.sendText(target, this.handlers.whoami(message));
        return;
      case "debug":
        await this.delivery.sendText(target, await this.handlers.debug(message));
        return;
      case "plan":
        if (await this.rejectUnsupported(target, "plan", "collaborationMode", "计划模式")) return;
        await this.handlers.collaborationMode(message, target, "plan", rawText, name);
        return;
      case "plan-execute":
        if (await this.rejectUnsupported(target, name, "collaborationMode", "计划工作流")) return;
        await this.handlers.planWorkflow(message, target, "execute", args);
        return;
      case "plan-edit":
      case "plan-accept-edits":
        if (await this.rejectUnsupported(target, name, "collaborationMode", "计划工作流")) return;
        await this.handlers.planWorkflow(message, target, "edit", args);
        return;
      case "replan":
        if (await this.rejectUnsupported(target, name, "collaborationMode", "计划工作流")) return;
        await this.handlers.planWorkflow(message, target, "replan", args);
        return;
      case "plan-cancel":
        if (await this.rejectUnsupported(target, name, "collaborationMode", "计划工作流")) return;
        await this.handlers.planWorkflow(message, target, "cancel", args);
        return;
      case "code":
      case "default":
        if (await this.rejectUnsupported(target, name, "collaborationMode", "协作模式切换")) return;
        await this.handlers.collaborationMode(message, target, "default", rawText, name);
        return;
      case "goal":
        if (await this.rejectUnsupported(target, "goal", "goal", "长期目标")) return;
        await this.handlers.goal(message, target, rawText);
        return;
      case "progress":
      case "mode":
        if (deliveryPolicy.progressCommand === "disabled") {
          await this.delivery.sendText(target, deliveryPolicy.progressDisabledMessage ?? "当前渠道已禁用进度投递，/progress 和 /mode 不可用。");
          return;
        }
        await this.handlers.progressMode(message, target, args[0]);
        return;
      case "context-refresh":
      case "ctx-refresh":
      case "context":
      case "ctx":
        await this.handlers.contextRefresh(message, target, args[0]);
        return;
      case "group":
      case "grop":
        await this.handlers.groupReceive(message, target, args, name);
        return;
      case "name":
        await this.handlers.groupName(message, target, args);
        return;
      case "sendfile":
        if (await this.rejectUnsupported(target, "sendfile", "sendfile", "文件发送协议")) return;
        await this.handlers.sendFile(message, target, rawText, name);
        return;
      case "model":
        if (await this.rejectUnsupported(target, "model", "model", "模型切换")) return;
        await this.handlers.model(message, target, args);
        return;
      case "permission":
      case "permissions":
      case "perm":
      case "policy":
        if (await this.rejectUnsupported(target, name, "runtimePermissionSwitch", "运行时权限切换")) return;
        await this.handlers.permission(message, target, args);
        return;
      case "ok":
      case "yes":
        if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
        await this.handlers.approval(message, target, [], "approve");
        return;
      case "1":
      case "2":
      case "3": {
        const latestApproval = this.handlers.latestApprovalDecisions?.(message.routeKey);
        if (latestApproval) {
          if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
          const decision = decisionForNumericApprovalChoice(latestApproval, name) ?? legacyNumericApprovalDecision(name);
          await this.handlers.approval(message, target, [], decision);
          return;
        }
        if (this.handlers.hasPlanWorkflow?.(message.routeKey)) {
          if (await this.rejectUnsupported(target, name, "collaborationMode", "计划工作流")) return;
          await this.handlers.planWorkflow(message, target, name === "1" ? "execute" : name === "2" ? "edit" : "replan", args);
          return;
        }
        if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
        await this.handlers.approval(message, target, [], legacyNumericApprovalDecision(name));
        return;
      }
      case "4":
        if (this.handlers.hasPlanWorkflow?.(message.routeKey)) {
          if (await this.rejectUnsupported(target, name, "collaborationMode", "计划工作流")) return;
          await this.handlers.planWorkflow(message, target, "cancel", args);
          return;
        }
        await this.delivery.sendText(target, unknownCommandMessage(name, this.commandProfile));
        return;
      case "p":
      case "yes-session":
      case "ok-session":
      case "approve-session":
        if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
        await this.handlers.approval(message, target, args, "approve-session");
        return;
      case "no":
        if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
        await this.handlers.approval(message, target, [], "deny");
        return;
      case "approve":
        if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
        await this.handlers.approval(message, target, args, "approve");
        return;
      case "deny":
      case "reject":
        if (await this.rejectUnsupported(target, name, "interactiveApprovals", "远程交互审批")) return;
        await this.handlers.approval(message, target, args, "deny");
        return;
      case "stop":
        await this.handlers.stop(message, target);
        return;
      case "compact":
        if (await this.rejectUnsupported(target, "compact", "compact", "上下文压缩")) return;
        await this.handlers.compact(message, target, args);
        return;
      default:
        await this.delivery.sendText(target, unknownCommandMessage(name, this.commandProfile));
    }
  }
  isBridgeCommand(message: ChannelMessage, name: string): boolean {
    if (refreshCommandFor(this.deliveryPolicyFor(message), name)) return true;
    if (this.commandProfile === "claude") {
      return this.isClaudeRootBridgeException(message, name) || isBridgeAliasCommandName(name);
    }
    return Boolean(canonicalBridgeCommandName(name));
  }

  private isClaudeRootBridgeException(message: ChannelMessage, name: string): boolean {
    const normalized = name.toLowerCase();
    if (normalized === "stop") return true;
    if (isApprovalAlias(normalized)) return Boolean(this.handlers.latestApprovalDecisions?.(message.routeKey));
    if (isNumericShortcut(normalized)) {
      return Boolean(this.handlers.latestApprovalDecisions?.(message.routeKey))
        || Boolean(this.handlers.hasPlanWorkflow?.(message.routeKey));
    }
    return false;
  }

  private async rejectUnsupported(
    target: ChannelTarget,
    command: string,
    feature: BackendCommandFeature,
    featureLabel: string,
  ): Promise<boolean> {
    if (backendSupportsFeature(this.backend, feature)) return false;
    await this.delivery.sendText(target, unsupportedCommandMessage(this.backend, command, featureLabel));
    return true;
  }
}

function unknownCommandMessage(name: string, commandProfile: CommandNamespaceProfile): string {
  if (commandProfile === "claude") {
    return [
      `未知 Chat-Codex 命令: /${name}`,
      "下一步：发送 /bridge-help 查看 Chat-Codex 可用命令；Claude Code 原生命令请直接发送根命令。",
    ].join("\n");
  }
  return `未知命令: /${name}\n下一步：发送 /help 查看可用命令。`;
}

function isApprovalAlias(name: string): boolean {
  return name === "ok"
    || name === "yes"
    || name === "p"
    || name === "yes-session"
    || name === "ok-session"
    || name === "approve-session"
    || name === "no"
    || name === "approve"
    || name === "deny"
    || name === "reject";
}

function isNumericShortcut(name: string): boolean {
  return name === "1" || name === "2" || name === "3" || name === "4";
}

function legacyNumericApprovalDecision(name: string): ApprovalDecision {
  if (name === "1") return "approve";
  if (name === "2") return "approve-session";
  return "deny";
}

function refreshCommandFor(
  policy: ChannelDeliveryPolicy,
  commandName: string,
): ChannelRefreshCommandPolicy | undefined {
  const normalized = normalizeDeliveryCommandName(commandName);
  return policy.refreshCommands.find((command) => normalizeDeliveryCommandName(command.command) === normalized);
}
