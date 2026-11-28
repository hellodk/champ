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

export type CapabilityState = "yes" | "no" | "unknown";

export type CapabilityEvidenceSource = "server" | "probe" | "user" | "catalog";

export interface CapabilityEvidence {
  source: CapabilityEvidenceSource;
  observedAt?: string;
  detail?: string;
}

export interface ModelCapabilitySet {
  chat: CapabilityState;
  tools: CapabilityState;
  embeddings: CapabilityState;
  images: CapabilityState;
  structuredOutput: CapabilityState;
}

export interface ModelUserOverrides {
  pinned?: boolean;
  capabilityOverrides?: Partial<ModelCapabilitySet>;
  contextWindow?: number;
}

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  /** Legacy free-form capability labels, preserved for existing frontends. */
  capabilities?: string[];
  contextWindow?: number;
  lastSeenAt?: string;
  /** Evidence-based capability state. Unknown is never upgraded by a guess. */
  capabilitySet?: Partial<ModelCapabilitySet>;
  capabilityEvidence?: Partial<
    Record<keyof ModelCapabilitySet, CapabilityEvidence>
  >;
  contextWindowEvidence?: CapabilityEvidence;
  maxOutputTokens?: number;
  qualityHint?: number;
  speedHint?: "fast" | "medium" | "slow";
  latencyMs?: number;
  ttftMs?: number;
  /** Only present when a known price exists; otherwise cost stays unknown. */
  costPerMillionInputUsd?: number;
  costPerMillionOutputUsd?: number;
  overrides?: ModelUserOverrides;
}

export interface ModelTarget {
  endpointId: string;
  modelId: string;
}

export type RoutingPreference = "quality" | "balanced" | "fast";

export type RouteScope =
  | { kind: "endpoint"; endpointId: string }
  | { kind: "pool"; poolId: string }
  | { kind: "global"; allowCloud: boolean };

export interface ModelSelectionConfig {
  scope: RouteScope;
  preference: RoutingPreference;
  pinned: ModelTarget | null;
  /** Explicit opt-in for safe automatic failover. Absent means disabled. */
  failover?: { enabled: boolean; maxAttempts?: number };
}

export interface EndpointPool {
  id: string;
  name: string;
  /** Endpoint IDs only; never endpoint names or provider names. */
  endpointIds: string[];
  routing?: {
    preference?: RoutingPreference;
    allowCloud?: boolean;
  };
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
  /** Optional named endpoint sets; absent means no multi-endpoint routing. */
  pools?: EndpointPool[];
  /** Optional canonical selection state; absent preserves legacy behaviour. */
  selection?: ModelSelectionConfig;
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
