/**
 * Pure domain types for the local-first endpoint registry (`~/.champ/providers.json`).
 *
 * Kept free of Node/VS Code runtime imports so both CLI and extension can share
 * the exact same data model without dragging host dependencies across bundles.
 */

export type ProviderKind =
  | "claude"
  | "openai"
  | "gemini"
  | "ollama"
  | "llamacpp"
  | "vllm"
  | "openai-compatible";

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "claude",
  "openai",
  "gemini",
  "ollama",
  "llamacpp",
  "vllm",
  "openai-compatible",
] as const;

export function isProviderKind(value: unknown): value is ProviderKind {
  return (
    typeof value === "string" &&
    (PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

export type CredentialRef =
  | { kind: "keyring"; id: string }
  | { kind: "env"; name: string }
  | null;

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  capabilities?: string[];
  contextWindow?: number;
  lastSeenAt?: string;
}

export interface Endpoint {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl?: string;
  credential: CredentialRef;
  enabled: boolean;
  isDefault: boolean;
  supportsTools?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  options?: Record<string, unknown>;
  models: DiscoveredModel[];
  lastDiscoveredAt?: string;
}

export type TaskAssignment =
  | "default"
  | "coding"
  | "chat"
  | "completion"
  | "embedding";

export const TASK_ASSIGNMENTS: readonly TaskAssignment[] = [
  "default",
  "coding",
  "chat",
  "completion",
  "embedding",
] as const;

export function isTaskAssignment(value: unknown): value is TaskAssignment {
  return (
    typeof value === "string" &&
    (TASK_ASSIGNMENTS as readonly string[]).includes(value)
  );
}

export interface TaskEndpointAssignment {
  endpointId: string;
  model: string;
}

export interface ProvidersDocument {
  version: 1;
  endpoints: Endpoint[];
  assignments: Partial<Record<TaskAssignment, TaskEndpointAssignment>>;
  routingMode: "auto" | "manual";
}

/** Optional workspace reference stored at `<workspace>/.champ/provider.json`. */
export interface WorkspaceProviderRef {
  endpoint?: string;
  model?: string;
  taskModels?: Partial<Record<TaskAssignment, string>>;
}

export const PROVIDERS_DOCUMENT_VERSION = 1 as const;

export function emptyProvidersDocument(): ProvidersDocument {
  return {
    version: PROVIDERS_DOCUMENT_VERSION,
    endpoints: [],
    assignments: {},
    routingMode: "auto",
  };
}
