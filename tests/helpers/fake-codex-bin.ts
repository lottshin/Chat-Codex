import fs from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

interface FakeCodexBinOptions {
  root: string;
  name: string;
  source: string;
  extension?: ".js" | ".mjs" | ".sh";
}

export async function writeFakeCodexBin(options: FakeCodexBinOptions): Promise<string> {
  const extension = options.extension ?? ".js";
  const scriptPath = path.join(options.root, `${options.name}${extension}`);
  await writeFile(scriptPath, options.source, "utf8");

  if (process.platform !== "win32") {
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  const shimPath = path.join(options.root, `${options.name}.cmd`);
  await writeFile(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  return shimPath;
}

export function writeFakeCodexBinSync(options: FakeCodexBinOptions): string {
  const extension = options.extension ?? ".js";
  const scriptPath = path.join(options.root, `${options.name}${extension}`);
  fs.writeFileSync(scriptPath, options.source, "utf8");

  if (process.platform !== "win32") {
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  const shimPath = path.join(options.root, `${options.name}.cmd`);
  fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  return shimPath;
}
