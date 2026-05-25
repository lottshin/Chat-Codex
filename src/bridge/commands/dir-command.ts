import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import { checkNewSessionWorkdir, resolveNewSessionWorkdir } from "../../codex/workdir.js";
import type { BridgeDelivery } from "../delivery.js";

export interface DirCommandOptions {
  delivery: BridgeDelivery;
  getDefaultWorkdir(): string;
  setDefaultWorkdir(cwd: string): void;
  hasActiveSession(routeKey: string): boolean;
}

export async function handleDirCommand(
  options: DirCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
): Promise<void> {
  const parsed = parseDirArgs(args);
  if (parsed.type === "show") {
    await options.delivery.sendText(target, dirStatusText(options.getDefaultWorkdir(), options.hasActiveSession(message.routeKey)));
    return;
  }
  if (!parsed.path) {
    await options.delivery.sendText(target, "缺少工作目录路径。用法: `/dir <path>` 或 `/dir create <path>`。");
    return;
  }

  if (parsed.type === "create") {
    try {
      const resolved = resolveNewSessionWorkdir(parsed.path, options.getDefaultWorkdir());
      options.setDefaultWorkdir(resolved.cwd);
      await options.delivery.sendText(target, dirChangedText(resolved.cwd, options.hasActiveSession(message.routeKey), resolved.created));
    } catch (error) {
      await options.delivery.sendText(target, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const checked = checkNewSessionWorkdir(parsed.path, options.getDefaultWorkdir());
  if (!checked.ok) {
    await options.delivery.sendText(target, [
      checked.message,
      checked.reason === "missing" ? "如需创建目录，请发送 `/dir create <path>`。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  options.setDefaultWorkdir(checked.cwd);
  await options.delivery.sendText(target, dirChangedText(checked.cwd, options.hasActiveSession(message.routeKey), false));
}

function parseDirArgs(args: string[]): { type: "show" } | { type: "set" | "create"; path: string } {
  const [first = "", ...rest] = args;
  const command = first.toLowerCase();
  if (!first || command === "show" || command === "status") return { type: "show" };
  if (command === "set") return { type: "set", path: rest.join(" ").trim() };
  if (command === "create" || command === "mkdir") return { type: "create", path: rest.join(" ").trim() };
  return { type: "set", path: args.join(" ").trim() };
}

function dirStatusText(cwd: string, hasActiveSession: boolean): string {
  return [
    "**工作目录**",
    `- 当前新会话默认工作目录: \`${cwd}\``,
    hasActiveSession ? "- 当前已绑定会话不会切换目录；发送 `/new` 后生效。" : "- 下一次创建会话会使用这个目录。",
  ].join("\n");
}

function dirChangedText(cwd: string, hasActiveSession: boolean, created: boolean): string {
  return [
    created ? "已创建目录并设置新会话默认工作目录。" : "已设置新会话默认工作目录。",
    `- 目录: \`${cwd}\``,
    hasActiveSession ? "- 当前已绑定会话不会切换目录；发送 `/new` 后生效。" : "- 下一次创建会话会使用这个目录。",
  ].join("\n");
}
