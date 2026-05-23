import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  CHAT_CLAUDE_BIN_ENV,
  formatClaudeCommandSource,
  formatClaudeUnavailableError,
  parseNpmCmdShimTarget,
  resolveClaudeCommand,
} from "../../src/claude/claude-process.js";

test("resolveClaudeCommand keeps non-Windows default lightweight", () => {
  const resolved = resolveClaudeCommand({ platform: "darwin", arch: "arm64", env: {} });

  assert.equal(resolved.command, "claude");
  assert.equal(resolved.requested, "claude");
  assert.equal(resolved.source, "default");
  assert.equal(resolved.platform, "darwin");
  assert.equal(resolved.arch, "arm64");
});

test("resolveClaudeCommand honors CHAT_CLAUDE_BIN override", () => {
  const resolved = resolveClaudeCommand({
    platform: "darwin",
    arch: "arm64",
    env: { [CHAT_CLAUDE_BIN_ENV]: "/opt/claude/bin/claude" },
  });

  assert.equal(resolved.command, "/opt/claude/bin/claude");
  assert.equal(resolved.source, "env");
  assert.equal(formatClaudeCommandSource(resolved.source), CHAT_CLAUDE_BIN_ENV);
});

test("resolveClaudeCommand resolves Windows npm cmd shim through PATH and PATHEXT", () => {
  const binDir = "D:\\env\\nvm\\nodejs";
  const cmdPath = path.win32.join(binDir, "claude.cmd");
  const files = new Set([cmdPath.toLowerCase()]);
  const resolved = resolveClaudeCommand({
    platform: "win32",
    arch: "x64",
    cwd: "C:\\work",
    env: {
      Path: binDir,
      PATHEXT: ".EXE;.CMD",
    },
    fileExists: (filePath) => files.has(path.win32.normalize(filePath).toLowerCase()),
  });

  assert.equal(resolved.command, cmdPath);
  assert.equal(resolved.source, "path");
  assert.equal(resolved.pathResolved, true);
  assert.equal(resolved.shim, "cmd");
});

test("parseNpmCmdShimTarget extracts npm-generated Claude wrapper target", () => {
  const commandPath = "D:\\env\\nvm\\nodejs\\claude.cmd";
  const content = [
    "@ECHO off",
    "SETLOCAL",
    "SET dp0=%~dp0",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*",
  ].join("\n");

  assert.equal(
    parseNpmCmdShimTarget(commandPath, content),
    "D:\\env\\nvm\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
  );
});

test("resolveClaudeCommand resolves Windows explicit path without extension", () => {
  const exePath = "D:\\Tools With Spaces\\claude.exe";
  const resolved = resolveClaudeCommand({
    claudeBin: "D:\\Tools With Spaces\\claude",
    platform: "win32",
    arch: "x64",
    env: {},
    fileExists: (filePath) => path.win32.normalize(filePath).toLowerCase() === exePath.toLowerCase(),
  });

  assert.equal(resolved.command, exePath);
  assert.equal(resolved.source, "explicit");
  assert.equal(resolved.pathResolved, true);
});

test("formatClaudeUnavailableError includes Windows diagnostics", () => {
  const resolved = resolveClaudeCommand({
    platform: "win32",
    arch: "x64",
    env: { [CHAT_CLAUDE_BIN_ENV]: "D:\\env\\nvm\\nodejs\\claude.cmd" },
  });

  const message = formatClaudeUnavailableError(resolved, "spawn failed");
  assert.match(message, /平台: win32 x64/);
  assert.match(message, /where\.exe claude/);
  assert.match(message, new RegExp(CHAT_CLAUDE_BIN_ENV));
});
