#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { normalizeClaudePermissionPrompt } from "../dist/src/claude/permission-prompt.js";

function usage() {
  return [
    "Usage: npm run smoke:claude-options:compare -- --evidence <path>",
    "",
    "Reads manual native-option evidence and reports current Local Agent Bridge normalized approval choices.",
    "Run npm run build first, or use the npm script which does it for you.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { evidence: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--evidence") {
      parsed.evidence = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readEvidence(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
}

function normalizeEvent(event, index) {
  const permission = event.permission && typeof event.permission === "object" ? event.permission : {};
  return normalizeClaudePermissionPrompt({
    tool_name: event.toolName,
    tool_use_id: permission.toolUseID ?? `evidence-${index + 1}`,
    input: event.input,
    title: permission.title,
    displayName: permission.displayName,
    description: permission.description,
    blockedPath: permission.blockedPath,
    decisionReason: permission.decisionReason,
    suggestions: permission.suggestions,
  }, {
    sessionId: "native-option-evidence",
    turnId: "compare",
    cwd: process.cwd(),
  });
}

function summarizeApprovalOptions(options = []) {
  return options.map((option) => ({
    id: option.id,
    decision: option.decision,
    label: option.label,
    description: option.description,
    hasUpdatedPermissions: Array.isArray(option.updatedPermissions) && option.updatedPermissions.length > 0,
  }));
}

function compareEvidence(evidence) {
  const events = Array.isArray(evidence.events) ? evidence.events : [];
  return {
    schemaVersion: 1,
    evidence: {
      caseName: evidence.caseName,
      capturedEvents: events.length,
      sdkError: evidence.sdkError,
    },
    normalized: events.map((event, index) => {
      const result = normalizeEvent(event, index);
      if (!result.ok) return { index, toolName: event.toolName, ok: false, reason: result.reason };
      return {
        index,
        toolName: event.toolName,
        ok: true,
        kind: result.approval.kind,
        command: result.approval.command,
        availableDecisions: result.approval.availableDecisions,
        permissionSuggestionCount: Array.isArray(result.approval.permissionSuggestions) ? result.approval.permissionSuggestions.length : 0,
        approvalOptionCount: Array.isArray(result.approval.approvalOptions) ? result.approval.approvalOptions.length : 0,
        approvalOptions: summarizeApprovalOptions(result.approval.approvalOptions),
      };
    }),
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (args.help || !args.evidence) {
    console.log(usage());
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const evidence = readEvidence(args.evidence);
  process.stdout.write(`${JSON.stringify(compareEvidence(evidence), null, 2)}\n`);
}

await main();
