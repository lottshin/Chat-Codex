#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyApprovalSmokeFailure, summarizeSdkMessageForLog } from "./smoke-claude-sdk-diagnostics.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const DEFAULT_TIMEOUT_MS = 90_000;

const help = `Claude SDK approval smoke

Runs a deterministic local harness through the Chat-Codex Bridge and verifies:
- Claude asks for tool approval
- /1 approves the request through the bridge
- the approved command resumes and creates a local marker file

Use --real to run the live Claude Code / provider smoke instead.

Usage:
  npm run smoke:claude-sdk
  npm run smoke:claude-sdk:real
  node scripts/smoke-claude-sdk-approval.mjs [--real] [--timeout-ms=90000] [--keep-temp] [--debug-sdk] [--debug-file=<path>]

Notes:
  The default smoke is deterministic and does not require Claude Code or network access.
  The live --real smoke requires a working Claude Code / Claude Agent SDK environment.
  On failure, the live smoke prints a diagnostic code so SDK/model/tool-call failures are
  distinguishable from Bridge approval delivery failures.
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
  ensureDistBuild();
  if (args.real) {
    await runRealSmoke();
    return;
  }
  await runHarnessSmoke();
}

function ensureDistBuild() {
  const distBridge = path.join(repoRoot, "dist", "src", "bridge", "bridge.js");
  if (!fs.existsSync(distBridge)) {
    throw new Error("dist build is missing. Run `npm run build` before running this smoke.");
  }
}

async function runHarnessSmoke() {
  const {
    ApprovalManager,
    Bridge,
    BridgeDelivery,
    ChannelRegistry,
    ClaudeApprovalService,
    ClaudeSdkAdapter,
    MockChannelAdapter,
    SilentLogger,
  } = await importRuntimeModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-claude-sdk-smoke-"));
  const fileName = `bridge-sdk-approval-${Date.now()}.tmp`;
  const filePath = path.join(tempDir, fileName);
  const toolName = "Bash";
  const command = buildMarkerCommand(filePath);
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
  const approvalRequests = [];
  const delivery = new BridgeDelivery({
    channels: new ChannelRegistry({ channels: [channel], logger }),
    approvals,
    logger,
    transcript,
    approvalSendRetryDelayMs: 1,
    backend: "claude",
  });
  const approvalService = countApprovalRequests(new ClaudeApprovalService({ approvals, delivery, logger }), approvalRequests);
  const adapter = new ClaudeSdkAdapter({
    client: loggingClaudeSdkClient(createHarnessClaudeSdkClient({ markerPath: filePath }), sdkMessages),
    approvalService,
  });
  const bridge = new Bridge({ channel, codex: adapter, approvals, logger, transcript, cwd: repoRoot, backend: "claude", commandProfile: "claude" });

  const hardTimeoutMs = (args.timeoutMs * 2) + 30_000;
  const hardTimer = setTimeout(() => {
    console.error(`[smoke] hard timeout after ${hardTimeoutMs}ms; forcing exit.`);
    process.exit(124);
  }, hardTimeoutMs);
  let passed = false;
  await bridge.start();
  try {
    console.log("[smoke] running deterministic local harness");
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
    dumpFailureDiagnosis({ channel, sdkMessages, approvalRequests, markerFileExists: fs.existsSync(filePath) });
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

async function runRealSmoke() {
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
  const sdkDebugFile = args.debugSdk ? args.debugFile ?? path.join(tempDir, "claude-sdk-debug.log") : undefined;
  const fileName = `bridge-sdk-approval-${Date.now()}.tmp`;
  const filePath = path.join(tempDir, fileName);
  const toolName = "Bash";
  const command = buildMarkerCommand(filePath);
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
  const approvalRequests = [];
  const delivery = new BridgeDelivery({
    channels: new ChannelRegistry({ channels: [channel], logger }),
    approvals,
    logger,
    transcript,
    approvalSendRetryDelayMs: 1,
    backend: "claude",
  });
  const approvalService = countApprovalRequests(new ClaudeApprovalService({ approvals, delivery, logger }), approvalRequests);
  const adapter = new ClaudeSdkAdapter({
    client: loggingClaudeSdkClient(createClaudeSdkClient(), sdkMessages, sdkDebugFile ? { debug: true, debugFile: sdkDebugFile } : undefined),
    approvalService,
  });
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
    if (sdkDebugFile) console.log(`[smoke] Claude SDK debug file: ${sdkDebugFile}`);
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
    dumpFailureDiagnosis({ channel, sdkMessages, approvalRequests, markerFileExists: fs.existsSync(filePath) });
    console.error(`[smoke] prompt sent to Claude:\n${prompt}`);
    dumpChannelMessages(channel, transcriptMessages, sdkMessages);
    if (sdkDebugFile) dumpDebugFileTail(sdkDebugFile);
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
    debugFile: undefined,
    debugSdk: false,
    help: false,
    keepTemp: false,
    real: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (const arg of rawArgs) {
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--real") parsed.real = true;
    else if (arg === "--debug-sdk") parsed.debugSdk = true;
    else if (arg.startsWith("--debug-file=")) {
      const value = arg.slice("--debug-file=".length).trim();
      if (!value) throw new Error(`invalid debug file: ${arg}`);
      parsed.debugFile = path.resolve(value);
      parsed.debugSdk = true;
    }
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

function loggingClaudeSdkClient(client, sdkMessages, forcedOptions = undefined) {
  return {
    ...client,
    query(params) {
      const nextParams = forcedOptions
        ? { ...params, options: { ...params.options, ...forcedOptions } }
        : params;
      return loggingClaudeSdkQuery(client.query(nextParams), sdkMessages);
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

function createHarnessClaudeSdkClient({ markerPath }) {
  return {
    query(params) {
      return new HarnessClaudeSdkQuery(params, markerPath);
    },
  };
}

class HarnessClaudeSdkQuery {
  closed = false;
  phase = 0;

  constructor(params, markerPath) {
    this.params = params;
    this.markerPath = markerPath;
  }

  async next() {
    if (this.closed) return { done: true, value: undefined };
    if (this.phase === 0) {
      this.phase = 1;
      return {
        done: false,
        value: {
          type: "system",
          subtype: "init",
          session_id: "harness-session-1",
          tools: ["Bash"],
          mcp_servers: [],
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          claude_code_version: "2.1.154",
          slash_commands: [],
          skills: [],
          agents: [],
          plugins: [],
        },
      };
    }
    if (this.phase === 1) {
      this.phase = 2;
      const command = buildMarkerCommand(this.markerPath);
      const result = await this.params.options?.canUseTool?.("Bash", { command }, {
        signal: new AbortController().signal,
        toolUseID: "harness-tool-1",
        title: "Bash tool approval",
        displayName: "Bash",
        description: "Create the local smoke marker",
        decisionReason: "deterministic local harness",
      });
      if (result?.behavior === "allow") {
        fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
        fs.writeFileSync(this.markerPath, "approved\n", "utf8");
        return {
          done: false,
          value: {
            type: "result",
            subtype: "success",
            session_id: "harness-session-1",
            result: "marker created",
          },
        };
      }
      return {
        done: false,
        value: {
          type: "result",
          subtype: "error",
          session_id: "harness-session-1",
          errors: ["approval denied"],
        },
      };
    }
    return { done: true, value: undefined };
  }

  async return(value) {
    this.closed = true;
    return { done: true, value };
  }

  async throw(error) {
    this.closed = true;
    throw error;
  }

  close() {
    this.closed = true;
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function loggingAsyncIterator(iterator, sdkMessages) {
  return {
    async next() {
      const next = await iterator.next();
      if (!next.done) sdkMessages.push(next.value);
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

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildMarkerCommand(filePath) {
  const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
  return `node -e "const fs=require('node:fs');const path=require('node:path');const file=Buffer.from(process.argv[1],'base64').toString('utf8');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'approved\\n','utf8');" ${quoteShell(encodedPath)}`;
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

function countApprovalRequests(approvalService, approvalRequests) {
  return {
    requestPermission(payload, context) {
      approvalRequests.push({ payload, context });
      return approvalService.requestPermission(payload, context);
    },
  };
}

function dumpFailureDiagnosis({ channel, sdkMessages, approvalRequests, markerFileExists }) {
  const diagnosis = classifyApprovalSmokeFailure({
    sdkMessages,
    approvalRequestCount: approvalRequests.length,
    approvalPromptSeen: hasApprovalPrompt(channel),
    markerFileExists,
  });
  console.error(`[smoke] diagnosis: ${diagnosis.code}`);
  console.error(`[smoke] diagnosis detail: ${diagnosis.detail}`);
  for (const hint of diagnosis.hints) console.error(`[smoke] diagnosis hint: ${hint}`);
}

function dumpChannelMessages(channel, transcriptMessages, sdkMessages) {
  const textMessages = channel.sentMessages.map((message, index) => `[text ${index + 1}] ${message.text}`);
  const updatedMessages = channel.updatedMessages.map((message, index) => `[update ${index + 1}] ${message.text}`);
  const actionMessages = channel.sentActionMessages.map((item, index) => `[action ${index + 1}] ${item.message.text}`);
  const sdkMessageLines = sdkMessages.map(summarizeSdkMessageForLog);
  const messages = [...textMessages, ...updatedMessages, ...actionMessages, ...transcriptMessages, ...sdkMessageLines];
  if (!messages.length) {
    console.error("[smoke] no bridge messages were sent before timeout.");
    return;
  }
  console.error("[smoke] bridge messages before failure:");
  for (const message of messages.slice(-12)) console.error(message);
}

function dumpDebugFileTail(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[smoke] Claude SDK debug file was not created: ${filePath}`);
    return;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const tail = content.slice(-5000).trim();
    if (!tail) {
      console.error(`[smoke] Claude SDK debug file is empty: ${filePath}`);
      return;
    }
    console.error(`[smoke] Claude SDK debug tail (${filePath}):`);
    console.error(tail);
  } catch (error) {
    console.error(`[smoke] failed to read Claude SDK debug file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
