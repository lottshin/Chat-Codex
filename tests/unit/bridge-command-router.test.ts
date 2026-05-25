import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalDecision } from "../../src/approvals/types.js";
import type { PlanWorkflowChoice } from "../../src/bridge/plan-workflow.js";
import type { AiBackend } from "../../src/backend/metadata.js";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeCommandRouter, isBridgeCommandName, type BridgeCommandHandlers } from "../../src/bridge/command-router.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY, normalizeChannelDeliveryPolicy } from "../../src/protocol/delivery-policy.js";

test("BridgeCommandRouter supports /bridge-* aliases in Claude profile", async () => {
  const fixture = routerFixture({ backend: "claude", commandProfile: "claude" });

  await fixture.router.handle(message(), target(), "bridge-status", [], "/bridge-status");
  await fixture.router.handle(message(), target(), "bridge-usage", [], "/bridge-usage");
  await fixture.router.handle(message(), target(), "bridge-compact", [], "/bridge-compact");
  await fixture.router.handle(message(), target(), "stop", [], "/stop");

  assert.equal(fixture.sent.includes("status"), true);
  assert.equal(fixture.sent.includes("usage"), true);
  assert.equal(fixture.calls.compact, 1);
  assert.equal(fixture.calls.model, 0);
});

test("BridgeCommandRouter treats known root commands as local in Claude profile", async () => {
  const fixture = routerFixture({ backend: "claude", commandProfile: "claude" });

  assert.equal(fixture.router.isBridgeCommand(message(), "help"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "status"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "usage"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "dir"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "show"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "sendfile"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "model"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "permission"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "compact"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "progress"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "plan"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "ok"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "1"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "bridge-help"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "bridge-usage"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "bridge-dir"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "bridge-status"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "bridge-sendfile"), true);
  assert.equal(fixture.router.isBridgeCommand(message(), "claude-api"), false);
  assert.equal(fixture.router.isBridgeCommand(message(), "missing"), false);
});

test("BridgeCommandRouter classifies bridge-owned command names", () => {
  assert.equal(isBridgeCommandName("compact"), true);
  assert.equal(isBridgeCommandName("usage"), true);
  assert.equal(isBridgeCommandName("dir"), true);
  assert.equal(isBridgeCommandName("show"), true);
  assert.equal(isBridgeCommandName("plan"), true);
  assert.equal(isBridgeCommandName("permission"), true);
  assert.equal(isBridgeCommandName("simplify"), false);
  assert.equal(isBridgeCommandName("claude-api"), false);
});

test("BridgeCommandRouter sends unknown command help text", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "missing", [], "/missing");
  assert.equal(fixture.sent.at(-1), "未知命令: /missing\n下一步：发送 /help 查看可用命令。");
});

test("BridgeCommandRouter points Claude profile bridge errors to root help", async () => {
  const fixture = routerFixture({ backend: "claude", commandProfile: "claude" });
  await fixture.router.handle(message(), target(), "bridge-missing", [], "/bridge-missing");
  assert.equal(fixture.sent.at(-1), "未知 Chat-Codex 命令: /bridge-missing\n下一步：发送 /help 查看 Chat-Codex 可用命令；未知根 slash 命令会在 Claude Code 支持时转发。");
});

test("BridgeCommandRouter handles refresh commands before normal dispatch", async () => {
  const fixture = routerFixture({
    deliveryPolicyFor: () => normalizeChannelDeliveryPolicy({
      ...DEFAULT_CHANNEL_DELIVERY_POLICY,
      refreshCommands: [{ command: "fff", description: "刷新", silent: false, replyText: "已静默刷新。" }],
    }),
  });
  await fixture.router.handle(message(), target(), "fff", [], "/fff");
  assert.equal(fixture.sent.at(-1), "已静默刷新。");
  assert.equal(fixture.calls.model, 0);
});

test("BridgeCommandRouter rejects semantic mutations while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "model", ["gpt-next", "xhigh"], "/model gpt-next xhigh");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.match(fixture.sent.at(-1) ?? "", /下一步.*\/stop/);
  assert.equal(fixture.calls.model, 0);
});

test("BridgeCommandRouter routes usage command without busy rejection", async () => {
  const fixture = routerFixture({ busy: true, backend: "claude", commandProfile: "claude" });
  await fixture.router.handle(message(), target(), "usage", [], "/usage");
  await fixture.router.handle(message(), target(), "bridge-usage", [], "/bridge-usage");

  assert.equal(fixture.calls.usage, 2);
  assert.equal(fixture.sent.at(-2), "usage");
  assert.equal(fixture.sent.at(-1), "usage");
});

test("BridgeCommandRouter routes dir command without busy rejection", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "dir", ["set", "/repo"], "/dir set /repo");
  await fixture.router.handle(message(), target(), "bridge-dir", [], "/bridge-dir");

  assert.equal(fixture.calls.dir, 2);
  assert.deepEqual(fixture.dirCalls, [["set", "/repo"], []]);
});

test("BridgeCommandRouter routes compact command", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "compact", [], "/compact");
  assert.equal(fixture.calls.compact, 1);
});

test("BridgeCommandRouter rejects compact while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "compact", [], "/compact");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.equal(fixture.calls.compact, 0);
});

test("BridgeCommandRouter routes clear as a new-session command", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "clear", ["confirm"], "/clear confirm");
  assert.equal(fixture.calls.createNewSession, 1);
  assert.deepEqual(fixture.newSessionCall?.args, ["clear", "confirm"]);
});

test("BridgeCommandRouter rejects clear while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "clear", ["confirm"], "/clear confirm");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.equal(fixture.calls.createNewSession, 0);
});

test("BridgeCommandRouter passes /new args and raw text to the handler", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "new", ["chat", "hello"], "/new chat hello");
  assert.equal(fixture.calls.createNewSession, 1);
  assert.deepEqual(fixture.newSessionCall?.args, ["chat", "hello"]);
  assert.equal(fixture.newSessionCall?.rawText, "/new chat hello");
});

test("BridgeCommandRouter rejects /new chat while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "new", ["chat"], "/new chat");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.equal(fixture.calls.createNewSession, 0);
});

test("BridgeCommandRouter lets non-mutating progress commands dispatch", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "progress", ["silent"], "/progress silent");
  assert.equal(fixture.calls.progressMode, 1);
});

test("BridgeCommandRouter routes context refresh command and treats changes as busy mutations", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "context-refresh", ["reload"], "/context-refresh reload");
  assert.equal(fixture.calls.contextRefresh, 1);

  const busy = routerFixture({ busy: true });
  await busy.router.handle(message(), target(), "context-refresh", ["reload"], "/context-refresh reload");
  assert.equal(busy.calls.contextRefresh, 0);
  assert.match(busy.sent.at(-1) ?? "", /上下文刷新/);
});

test("BridgeCommandRouter lets context refresh status dispatch while busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "context-refresh", [], "/context-refresh");
  assert.equal(fixture.calls.contextRefresh, 1);
});

test("BridgeCommandRouter routes group receive command without route busy guard", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "group", ["on"], "/group on");
  assert.equal(fixture.calls.groupReceive, 1);
  assert.deepEqual(fixture.groupReceiveCall?.args, ["on"]);
  assert.equal(fixture.groupReceiveCall?.commandName, "group");
});

test("BridgeCommandRouter honors disabled progress command policy", async () => {
  const fixture = routerFixture({
    deliveryPolicyFor: () => normalizeChannelDeliveryPolicy({
      ...DEFAULT_CHANNEL_DELIVERY_POLICY,
      progressCommand: "disabled",
      progressDisabledMessage: "当前渠道已禁用进度投递，/progress 和 /mode 不可用。",
      refreshCommands: [],
    }),
  });
  await fixture.router.handle(message(), target(), "progress", ["detailed"], "/progress detailed");
  await fixture.router.handle(message(), target(), "mode", ["detailed"], "/mode detailed");
  assert.equal(fixture.sent.at(-2), "当前渠道已禁用进度投递，/progress 和 /mode 不可用。");
  assert.equal(fixture.sent.at(-1), "当前渠道已禁用进度投递，/progress 和 /mode 不可用。");
  assert.equal(fixture.calls.progressMode, 0);
});

test("BridgeCommandRouter rejects unsupported Claude commands before handlers", async () => {
  const fixture = routerFixture({ backend: "claude" });

  await fixture.router.handle(message(), target(), "goal", [], "/goal");
  assert.match(fixture.sent.at(-1) ?? "", /Claude Code.*\/goal/);
  assert.equal(fixture.calls.approval, 0);
});

test("BridgeCommandRouter allows numeric approval replies", async () => {
  const fixture = routerFixture();

  await fixture.router.handle(message(), target(), "1", [], "/1");
  await fixture.router.handle(message(), target(), "2", [], "/2");
  await fixture.router.handle(message(), target(), "3", [], "/3");

  assert.deepEqual(fixture.approvalDecisions, ["approve", "approve-session", "deny"]);
});

test("BridgeCommandRouter maps numeric approval replies from latest approval choices", async () => {
  const fixture = routerFixture({ latestApprovalDecisions: ["approve", "deny"] });

  await fixture.router.handle(message(), target(), "1", [], "/1");
  await fixture.router.handle(message(), target(), "2", [], "/2");

  assert.deepEqual(fixture.approvalDecisions, ["approve", "deny"]);
});

test("BridgeCommandRouter routes plan workflow shortcuts when no approval is pending", async () => {
  const fixture = routerFixture({ hasPlanWorkflow: true });

  await fixture.router.handle(message(), target(), "1", [], "/1");
  await fixture.router.handle(message(), target(), "2", [], "/2");
  await fixture.router.handle(message(), target(), "3", ["more"], "/3 more");
  await fixture.router.handle(message(), target(), "4", [], "/4");

  assert.deepEqual(fixture.planWorkflowChoices, ["execute", "edit", "replan", "cancel"]);
});

test("BridgeCommandRouter keeps approval shortcuts ahead of plan workflow", async () => {
  const fixture = routerFixture({ hasPlanWorkflow: true, latestApprovalDecisions: ["approve", "deny"] });

  await fixture.router.handle(message(), target(), "1", [], "/1");
  await fixture.router.handle(message(), target(), "2", [], "/2");

  assert.deepEqual(fixture.approvalDecisions, ["approve", "deny"]);
  assert.deepEqual(fixture.planWorkflowChoices, []);
});

test("BridgeCommandRouter treats /4 as unknown when no shortcut is pending", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "4", [], "/4");
  assert.equal(fixture.sent.at(-1), "未知命令: /4\n下一步：发送 /help 查看可用命令。");
});

test("BridgeCommandRouter routes explicit plan workflow commands", async () => {
  const fixture = routerFixture();

  await fixture.router.handle(message(), target(), "plan-execute", [], "/plan-execute");
  await fixture.router.handle(message(), target(), "plan-edit", [], "/plan-edit");
  await fixture.router.handle(message(), target(), "replan", ["more"], "/replan more");
  await fixture.router.handle(message(), target(), "plan-cancel", [], "/plan-cancel");

  assert.deepEqual(fixture.planWorkflowChoices, ["execute", "edit", "replan", "cancel"]);
});

test("BridgeCommandRouter keeps named approval aliases stable", async () => {
  const fixture = routerFixture({ latestApprovalDecisions: ["approve", "deny"] });

  await fixture.router.handle(message(), target(), "ok", [], "/OK");
  await fixture.router.handle(message(), target(), "no", [], "/NO");

  assert.deepEqual(fixture.approvalDecisions, ["approve", "deny"]);
});

test("BridgeCommandRouter routes show commands", async () => {
  const fixture = routerFixture({ backend: "claude", commandProfile: "claude" });

  await fixture.router.handle(message(), target(), "show", ["files"], "/show files");
  await fixture.router.handle(message(), target(), "bridge-show", ["status"], "/bridge-show status");

  assert.equal(fixture.sent.at(-2), "show:show:files");
  assert.equal(fixture.sent.at(-1), "show:bridge-show:status");
});

test("BridgeCommandRouter routes sendfile with the original command name", async () => {
  const codex = routerFixture();
  await codex.router.handle(message(), target(), "sendfile", ["生成报告"], "/sendfile 生成报告");

  assert.equal(codex.calls.sendFile, 1);
  assert.deepEqual(codex.sendFileCall, { rawText: "/sendfile 生成报告", commandName: "sendfile" });

  const claudeRoot = routerFixture({ backend: "claude", commandProfile: "claude" });
  await claudeRoot.router.handle(message(), target(), "sendfile", ["生成报告"], "/sendfile 生成报告");

  assert.equal(claudeRoot.calls.sendFile, 1);
  assert.deepEqual(claudeRoot.sendFileCall, { rawText: "/sendfile 生成报告", commandName: "sendfile" });

  const claudeAlias = routerFixture({ backend: "claude", commandProfile: "claude" });
  await claudeAlias.router.handle(message(), target(), "bridge-sendfile", ["生成报告"], "/bridge-sendfile 生成报告");

  assert.equal(claudeAlias.calls.sendFile, 1);
  assert.deepEqual(claudeAlias.sendFileCall, { rawText: "/bridge-sendfile 生成报告", commandName: "bridge-sendfile" });
});

test("BridgeCommandRouter allows supported Claude command handlers", async () => {
  const fixture = routerFixture({ backend: "claude" });

  await fixture.router.handle(message(), target(), "model", ["sonnet"], "/model sonnet");
  await fixture.router.handle(message(), target(), "plan", [], "/plan");
  await fixture.router.handle(message(), target(), "permission", ["auto"], "/permission auto");
  await fixture.router.handle(message(), target(), "compact", [], "/compact");
  await fixture.router.handle(message(), target(), "sendfile", ["生成报告"], "/sendfile 生成报告");

  assert.equal(fixture.calls.model, 1);
  assert.equal(fixture.calls.collaborationMode, 1);
  assert.equal(fixture.calls.permission, 1);
  assert.equal(fixture.calls.compact, 1);
  assert.equal(fixture.calls.sendFile, 1);
});

test("BridgeCommandRouter allows supported Codex commands by default", async () => {
  const fixture = routerFixture();

  await fixture.router.handle(message(), target(), "model", ["gpt-next"], "/model gpt-next");
  await fixture.router.handle(message(), target(), "compact", [], "/compact");
  await fixture.router.handle(message(), target(), "ok", [], "/OK");
  await fixture.router.handle(message(), target(), "sendfile", ["生成报告"], "/sendfile 生成报告");

  assert.equal(fixture.calls.model, 1);
  assert.equal(fixture.calls.compact, 1);
  assert.equal(fixture.calls.approval, 1);
  assert.equal(fixture.calls.sendFile, 1);
});

function routerFixture(options: {
  backend?: AiBackend;
  commandProfile?: "codex" | "claude";
  busy?: boolean;
  deliveryPolicyFor?: () => ReturnType<typeof normalizeChannelDeliveryPolicy>;
  latestApprovalDecisions?: ApprovalDecision[];
  hasPlanWorkflow?: boolean;
} = {}) {
  const sent: string[] = [];
  const calls = {
    createNewSession: 0,
    usage: 0,
    dir: 0,
    model: 0,
    progressMode: 0,
    contextRefresh: 0,
    groupReceive: 0,
    collaborationMode: 0,
    permission: 0,
    compact: 0,
    approval: 0,
    sendFile: 0,
    planWorkflow: 0,
  };
  let newSessionCall: { args: string[]; rawText: string } | undefined;
  const dirCalls: string[][] = [];
  let groupReceiveCall: { args: string[]; commandName: string } | undefined;
  let sendFileCall: { rawText: string; commandName: string } | undefined;
  const approvalDecisions: string[] = [];
  const planWorkflowChoices: PlanWorkflowChoice[] = [];
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
        return { channelId: "mock", messageId: `m-${sent.length}`, deliveredAt: new Date().toISOString() };
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  const handlers: BridgeCommandHandlers = {
    help: () => "help",
    createNewSession: async (_message, _target, args, rawText) => {
      calls.createNewSession += 1;
      newSessionCall = { args, rawText };
    },
    dir: async (_message, _target, args) => {
      calls.dir += 1;
      dirCalls.push(args);
    },
    usage: async () => {
      calls.usage += 1;
      return "usage";
    },
    status: async () => "status",
    show: async (_message, args, commandName) => `show:${commandName}:${args.join(",")}`,
    sessions: async () => "sessions",
    resumeOrUseSession: async () => undefined,
    cancel: async () => undefined,
    whoami: () => "whoami",
    debug: async () => "debug",
    collaborationMode: async () => {
      calls.collaborationMode += 1;
    },
    goal: async () => undefined,
    progressMode: async () => {
      calls.progressMode += 1;
    },
    contextRefresh: async () => {
      calls.contextRefresh += 1;
    },
    groupReceive: async (_message, _target, args, commandName) => {
      calls.groupReceive += 1;
      groupReceiveCall = { args, commandName };
    },
    groupName: async () => undefined,
    sendFile: async (_message, _target, rawText, commandName) => {
      calls.sendFile += 1;
      sendFileCall = { rawText, commandName };
    },
    model: async () => {
      calls.model += 1;
    },
    permission: async () => {
      calls.permission += 1;
    },
    approval: async (_message, _target, _args, decision) => {
      calls.approval += 1;
      approvalDecisions.push(decision);
    },
    latestApprovalDecisions: () => options.latestApprovalDecisions ? { availableDecisions: options.latestApprovalDecisions } : undefined,
    hasPlanWorkflow: () => options.hasPlanWorkflow ?? false,
    planWorkflow: async (_message, _target, choice) => {
      calls.planWorkflow += 1;
      planWorkflowChoices.push(choice);
    },
    stop: async () => undefined,
    compact: async () => {
      calls.compact += 1;
    },
  };
  return {
    sent,
    calls,
    get newSessionCall() {
      return newSessionCall;
    },
    dirCalls,
    get groupReceiveCall() {
      return groupReceiveCall;
    },
    get sendFileCall() {
      return sendFileCall;
    },
    approvalDecisions,
    planWorkflowChoices,
    router: new BridgeCommandRouter({
      backend: options.backend,
      commandProfile: options.commandProfile ?? "codex",
      logger: new SilentLogger(),
      delivery,
      deliveryPolicyFor: options.deliveryPolicyFor ?? (() => DEFAULT_CHANNEL_DELIVERY_POLICY),
      isRouteExecutionBusy: async () => options.busy ?? false,
      handlers,
    }),
  };
}

function message(): ChannelMessage {
  return {
    id: "message-1",
    routeKey: "mock:default:direct:user",
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "mock:default:direct:user",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  };
}
