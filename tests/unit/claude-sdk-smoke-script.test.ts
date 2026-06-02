import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

test("package exposes an explicit Claude SDK approval smoke command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["smoke:claude-sdk"], "npm run build && node scripts/smoke-claude-sdk-approval.mjs");
  assert.equal(packageJson.scripts?.["smoke:claude-sdk:real"], "npm run build && node scripts/smoke-claude-sdk-approval.mjs --real");
});

test("Claude SDK approval smoke script has fast help output", () => {
  const result = spawnSync(process.execPath, ["scripts/smoke-claude-sdk-approval.mjs", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude SDK approval smoke/i);
  assert.match(result.stdout, /npm run smoke:claude-sdk/);
  assert.match(result.stdout, /deterministic local harness/i);
  assert.match(result.stdout, /--real/);
  assert.match(result.stdout, /--debug-sdk/);
  assert.match(result.stdout, /diagnos/i);
});

test("Claude SDK approval smoke defaults to deterministic local harness", () => {
  const result = spawnSync(process.execPath, ["scripts/smoke-claude-sdk-approval.mjs", "--timeout-ms=5000"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deterministic local harness/i);
  assert.match(result.stdout, /approval prompt received/i);
  assert.match(result.stdout, /Claude SDK approval smoke passed/i);
  assert.match(result.stdout, /node -e/);
  assert.match(result.stdout, /Buffer\.from\(process\.argv\[1\],'base64'\)/);
  assert.doesNotMatch(result.stdout, /\btouch\b/);
  assert.doesNotMatch(result.stdout, /Claude command:/);
});

test("default integration tests do not include the opt-in Claude SDK smoke skip", () => {
  const bridgeMockTest = fs.readFileSync(path.join(repoRoot, "tests/integration/bridge-mock.test.ts"), "utf8");

  assert.equal(bridgeMockTest.includes("CHAT_CODEX_CLAUDE_SDK_SMOKE"), false);
});
