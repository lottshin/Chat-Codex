import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgeSessionFlow } from "../../src/bridge/session-flow.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { CodexSession, CodexSessionSummary, StartSessionInput } from "../../src/codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";

test("BridgeSessionFlow creates new sessions in the startup cwd", async () => {
  const fixture = sessionFlowFixture({ cwd: "/repo" });

  const session = await fixture.flow.createNewSession(message("route-a"), target("route-a"));

  assert.equal(session.cwd, "/repo");
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.match(fixture.sentTexts.at(-1) ?? "", /已创建新( Codex)?会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /Cwd: \/repo/);
});

test("BridgeSessionFlow updates default workdir only for future sessions", async () => {
  const fixture = sessionFlowFixture({ cwd: "/repo-a" });

  const first = await fixture.flow.createNewSession(message("route-a"), target("route-a"));
  fixture.flow.setDefaultWorkdir("/repo-b");
  const second = await fixture.flow.createNewSession(message("route-b"), target("route-b"));

  assert.equal(fixture.flow.defaultWorkdir(), "/repo-b");
  assert.equal(first.cwd, "/repo-a");
  assert.equal(second.cwd, "/repo-b");
});

test("BridgeSessionFlow creates Codex App chat sessions and syncs title", async () => {
  const fixture = sessionFlowFixture({ cwd: "/repo" });

  const session = await fixture.flow.createNewAppChatSession(message("route-a"), target("route-a"));

  assert.equal(session.cwd, "/repo");
  assert.equal(session.title, "mock / default / route-a");
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.deepEqual(fixture.codex.sessionTitles, [{ sessionId: session.id, title: "mock / default / route-a" }]);
  assert.deepEqual(fixture.codex.sessionPreviews, [{ sessionId: session.id, preview: "mock / default / route-a" }]);
  const text = fixture.sentTexts.at(-1) ?? "";
  assert.match(text, /已创建 Codex App 对话/);
  assert.match(text, /标题: mock \/ default \/ route-a/);
  assert.match(text, /已写入 Codex preview/);
});

test("BridgeSessionFlow keeps app chat binding when title sync fails", async () => {
  const codex = new FailingTitleCodexAdapter();
  const fixture = sessionFlowFixture({ codex });

  const session = await fixture.flow.createNewAppChatSession(message("route-a"), target("route-a"));

  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.match(fixture.sentTexts.at(-1) ?? "", /标题同步失败: title sync failed/);
});

test("BridgeSessionFlow binds an existing session by id", async () => {
  const fixture = sessionFlowFixture();
  const existing = await fixture.codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "use", existing.id);

  assert.equal(fixture.state.getBinding("route-a")?.sessionId, existing.id);
  assert.match(fixture.sentTexts.at(-1) ?? "", /已绑定 Codex 会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", new RegExp(existing.id));
});

test("BridgeSessionFlow reports owner conflicts without rebinding", async () => {
  const fixture = sessionFlowFixture();
  const existing = await fixture.codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });
  fixture.state.claimSessionOwner("route-other", existing.id);

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "use", existing.id);

  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.match(fixture.sentTexts.at(-1) ?? "", /无法绑定 Codex 会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /Owner: route-other/);
});

test("BridgeSessionFlow shows next steps while selecting a session", async () => {
  const fixture = sessionFlowFixture();
  await fixture.codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "use", undefined);
  await fixture.flow.handleSessionSelectionReply(message("route-a"), target("route-a"), "x");

  assert.match(fixture.sentTexts[0] ?? "", /下一步：直接回复编号完成切换/);
  assert.match(fixture.sentTexts[0] ?? "", /`n` 下一页/);
  assert.match(fixture.sentTexts[0] ?? "", /回复“取消”退出/);
  assert.match(fixture.sentTexts[1] ?? "", /下一步：请直接回复当前页列表编号/);
});

test("BridgeSessionFlow shows resume sessions by recent activity", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("old-session", "旧任务", "/repo/old", "2026-01-01T00:00:00.000Z"),
    sessionSummary("new-session", "新任务", "/repo/new", "2026-01-02T00:00:00.000Z"),
  ]);
  const fixture = sessionFlowFixture({ codex });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "resume", undefined);

  const text = fixture.sentTexts.at(-1) ?? "";
  assert.match(text, /恢复最近会话/);
  assert.match(text, /最近可恢复/);
  assert.ok(text.indexOf("new-session") < text.indexOf("old-session"));
});

test("BridgeSessionFlow resumes last recent non-current session", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("current-session", "当前任务", "/repo/current", "2026-01-03T00:00:00.000Z"),
    sessionSummary("last-session", "最近任务", "/repo/last", "2026-01-02T00:00:00.000Z"),
  ]);
  const fixture = sessionFlowFixture({ codex });
  fixture.state.bindSession("route-a", await codex.resumeSession("current-session"));

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "resume", "last");

  assert.equal(fixture.state.getBinding("route-a")?.sessionId, "last-session");
  assert.match(fixture.sentTexts.at(-1) ?? "", /last-session/);
});

test("BridgeSessionFlow resumes by unique title cwd and id fragments", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("alpha-session", "修复飞书通知", "/repo/feishu", "2026-01-03T00:00:00.000Z"),
    sessionSummary("beta-session", "整理文档", "/repo/docs", "2026-01-02T00:00:00.000Z"),
    sessionSummary("gamma-123", "其它任务", "/repo/other", "2026-01-01T00:00:00.000Z"),
  ]);

  const byTitle = sessionFlowFixture({ codex });
  await byTitle.flow.resumeOrUseSession(message("route-title"), target("route-title"), "resume", "飞书");
  assert.equal(byTitle.state.getBinding("route-title")?.sessionId, "alpha-session");

  const byCwd = sessionFlowFixture({ codex });
  await byCwd.flow.resumeOrUseSession(message("route-cwd"), target("route-cwd"), "resume", "docs");
  assert.equal(byCwd.state.getBinding("route-cwd")?.sessionId, "beta-session");

  const byId = sessionFlowFixture({ codex });
  await byId.flow.resumeOrUseSession(message("route-id"), target("route-id"), "resume", "gamma");
  assert.equal(byId.state.getBinding("route-id")?.sessionId, "gamma-123");
});

test("BridgeSessionFlow narrows ambiguous resume matches for numbered selection", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("feishu-new", "飞书通知新", "/repo/a", "2026-01-03T00:00:00.000Z"),
    sessionSummary("feishu-old", "飞书通知旧", "/repo/b", "2026-01-02T00:00:00.000Z"),
    sessionSummary("docs", "文档", "/repo/docs", "2026-01-01T00:00:00.000Z"),
  ]);
  const fixture = sessionFlowFixture({ codex });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "resume", "飞书");
  await fixture.flow.handleSessionSelectionReply(message("route-a"), target("route-a"), "2");

  assert.match(fixture.sentTexts[0] ?? "", /找到 2 个匹配的会话/);
  assert.doesNotMatch(fixture.sentTexts[0] ?? "", /docs/);
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, "feishu-old");
});

test("BridgeSessionFlow shows recent resume list for missing keyword", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("known-session", "已知任务", "/repo/known", "2026-01-01T00:00:00.000Z"),
  ]);
  const fixture = sessionFlowFixture({ codex });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "resume", "missing");

  const text = fixture.sentTexts.at(-1) ?? "";
  assert.match(text, /没有找到匹配 `missing` 的可恢复会话/);
  assert.match(text, /known-session/);
});

test("BridgeSessionFlow preserves resume exact-id owner conflict", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("owned-session", "已占用", "/repo/owned", "2026-01-01T00:00:00.000Z"),
  ]);
  const fixture = sessionFlowFixture({ codex });
  fixture.state.claimSessionOwner("route-other", "owned-session");

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "resume", "owned-session");

  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.match(fixture.sentTexts.at(-1) ?? "", /无法绑定 Codex 会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /Owner: route-other/);
});

test("BridgeSessionFlow keeps use exact-id semantics for last", async () => {
  const codex = new ListedCodexAdapter([
    sessionSummary("recent-session", "最近任务", "/repo/recent", "2026-01-01T00:00:00.000Z"),
  ]);
  const fixture = sessionFlowFixture({ codex });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), "use", "last");

  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.match(fixture.sentTexts.at(-1) ?? "", /没有找到 session `last`/);
});

test("BridgeSessionFlow keeps initial existing binding scoped to the first direct route", async () => {
  const codex = new MockCodexAdapter();
  const existing = await codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });
  const fixture = sessionFlowFixture({
    codex,
    initialRouteBinding: { type: "existing", sessionId: existing.id },
  });

  fixture.flow.claimPendingInitialRouteBindingRoute(message("route-a"));
  const otherSession = await fixture.flow.ensureSession(message("route-b"));
  const firstSession = await fixture.flow.ensureSession(message("route-a"));

  assert.notEqual(otherSession.id, existing.id);
  assert.equal(firstSession.id, existing.id);
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, existing.id);
  assert.equal(fixture.state.getBinding("route-b")?.sessionId, otherSession.id);
});

function sessionFlowFixture(options: {
  cwd?: string;
  codex?: MockCodexAdapter;
  initialRouteBinding?: { type: "existing"; sessionId: string } | { type: "new" };
} = {}) {
  const codex = options.codex ?? new MockCodexAdapter();
  const state = new MemoryStateStore();
  const sentTexts: string[] = [];
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sentTexts.push(text);
        return { channelId: "mock", messageId: `m-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  const flow = new BridgeSessionFlow({
    codex,
    state,
    delivery,
    cwd: options.cwd ?? "/workspace",
    initialRouteBinding: options.initialRouteBinding,
    unboundRoutePolicy: "auto_new",
    isRouteExecutionBusy: async () => false,
    applyStoredSessionRunPolicy: () => undefined,
    collaborationModeForRoute: () => "default",
    hasRouteCollaborationMode: () => false,
    applyRouteCollaborationModeToSession: () => undefined,
    syncRouteCollaborationModeFromSession: () => "default",
  });
  return { codex, state, flow, sentTexts };
}

class FailingTitleCodexAdapter extends MockCodexAdapter {
  override async setSessionTitle(_sessionId: string, _title: string): Promise<void> {
    throw new Error("title sync failed");
  }
}

class ListedCodexAdapter extends MockCodexAdapter {
  constructor(private readonly summaries: CodexSessionSummary[]) {
    super();
  }

  override async startSession(input: StartSessionInput): Promise<CodexSession> {
    const session = await super.startSession(input);
    this.summaries.push({
      id: session.id,
      routeKey: input.routeKey,
      title: session.title,
      cwd: session.cwd,
      status: { type: "idle" },
      updatedAt: session.createdAt,
    });
    return session;
  }

  override async resumeSession(sessionId: string): Promise<CodexSession> {
    const summary = this.summaries.find((session) => session.id === sessionId);
    if (!summary) return super.resumeSession(sessionId);
    return {
      id: summary.id,
      cwd: summary.cwd ?? "/workspace",
      createdAt: summary.updatedAt,
      title: summary.title,
      backend: summary.backend,
      backendSessionId: summary.backendSessionId,
    };
  }

  override async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    return this.summaries.filter((session) => routeKey ? session.routeKey === routeKey : true);
  }
}

function sessionSummary(id: string, title: string, cwd: string, updatedAt: string): CodexSessionSummary {
  return {
    id,
    routeKey: "seed",
    title,
    cwd,
    status: { type: "idle" },
    updatedAt,
  };
}

function message(routeKey: string): ChannelMessage {
  return {
    id: `message-${routeKey}`,
    routeKey,
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: routeKey, kind: "direct" },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function target(routeKey: string): ChannelTarget {
  return {
    channelId: "mock",
    routeKey,
    conversation: { id: routeKey, kind: "direct" },
    recipient: { id: "user" },
  };
}
