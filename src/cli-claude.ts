#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli(process.argv.slice(2), {
  invocation: {
    backend: "claude",
    commandProfile: "claude",
  },
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
