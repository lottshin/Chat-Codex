export type AiBackend = "codex" | "claude";
export type CommandNamespaceProfile = "codex" | "claude";

export interface CommandNamespaceMetadata {
  profile: CommandNamespaceProfile;
  bridgePrefix: string;
  rootBridgeCommands: boolean;
}

export interface BackendCapabilities {
  models: boolean;
  modelSwitching: boolean;
  compact: boolean;
  goals: boolean;
  collaborationMode: boolean;
  interactiveApprovals: boolean;
  runtimePermissionSwitch: boolean;
  cancel: boolean;
  sessionDiscovery: boolean;
  nativeMedia: boolean;
  fileOutputProtocol: boolean;
  sendfile: boolean;
}

export interface BackendMetadata {
  id: AiBackend;
  displayName: string;
  cliName: string;
  sessionLabel: string;
  capabilities: BackendCapabilities;
}

const CODEX_CAPABILITIES: BackendCapabilities = {
  models: true,
  modelSwitching: true,
  compact: true,
  goals: true,
  collaborationMode: true,
  interactiveApprovals: true,
  runtimePermissionSwitch: true,
  cancel: true,
  sessionDiscovery: true,
  nativeMedia: true,
  fileOutputProtocol: true,
  sendfile: true,
};

const CLAUDE_CAPABILITIES: BackendCapabilities = {
  models: true,
  modelSwitching: true,
  compact: true,
  goals: false,
  collaborationMode: true,
  interactiveApprovals: true,
  runtimePermissionSwitch: true,
  cancel: true,
  sessionDiscovery: false,
  nativeMedia: false,
  fileOutputProtocol: true,
  sendfile: true,
};

const METADATA: Record<AiBackend, BackendMetadata> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    cliName: "Codex CLI",
    sessionLabel: "Codex session",
    capabilities: CODEX_CAPABILITIES,
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    cliName: "Claude Code CLI",
    sessionLabel: "Claude Code session",
    capabilities: CLAUDE_CAPABILITIES,
  },
};

export function commandNamespaceMetadata(profile: CommandNamespaceProfile | undefined): CommandNamespaceMetadata {
  const resolved = profile ?? "codex";
  return {
    profile: resolved,
    bridgePrefix: "bridge-",
    rootBridgeCommands: resolved === "codex",
  };
}

export function defaultCommandProfileForBackend(backend: AiBackend | undefined): CommandNamespaceProfile {
  return backend === "claude" ? "claude" : "codex";
}

export function backendMetadata(backend: AiBackend | undefined): BackendMetadata {
  return METADATA[backend ?? "codex"];
}

export function backendDisplayName(backend: AiBackend | undefined): string {
  return backendMetadata(backend).displayName;
}

export function commandProfileDisplayName(profile: CommandNamespaceProfile | undefined): string {
  return profile === "claude" ? METADATA.claude.displayName : METADATA.codex.displayName;
}

export function backendCliName(backend: AiBackend | undefined): string {
  return backendMetadata(backend).cliName;
}

export type BackendCommandFeature =
  | "model"
  | "compact"
  | "goal"
  | "collaborationMode"
  | "interactiveApprovals"
  | "runtimePermissionSwitch"
  | "sendfile";

export function backendSupportsFeature(backend: AiBackend | undefined, feature: BackendCommandFeature): boolean {
  const capabilities = backendMetadata(backend).capabilities;
  switch (feature) {
    case "model": return capabilities.models || capabilities.modelSwitching;
    case "compact": return capabilities.compact;
    case "goal": return capabilities.goals;
    case "collaborationMode": return capabilities.collaborationMode;
    case "interactiveApprovals": return capabilities.interactiveApprovals;
    case "runtimePermissionSwitch": return capabilities.runtimePermissionSwitch;
    case "sendfile": return capabilities.sendfile;
  }
}

export function unsupportedCommandMessage(backend: AiBackend | undefined, command: string, featureLabel: string): string {
  return `${backendDisplayName(backend)} 暂不支持 /${command}（${featureLabel}）。`;
}

export function formatUnsupportedBackendFeature(backend: AiBackend | undefined, feature: string): string {
  return `${backendDisplayName(backend)} 暂不支持${feature}。`;
}
