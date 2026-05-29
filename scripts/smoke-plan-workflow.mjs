#!/usr/bin/env node
import assert from "node:assert/strict";
import { Bridge } from "../dist/src/bridge/bridge.js";
import { MockChannelAdapter } from "../dist/src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../dist/src/codex/mock-codex-adapter.js";
import { codexInputPlainText } from "../dist/src/codex/input.js";

class PlanWorkflowSmokeAdapter extends MockCodexAdapter {
  prompts = [];
  modeRuns = [];
  permissionModeRuns = [];

  async *run(sessionId, prompt, options = {}) {
    const promptText = codexInputPlainText(prompt);
    this.prompts.push(promptText);
    this.modeRuns.push(options.collaborationMode);
    this.permissionModeRuns.push(options.claudePermissionMode);
    const turnId = `smoke-plan-${this.prompts.length}`;
    yield { type: "turn.started", sessionId, turnId };
    if (options.collaborationMode === "plan") {
      yield { type: "assistant.plan", sessionId, turnId, text: `# Smoke plan\n- ${promptText}` };
    } else {
      yield { type: "assistant.completed", sessionId, turnId, text: `executed: ${promptText}` };
    }
    yield { type: "turn.completed", sessionId, turnId };
  }
}

async function smokePlanChoice(choice, expectedPermissionMode) {
  const channel = new MockChannelAdapter({ buttons: true });
  const codex = new PlanWorkflowSmokeAdapter();
  const bridge = new Bridge({ channel, codex, backend: "claude", commandProfile: "claude" });
  await bridge.start();
  try {
    await channel.emitText("/plan smoke the plan workflow");
    await bridge.waitForIdle();
    assert.equal(codex.modeRuns[0], "plan");
    assert.ok(channel.sentActionMessages.some((item) => item.message.text.includes("Claude 已写好计划")), "plan choices were not rendered");

    await channel.emitText(choice);
    await bridge.waitForIdle();
    assert.deepEqual(codex.modeRuns, ["plan", "default"]);
    assert.deepEqual(codex.permissionModeRuns, [undefined, expectedPermissionMode]);
    assert.ok(codex.prompts[1]?.includes("Smoke plan"), "accepted plan was not sent back for execution");
  } finally {
    await bridge.stop();
  }
}

await smokePlanChoice("/1", "auto");
await smokePlanChoice("/2", "default");
console.log("plan workflow smoke passed: /1 -> auto, /2 -> manual approvals");
