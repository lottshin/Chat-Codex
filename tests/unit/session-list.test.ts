import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionList, formatSessionListPage, matchSessionListItems, paginateSessionList } from "../../src/bridge/session-list.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import type { CodexAdapter, CodexSessionSummary } from "../../src/codex/types.js";

test("buildSessionList uses native Claude session id as the visible identity", async () => {
  const state = new MemoryStateStore();
  state.bindSession("route-a", {
    id: "claude-local-1",
    cwd: "D:/repo/bridge",
    title: "Bridge record",
    createdAt: "2026-05-29T00:00:00.000Z",
    backend: "claude",
    backendSessionId: "native-claude-1",
  });
  const codex = listOnlyAdapter([{
    id: "native-claude-1",
    backend: "claude",
    backendSessionId: "native-claude-1",
    cwd: "D:/repo/native",
    title: "Native Claude Code",
    status: { type: "idle" },
    updatedAt: "2026-05-29T01:00:00.000Z",
  }]);

  const items = await buildSessionList({ state, codex, routeKey: "route-a", scope: "selectable" });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, "native-claude-1");
  assert.equal(items[0]?.backendSessionId, "native-claude-1");
  assert.equal(items[0]?.localSessionId, "claude-local-1");
  assert.equal(items[0]?.current, true);
  const text = formatSessionListPage(paginateSessionList(items, "selectable", 1), {
    title: "Resume sessions",
    scopeLabel: "recent",
    emptyText: "No sessions",
    selectionMode: true,
  });
  assert.match(text, /Session: `native-claude-1`/);
  assert.doesNotMatch(text, /Claude session: `native-claude-1`/);
  assert.match(text, /Bridge session: `claude-local-1`/);
  assert.equal(matchSessionListItems(items, "claude-local-1")[0]?.id, "native-claude-1");
});

function listOnlyAdapter(sessions: CodexSessionSummary[]): CodexAdapter {
  return {
    startSession: async () => { throw new Error("not implemented"); },
    resumeSession: async () => { throw new Error("not implemented"); },
    run: async function* () { return; },
    getStatus: async () => ({ type: "idle" }),
    listSessions: async () => sessions,
  };
}
