#!/usr/bin/env node
import { runClaudePermissionMcpStdio } from "./claude/permission-mcp-transport.js";

runClaudePermissionMcpStdio().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
