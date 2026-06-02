# 测试报告：Claude SDK smoke 诊断

## 测试目标

验证 Claude Agent SDK 工具审批 smoke 在未触发 `tool_use` 时能输出明确诊断，而不是只表现为等待审批卡超时。

## 测试环境

- 日期：2026-06-02
- 分支：`claude-sdk-smoke-investigation`
- Node.js 版本：`v20.18.0`（项目声明 Node.js 22+，本地 smoke 继续兼容执行）
- Claude Code：`2.1.154 (Claude Code)`
- 渠道：MockChannel
- 真实 provider 观察：真实 smoke 依赖当前 `cc switch` / Claude Code provider 是否支持 Anthropic `tool_use`。切到支持工具调用的模型后，本机真实链路已通过。

## 执行命令

```powershell
npm run build
node --test dist\tests\unit\claude-sdk-smoke-diagnostics.test.js dist\tests\unit\claude-sdk-smoke-script.test.js
node --check scripts\smoke-claude-sdk-approval.mjs
node --check scripts\smoke-claude-sdk-diagnostics.mjs
npm run smoke:claude-sdk -- --timeout-ms=5000
npm run smoke:claude-sdk:real -- --timeout-ms=90000 --keep-temp --debug-sdk
npm run smoke:claude-sdk:real -- --debug-sdk
npm test
```

## 实际结果

- 相关单元测试：已纳入全量测试。
- 语法检查：两个 smoke 脚本均通过。
- 默认 deterministic harness：通过，能稳定触发审批提示并完成 marker 文件创建。
- 真实 Claude SDK smoke：在不支持工具调用的模型/provider 下可诊断为 `sdk_no_assistant_message` 或 `provider_tool_protocol_unsupported`；切换到支持工具调用的模型后通过，审批提示出现，`/1` 批准后 marker 文件创建成功。
- 全量测试：710 pass。

## 结论

通过。当前改动把默认 smoke 收敛为可控本地 harness，并让真实 smoke 在失败时输出 provider / SDK / Bridge 分层诊断；在支持工具调用的真实模型下，Claude SDK 审批链路已通过验证。

## 遗留问题

- 真实 smoke 仍依赖 Claude Agent SDK / provider 稳定产出 `tool_use`；如果模型不支持工具调用，脚本会输出诊断码而不是把问题误报为 Bridge 审批投递故障。
