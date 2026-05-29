#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";

const ENABLE_ENV = "CHAT_CODEX_CAPTURE_CLAUDE_OPTIONS";
const CASES = {
  "bash-current": "Use Bash to run `node --version` and report the output.",
  "read-package": "Use the Read tool to read package.json from the current working directory and summarize the package name.",
  "write-probe": "Use the Write tool to create capture-claude-native-options-probe.txt containing exactly: capture probe",
};

function usage() {
  return [
    "Usage: CHAT_CODEX_CAPTURE_CLAUDE_OPTIONS=1 npm run smoke:claude-options:capture -- --case <name> [--out <path>]",
    "",
    `Available cases: ${Object.keys(CASES).join(", ")}`,
    "",
    "This manual script captures raw Claude SDK canUseTool permission metadata only.",
    "It denies captured tool requests and is not part of default CI.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { caseName: "bash-current", out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--case") {
      parsed.caseName = argv[i + 1];
      i += 1;
    } else if (arg === "--out") {
      parsed.out = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function sanitize(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  }
  return value;
}

function sanitizeString(value) {
  const home = process.env.USERPROFILE || process.env.HOME;
  const redacted = home ? value.replaceAll(home, "~") : value;
  return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}...<truncated>` : redacted;
}

function ensureParent(filePath) {
  const parent = path.dirname(path.resolve(filePath));
  fs.mkdirSync(parent, { recursive: true });
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

  if (args.help || process.env[ENABLE_ENV] !== "1") {
    console.log(usage());
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const prompt = CASES[args.caseName];
  if (!prompt) {
    console.error(`Unknown case: ${args.caseName}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const captured = [];
  const evidence = {
    schemaVersion: 1,
    caseName: args.caseName,
    prompt,
    metadata: {
      capturedWith: "scripts/capture-claude-native-options.mjs",
      node: process.version,
      platform: process.platform,
      cwd: sanitizeString(process.cwd()),
      envGate: ENABLE_ENV,
    },
    events: captured,
  };

  try {
    for await (const _message of query({
      prompt,
      options: {
        cwd: process.cwd(),
        permissionMode: "default",
        canUseTool: async (toolName, input, permissionOptions = {}) => {
          captured.push({
            toolName,
            input: sanitize(input),
            permission: sanitize({
              toolUseID: permissionOptions.toolUseID,
              title: permissionOptions.title,
              displayName: permissionOptions.displayName,
              description: permissionOptions.description,
              blockedPath: permissionOptions.blockedPath,
              decisionReason: permissionOptions.decisionReason,
              suggestions: permissionOptions.suggestions,
            }),
          });
          return {
            behavior: "deny",
            message: "Manual option evidence capture only; tool use denied after metadata capture.",
            interrupt: true,
            toolUseID: permissionOptions.toolUseID,
          };
        },
      },
    })) {
      // The permission callback is the evidence source; streamed messages are intentionally ignored.
    }
  } catch (error) {
    evidence.sdkError = {
      name: error?.name,
      message: error?.message,
    };
  }

  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.out) {
    ensureParent(args.out);
    fs.writeFileSync(args.out, json, "utf8");
  } else {
    process.stdout.write(json);
  }

  if (captured.length === 0) process.exitCode = 1;
}

await main();
