import type { AiBackend, CommandNamespaceProfile } from "../backend/metadata.js";
import type { ProgressDeliveryMode, UnboundRoutePolicy, InitialRouteBinding } from "../bridge/bridge.js";
import type { ClaudeCliStatus } from "../claude/claude-cli.js";
import type { CodexCliStatus, CodexPermissionMode, CodexRunPolicy } from "../codex/codex-cli.js";
import type { ContextRefreshPolicy } from "../context-refresh/types.js";
import type { FirstRouteBindingChoice } from "./serve-wizard.js";

export interface ServeStartupOptions {
  backend?: AiBackend;
  commandProfile?: CommandNamespaceProfile;
  session?: string;
  permission?: CodexPermissionMode;
  codexAdapter?: RealCodexAdapterMode;
  claudeAdapter?: ClaudeAdapterMode;
  yesDangerouslyFull?: boolean;
  cwd?: string;
  progressMode?: ProgressDeliveryMode;
  maxConcurrentTurns?: number;
  noInteractive?: boolean;
  noTui?: boolean;
}

export type RealCodexAdapterMode = "app-server" | "exec";
export type ClaudeAdapterMode = "exec" | "sdk";

export interface PreparedServeStartup {
  backend?: AiBackend;
  commandProfile?: CommandNamespaceProfile;
  policy: CodexRunPolicy;
  adapterMode?: RealCodexAdapterMode;
  claudeAdapterMode?: ClaudeAdapterMode;
  cwd: string;
  codexStatus?: CodexCliStatus;
  claudeStatus?: ClaudeCliStatus;
  progressMode?: ProgressDeliveryMode;
  contextRefresh?: ContextRefreshPolicy;
  maxConcurrentTurns?: number;
}

export interface ServeChannelPlan {
  unboundRoutePolicy: UnboundRoutePolicy;
  initialRouteBinding?: InitialRouteBinding;
  initialSessionId?: string;
  initialSessionTitle?: string;
  firstRouteBindingChoice?: FirstRouteBindingChoice;
}
