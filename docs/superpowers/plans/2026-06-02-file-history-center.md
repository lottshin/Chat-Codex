# File History Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified recent file history so users can reliably refer to recently generated files, uploaded attachments, Feishu relay-folder files, and downloaded Drive files.

**Architecture:** Add a focused `FileHistoryStore` under `src/bridge/`, integrate it into `Bridge` for local files and attachments, and let `FeishuAdapter` use the same abstraction for relay-folder listings and downloads. Keep sendfile and Drive-download approvals unchanged.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing Bridge/Feishu adapter patterns.

---

### Task 1: FileHistoryStore Core

**Files:**
- Create: `src/bridge/file-history-store.ts`
- Test: `tests/unit/file-history-store.test.ts`

- [ ] **Step 1: Write failing tests**

Cover route isolation, TTL expiry, local media recording, inbound attachment recording, Feishu Drive listing recording, ordinal resolution, source filtering, ambiguity, unsupported Drive item, and `/files` formatting.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test dist/tests/unit/file-history-store.test.js`
Expected: fail because `file-history-store.js` does not exist.

- [ ] **Step 3: Implement minimal store**

Implement:

- `FileHistoryStore`
- `formatFileHistoryList`
- `fileHistoryExtractionFromLocalItems`
- `fileHistoryDriveDownloadRequestFromItem`

Keep the API small and deterministic. Do not add persistence.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm run build && node --test dist/tests/unit/file-history-store.test.js`
Expected: pass.

- [ ] **Step 5: Commit**

Commit message: `feat: add file history store`

### Task 2: Bridge Integration and /files

**Files:**
- Modify: `src/bridge/bridge.ts`
- Modify: `src/bridge/command-router.ts`
- Modify: `src/bridge/bridge-types.ts` if constructor options need dependency injection
- Test: `tests/integration/bridge-mock.test.ts`

- [ ] **Step 1: Write failing integration tests**

Cover:

- `/files` shows assistant-local deliverables.
- `/files` shows successfully downloaded inbound attachments.
- “发给我” resolves through file history and opens sendfile confirmation without starting Codex/Claude Code.
- Multiple matching local images ask for clarification instead of auto-selecting.
- Plain internet links do not enter file history.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build && node --test dist/tests/integration/bridge-mock.test.js --test-name-pattern "file history|recent files|/files"`
Expected: fail because `/files` and store integration are missing.

- [ ] **Step 3: Implement Bridge integration**

Add a `FileHistoryStore` instance to `Bridge`, record:

- visible assistant local deliverables in `recordRecentDeliverables`
- usable inbound attachments before they are consumed or forwarded

Add `/files` command handling through `BridgeCommandRouter`.

For send-to-user references, prefer `FileHistoryStore.resolveReference()` over the old `recentDeliverables` map. Preserve group restrictions and sendfile approval.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run the same targeted integration command.

- [ ] **Step 5: Commit**

Commit message: `feat: wire file history into bridge`

### Task 3: Feishu Relay Folder Integration

**Files:**
- Modify: `src/channels/feishu/feishu-adapter.ts`
- Modify: `src/bridge/file-history-store.ts` if Drive metadata needs one small API adjustment
- Test: `tests/unit/feishu-adapter.test.ts`

- [ ] **Step 1: Write failing Feishu tests**

Cover:

- Relay folder list records the shown order into file history.
- “下载第 2 个到桌面” resolves through file history.
- “把云盘里的图片保存到桌面” ignores older local image history and matches Drive image.
- Successful Drive download records the saved local file.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build && node --test dist/tests/unit/feishu-adapter.test.js --test-name-pattern "file history|relay folder|云盘"`
Expected: fail for missing unified history behavior.

- [ ] **Step 3: Implement Feishu integration**

Use `FileHistoryStore` for recent relay-folder file references while preserving existing Drive API calls and confirmation cards. Keep owner checks unchanged.

- [ ] **Step 4: Run targeted Feishu tests and verify GREEN**

Run the same targeted command.

- [ ] **Step 5: Commit**

Commit message: `feat: track Feishu Drive files in file history`

### Task 4: Documentation, Version, and Regression

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: Feishu-related docs if present
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`

- [ ] **Step 1: Add docs and version tests/checks**

Update docs for `/files` and natural recent-file references. Bump version from `0.3.3` to `0.4.0`.

- [ ] **Step 2: Run full verification**

Run:

- `npm test`
- `npm run smoke:claude-sdk`

Expected: pass.

- [ ] **Step 3: Final contract check**

Check:

- function contracts for empty/expired history
- naming consistency with `FileHistory`
- no new unapproved auto-send path
- docs and version synchronized
- Weixin and Feishu attachment paths covered

- [ ] **Step 4: Commit**

Commit message: `docs: document file history center`
