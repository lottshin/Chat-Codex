export function summarizeSdkMessage(message) {
  const record = isRecord(message) ? message : {};
  const content = isRecord(record.message) && Array.isArray(record.message.content) ? record.message.content : [];
  const text = content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  const tool = content.find((item) => isRecord(item) && item.type === "tool_use" && typeof item.name === "string")?.name;
  return {
    type: stringField(record, "type") ?? "unknown",
    subtype: stringField(record, "subtype"),
    sessionId: stringField(record, "session_id"),
    status: stringField(record, "status"),
    text,
    tool,
    result: stringField(record, "result"),
    tools: stringArray(record.tools),
    model: stringField(record, "model"),
    permissionMode: stringField(record, "permissionMode"),
    claudeCodeVersion: stringField(record, "claude_code_version"),
  };
}

export function summarizeSdkMessageForLog(message) {
  return formatSdkMessageSummary(summarizeSdkMessage(message));
}

export function formatSdkMessageSummary(summary) {
  const type = cleanField(summary.type || "unknown");
  const subtype = summary.subtype ? `:${cleanField(summary.subtype)}` : "";
  const session = summary.sessionId ? ` session=${cleanField(summary.sessionId)}` : "";
  const parts = [`[sdk ${type}${subtype}${session}]`];
  if (summary.status) parts.push(`status=${cleanField(summary.status)}`);
  if (summary.tool) parts.push(`tool=${cleanField(summary.tool)}`);
  if (summary.text) parts.push(`text=${singleLine(summary.text)}`);
  if (summary.result) parts.push(`result=${singleLine(summary.result)}`);
  if (summary.tools?.length) parts.push(`tools=${formatList(summary.tools)}`);
  if (summary.model) parts.push(`model=${cleanField(summary.model)}`);
  if (summary.permissionMode) parts.push(`permissionMode=${cleanField(summary.permissionMode)}`);
  if (summary.claudeCodeVersion) parts.push(`claudeCode=${cleanField(summary.claudeCodeVersion)}`);
  return parts.join(" ");
}

export function classifyApprovalSmokeFailure(input) {
  const sdkMessages = Array.isArray(input?.sdkMessages) ? input.sdkMessages : [];
  const summaries = sdkMessages.map(summarizeSdkMessage);
  const approvalRequestCount = Number(input?.approvalRequestCount ?? 0);
  const hasInit = summaries.some((message) => message.type === "system" && message.subtype === "init");
  const hasAssistant = summaries.some((message) => message.type === "assistant");
  const hasResult = summaries.some((message) => message.type === "result");
  const hasToolUse = summaries.some((message) => Boolean(message.tool));
  const assistantText = summaries
    .filter((message) => message.type === "assistant")
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const resultText = summaries
    .filter((message) => message.type === "result")
    .map((message) => message.text || message.result)
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const latestStatus = [...summaries].reverse().find((message) => message.status)?.status;

  if (input?.markerFileExists) {
    return {
      code: "marker_created_without_observed_completion",
      detail: "标记文件已经存在，但 smoke 没有观察到完整完成事件；优先检查等待条件和 Bridge 停止流程。",
      hints: ["查看 channel/transcript 输出，确认审批卡或结果消息是否被漏记。"],
    };
  }
  if (input?.approvalPromptSeen) {
    return {
      code: "approval_prompt_seen_but_marker_missing",
      detail: "Bridge 已发出审批提示，但标记文件没有按时出现；问题在审批确认之后的工具恢复或命令执行阶段。",
      hints: ["检查 /1 是否命中同一路由的 pending approval。", "检查 SDK 在 allow 后是否继续执行工具。"],
    };
  }
  if (approvalRequestCount > 0) {
    return {
      code: "bridge_approval_request_not_delivered",
      detail: "Claude Agent SDK 已调用 canUseTool，Bridge 已进入审批服务，但渠道里没有观察到审批提示。",
      hints: ["检查 ApprovalManager 是否创建 pending approval。", "检查 MockChannel action card/text fallback 投递。"],
    };
  }
  if (hasToolUse) {
    return {
      code: "sdk_tool_use_without_permission_callback",
      detail: "SDK 消息里出现 tool_use，但 canUseTool 没有被调用；问题在 Claude Agent SDK 权限回调或工具权限配置层。",
      hints: ["检查 permissionMode、allowedTools 和 tools 组合。", "打开 --debug-sdk 查看 Claude Code 子进程日志。"],
    };
  }
  if (assistantText.includes("tool unavailable")
    || assistantText.includes("tool is unavailable")
    || assistantText.includes("don't have a bash tool")
    || assistantText.includes("invoke tool ")
    || assistantText.includes("use the bash tool")
    || assistantText.includes("run tool bash")
    || resultText.includes("tool unavailable")
    || resultText.includes("tool is unavailable")
    || resultText.includes("don't have a bash tool")
    || resultText.includes("invoke tool ")
    || resultText.includes("use the bash tool")
    || resultText.includes("run tool bash")) {
    return {
      code: "provider_tool_protocol_unsupported",
      detail: "assistant 只返回了模仿工具调用或工具不可用的纯文本，没有产出 Anthropic tool_use；当前 provider / 代理不支持工具协议或没有正确透传 tools。",
      hints: ["检查 cc-switch/provider 是否把 tools 当成普通文本处理。", "对真实 smoke 使用支持 Anthropic tool_use 的 provider，或继续使用确定性本地 harness。"],
    };
  }
  if (hasAssistant) {
    return {
      code: "sdk_assistant_without_tool_use",
      detail: "Claude Agent SDK 返回了 assistant 消息，但没有产生 tool_use，因此 Bridge 没有审批请求可展示。",
      hints: ["调整 smoke prompt 或 SDK options，避免依赖模型自然语言一定调用工具。", "这不能证明 Bridge 审批链路失败。"],
    };
  }
  if (hasResult) {
    return {
      code: "sdk_result_without_tool_use",
      detail: "Claude Agent SDK 已结束本轮，但没有产生 assistant tool_use；审批链路没有被触发。",
      hints: ["查看 result subtype 和输出内容，确认模型是否直接完成或拒绝了工具调用。"],
    };
  }
  if (hasInit) {
    return {
      code: "sdk_no_assistant_message",
      detail: `Claude Agent SDK 只初始化了会话${latestStatus ? `，最后状态为 ${latestStatus}` : ""}，在超时前没有产生 assistant 或 tool_use 消息。`,
      hints: ["这通常说明失败发生在 Claude Agent SDK / Claude Code / 模型请求层，还没进入 Bridge 审批链路。", "可用 --debug-sdk 采集 Claude Code 子进程日志。"],
    };
  }
  return {
    code: "sdk_no_init_message",
    detail: "Claude Agent SDK 在超时前连 system:init 都没有产出；优先检查 Claude Code 命令、认证、网络或 SDK 启动。",
    hints: ["确认 `claude --version` 在同一 shell 可用。", "打开 --debug-sdk 查看 Claude Code 子进程日志。"],
  };
}

function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function singleLine(value) {
  const normalized = cleanField(value).replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function formatList(values) {
  const visible = values.slice(0, 12).map(cleanField);
  const suffix = values.length > visible.length ? `,+${values.length - visible.length}` : "";
  return `${visible.join(",")}${suffix}`;
}

function cleanField(value) {
  return String(value)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\[(?:\d{1,3};)*\d{1,3}m\]?/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
