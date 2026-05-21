import {
  formatClaudeUnavailableError,
  resolveClaudeCommand,
  spawnClaude,
  type ClaudeBinSource,
  type ClaudeCommandResolution,
} from "./claude-process.js";

export interface ClaudeCliStatus {
  available: boolean;
  claudeBin: string;
  requestedClaudeBin: string;
  claudeBinSource: ClaudeBinSource;
  platform: string;
  arch: string;
  command: ClaudeCommandResolution;
  version?: string;
  error?: string;
}

export async function checkClaudeCli(claudeBin?: string, timeoutMs = 5000): Promise<ClaudeCliStatus> {
  const command = resolveClaudeCommand({ claudeBin });
  return new Promise((resolve) => {
    const child = spawnClaude(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const baseStatus = {
      claudeBin: command.command,
      requestedClaudeBin: command.requested,
      claudeBinSource: command.source,
      platform: command.platform,
      arch: command.arch,
      command,
    };
    if (!child.stdout || !child.stderr) {
      resolve({
        available: false,
        ...baseStatus,
        error: formatClaudeUnavailableError(command, "claude --version stdio is unavailable"),
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        available: false,
        ...baseStatus,
        error: formatClaudeUnavailableError(command, `claude --version timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ available: false, ...baseStatus, error: formatClaudeUnavailableError(command, error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ available: true, ...baseStatus, version: stdout.trim() || stderr.trim() });
      } else {
        resolve({
          available: false,
          ...baseStatus,
          error: formatClaudeUnavailableError(command, stderr.trim() || stdout.trim() || `exit ${code}`),
        });
      }
    });
  });
}
