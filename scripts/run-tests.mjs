#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const suites = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["unit", "integration"];
const allowedSuites = new Set(["unit", "integration"]);
const files = [];

for (const suite of suites) {
  if (!allowedSuites.has(suite)) {
    console.error(`Unknown test suite: ${suite}`);
    process.exit(1);
  }
  const suiteDir = join(process.cwd(), "dist", "tests", suite);
  const suiteFiles = readdirSync(suiteDir)
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => join(suiteDir, file));
  files.push(...suiteFiles);
}

if (files.length === 0) {
  console.error(`No test files found for suites: ${suites.join(", ")}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  shell: false,
});

if (result.signal) {
  console.error(`node --test terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
