import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

test("Claude native option capture script requires explicit env gate", () => {
  const result = spawnSync(process.execPath, ["scripts/capture-claude-native-options.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, /CHAT_CODEX_CAPTURE_CLAUDE_OPTIONS=1/);
});

test("Claude native option compare script normalizes evidence with BOM", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-options-test-"));
  const evidencePath = path.join(dir, "evidence.json");
  fs.writeFileSync(evidencePath, `﻿${JSON.stringify({
    schemaVersion: 1,
    caseName: "bash-current",
    events: [{
      toolName: "Bash",
      input: { command: "npm test" },
      permission: {
        toolUseID: "toolu-test",
        suggestions: [{
          type: "addRules",
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        }],
      },
    }],
  })}`);

  try {
    const result = spawnSync(process.execPath, ["scripts/compare-claude-native-options.mjs", "--evidence", evidencePath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.evidence.caseName, "bash-current");
    assert.equal(output.normalized[0].approvalOptionCount, 3);
    assert.equal(output.normalized[0].approvalOptions[1].description, "Yes, and don't ask again for: npm *");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
