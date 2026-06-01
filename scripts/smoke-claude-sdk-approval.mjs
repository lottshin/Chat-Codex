#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const DEFAULT_TIMEOUT_MS = 90_000;

const help = `Claude SDK approval smoke

Runs a real Claude Agent SDK turn through the Chat-Codex Bridge and verifies:
- Claude asks for tool approval
- /1 approves the request through the bridge
- the approved command resumes and creates a local marker file

Usage:
  npm run smoke:claude-sdk
  node scripts/smoke-claude-sdk-approval.mjs [--timeout-ms=90000] [--keep-temp]

Notes:
  This is a real smoke test. It requires a working Claude Code / Claude Agent SDK
  environment and network access. It is intentionally separate from npm test.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(help);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[smoke] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const distBridge = path.join(repoRoot, "dist", "src", "bridge", "bridge.js");
  if (!fs.existsSync(distBridge)) {
    throw new Error("dist build is missing. Run `npm run build` before running this smoke.");
  }

  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  if (Number.isFinite(nodeMajor) && nodeMajor < 22) {
    console.warn(`[smoke] warning: current Node is ${process.version}; package.json declares node >=22. Continuing for local smoke compatibility.`);
  }

  const claude = probeClaudeCommand();
  if (!claude.ok) {
    throw new Error([
      "Claude Code command is not available to this process.",
      "Checked PATH candidates for claude, claude.exe, claude.cmd, and claude.bat.",
      "Open a shell where `claude --version` works, then rerun `npm run smoke:claude-sdk`.",
      claude.detail,
    ].filter(Boolean).join("\n"));
  }
  console.log(`[smoke] Claude command: ${claude.command}`);
  console.log(`[smoke] ${claude.version}`);

  const {
    ApprovalManager,
    Bridge,
    BridgeDelivery,
    ChannelRegistry,
    ClaudeApprovalService,
    ClaudeSdkAdapter,
    createClaudeSdkClient,
    MockChannelAdapter,
    SilentLogger,
  } = await importRuntimeModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-claude-sdk-smoke-"));
  const fileName = `bridge-sdk-approval-${Date.now()}.tmp`;
  const filePath = path.join(tempDir, fileName);
  const toolName = process.platform === "win32" ? "PowerShell" : "Bash";
  const command = process.platform === "win32" ? `New-Item -ItemType File -Path ${quotePowerShell(filePath)} -Force` : `touch ${quoteShell(filePath)}`;
  const prompt = [
    "This is an automated smoke test.",
    `Use the ${toolName} tool exactly once.`,
    `Run exactly this command and no other command: ${command}`,
    "Do not explain before using the tool.",
  ].join("\n");

  const channel = new MockChannelAdapter();
  const transcriptMessages = [];
  const transcript = {
    inbound(_message, text) {
      transcriptMessages.push(`[transcript inbound] ${text}`);
    },
    outbound(_target, text) {
      transcriptMessages.push(`[transcript outbound] ${text}`);
    },
    localProgress(_target, text) {
      transcriptMessages.push(`[transcript progress] ${text}`);
    },
    outboundMedia(_target, media) {
      transcriptMessages.push(`[transcript media] ${media.type}: ${media.name ?? media.path ?? media.url ?? ""}`);
    },
  };
  const approvals = new ApprovalManager();
  const logger = new SilentLogger();
  const sdkMessages = [];
  const delivery = new BridgeDelivery({
    channels: new ChannelRegistry({ channels: [channel], logger }),
    approvals,
    logger,
    transcript,
    approvalSendRetryDelayMs: 1,
    backend: "claude",
  });
  const approvalService = new ClaudeApprovalService({ approvals, delivery, logger });
  const adapter = new ClaudeSdkAdapter({ client: loggingClaudeSdkClient(createClaudeSdkClient(), sdkMessages), approvalService });
  const bridge = new Bridge({ channel, codex: adapter, approvals, logger, transcript, cwd: repoRoot, backend: "claude", commandProfile: "claude" });

  const hardTimeoutMs = (args.timeoutMs * 2) + 30_000;
  const hardTimer = setTimeout(() => {
    console.error(`[smoke] hard timeout after ${hardTimeoutMs}ms; forcing exit.`);
    process.exit(124);
  }, hardTimeoutMs);
  let passed = false;
  await bridge.start();
  try {
    console.log(`[smoke] temp dir: ${tempDir}`);
    console.log(`[smoke] tool under approval: ${toolName}`);
    console.log(`[smoke] command under approval: ${command}`);
    await channel.emitText("/new");

    const promptPromise = channel.emitText(prompt);
    await waitFor("Claude SDK approval prompt", () => hasApprovalPrompt(channel), args.timeoutMs);
    console.log("[smoke] approval prompt received; approving with /1");

    await channel.emitText("/1");
    await waitFor(`marker file ${fileName}`, () => fs.existsSync(filePath), args.timeoutMs);
    await promptPromise;
    passed = true;
    console.log(`[smoke] marker file created: ${filePath}`);
    console.log("[smoke] Claude SDK approval smoke passed.");
  } catch (error) {
    console.error(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[smoke] prompt sent to Claude:\n${prompt}`);
    dumpChannelMessages(channel, transcriptMessages, sdkMessages);
    console.error(`[smoke] temp dir kept for inspection: ${tempDir}`);
    process.exitCode = 1;
  } finally {
    const stopped = await stopBridge(bridge, 5_000);
    if (!stopped) {
      console.error("[smoke] bridge.stop() did not finish within 5000ms; forcing process exit.");
      process.exitCode = process.exitCode || 1;
    }
    if (passed && !args.keepTemp) fs.rmSync(tempDir, { recursive: true, force: true });
    clearTimeout(hardTimer);
    if (process.exitCode) process.exit(process.exitCode);
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    help: false,
    keepTemp: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (const arg of rawArgs) {
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--keep-temp") parsed.keepTemp = true;
    else if (arg.startsWith("--timeout-ms=")) {
      const value = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid timeout: ${arg}`);
      parsed.timeoutMs = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function importRuntimeModules() {
  const moduleRoot = pathToFileURL(path.join(repoRoot, "dist", "src")).href.replace(/\/$/, "");
  const [
    { ApprovalManager },
    { Bridge },
    { BridgeDelivery },
    { ChannelRegistry },
    { ClaudeApprovalService },
    { ClaudeSdkAdapter },
    { createClaudeSdkClient },
    { MockChannelAdapter },
    { SilentLogger },
  ] = await Promise.all([
    import(`${moduleRoot}/approvals/approval-manager.js`),
    import(`${moduleRoot}/bridge/bridge.js`),
    import(`${moduleRoot}/bridge/delivery.js`),
    import(`${moduleRoot}/channels/registry.js`),
    import(`${moduleRoot}/claude/approval-service.js`),
    import(`${moduleRoot}/claude/claude-sdk-adapter.js`),
    import(`${moduleRoot}/claude/claude-sdk-client.js`),
    import(`${moduleRoot}/channels/mock/mock-channel-adapter.js`),
    import(`${moduleRoot}/logging/logger.js`),
  ]);
  return {
    ApprovalManager,
    Bridge,
    BridgeDelivery,
    ChannelRegistry,
    ClaudeApprovalService,
    ClaudeSdkAdapter,
    createClaudeSdkClient,
    MockChannelAdapter,
    SilentLogger,
  };
}

function loggingClaudeSdkClient(client, sdkMessages) {
  return {
    ...client,
    query(params) {
      return loggingClaudeSdkQuery(client.query(params), sdkMessages);
    },
  };
}

function loggingClaudeSdkQuery(query, sdkMessages) {
  return new Proxy(query, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return () => loggingAsyncIterator(target[Symbol.asyncIterator](), sdkMessages);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function loggingAsyncIterator(iterator, sdkMessages) {
  return {
    async next() {
      const next = await iterator.next();
      if (!next.done) sdkMessages.push(formatSdkMessage(next.value));
      return next;
    },
    async return(value) {
      return iterator.return ? iterator.return(value) : { done: true, value };
    },
    async throw(error) {
      if (iterator.throw) return await iterator.throw(error);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function formatSdkMessage(message) {
  if (!message || typeof message !== "object") return `[sdk] ${String(message)}`;
  const type = typeof message.type === "string" ? message.type : "unknown";
  const subtype = typeof message.subtype === "string" ? `:${message.subtype}` : "";
  const session = typeof message.session_id === "string" ? ` session=${message.session_id}` : "";
  const text = message.message?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string")?.text;
  const tool = message.message?.content?.find?.((item) => item?.type === "tool_use" && typeof item.name === "string")?.name;
  const result = typeof message.result === "string" ? message.result : "";
  return [`[sdk ${type}${subtype}${session}]`, tool ? `tool=${tool}` : "", text ? `text=${text}` : "", result ? `result=${result}` : ""].filter(Boolean).join(" ");
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function probeClaudeCommand() {
  const candidates = claudePathCandidates();
  for (const command of [...candidates, "claude"]) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32" && (command === "claude" || /\.(?:cmd|bat)$/i.test(command)),
    });
    if (!result.error && result.status === 0) {
      return {
        ok: true,
        command,
        version: (result.stdout || result.stderr).trim(),
      };
    }
  }
  return {
    ok: false,
    detail: candidates.length ? `Candidates tried:\n${candidates.map((item) => `- ${item}`).join("\n")}` : "No PATH candidates found.",
  };
}

function claudePathCandidates() {
  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  const seen = new Set();
  const candidates = [];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const cleanEntry = entry.replace(/^"|"$/g, "");
    try {
      const stat = fs.statSync(cleanEntry);
      if (stat.isFile() && /^claude(?:\.(?:exe|cmd|bat))?$/i.test(path.basename(cleanEntry))) {
        addCandidate(cleanEntry);
      } else if (stat.isDirectory()) {
        for (const name of names) {
          const candidate = path.join(cleanEntry, name);
          if (fs.existsSync(candidate)) addCandidate(candidate);
        }
      }
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return candidates;

  function addCandidate(candidate) {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function stopBridge(bridge, timeoutMs) {
  return await Promise.race([
    bridge.stop().then(() => true, (error) => {
      console.error(`[smoke] bridge.stop() failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function hasApprovalPrompt(channel) {
  return channel.sentMessages.some((message) => message.text.includes("请选择处理方式"))
    || channel.sentActionMessages.some((item) => item.message.text.includes("请选择处理方式"));
}

function dumpChannelMessages(channel, transcriptMessages, sdkMessages) {
  const textMessages = channel.sentMessages.map((message, index) => `[text ${index + 1}] ${message.text}`);
  const updatedMessages = channel.updatedMessages.map((message, index) => `[update ${index + 1}] ${message.text}`);
  const actionMessages = channel.sentActionMessages.map((item, index) => `[action ${index + 1}] ${item.message.text}`);
  const messages = [...textMessages, ...updatedMessages, ...actionMessages, ...transcriptMessages, ...sdkMessages];
  if (!messages.length) {
    console.error("[smoke] no bridge messages were sent before timeout.");
    return;
  }
  console.error("[smoke] bridge messages before failure:");
  for (const message of messages.slice(-12)) console.error(message);
}
