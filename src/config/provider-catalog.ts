/**
 * Authoritative catalog of Champ's 7 supported LLM provider kinds.
 *
 * Keeps capabilities, generic loopback defaults, and discovery protocols
 * consistent with `VALID_PROVIDERS` and `ProviderFactory`.
 */
import type { ProviderKind } from "./provider-model";

export interface CatalogEntry {
  kind: ProviderKind;
  label: string;
  /** Generic loopback/public URL only — never a LAN address. */
  defaultBaseUrl?: string;
  cloud: boolean;
  auth: "none" | "optional" | "required";
  discovery: "ollama-tags" | "openai-models" | "none";
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsEmbeddings: boolean;
}

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  {
    kind: "claude",
    label: "Anthropic Claude",
    cloud: true,
    auth: "required",
    discovery: "none",
    supportsTools: true,
    supportsStreaming: true,
    supportsEmbeddings: false,
  },
  {
    kind: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    cloud: true,
    auth: "required",
    discovery: "openai-models",
    supportsTools: true,
    supportsStreaming: true,
    supportsEmbeddings: true,
  },
  {
    kind: "gemini",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    cloud: true,
    auth: "required",
    discovery: "none",
    supportsTools: true,
    supportsStreaming: true,
    supportsEmbeddings: false,
  },
  {
    kind: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434",
    cloud: false,
    auth: "optional",
    discovery: "ollama-tags",
    supportsTools: true,
    supportsStreaming: true,
    supportsEmbeddings: true,
  },
  {
    kind: "llamacpp",
    label: "llama.cpp server",
    defaultBaseUrl: "http://localhost:8080/v1",
    cloud: false,
    auth: "optional",
    discovery: "openai-models",
    supportsTools: false,
    supportsStreaming: true,
    supportsEmbeddings: false,
  },
  {
    kind: "vllm",
    label: "vLLM",
    defaultBaseUrl: "http://localhost:8000/v1",
    cloud: false,
    auth: "optional",
    discovery: "openai-models",
    supportsTools: false,
    supportsStreaming: true,
    supportsEmbeddings: true,
  },
  {
    kind: "openai-compatible",
    label: "OpenAI-compatible (MLX / LM Studio)",
    defaultBaseUrl: "http://localhost:8080/v1",
    cloud: false,
    auth: "optional",
    discovery: "openai-models",
    supportsTools: false,
    supportsStreaming: true,
    supportsEmbeddings: true,
  },
] as const;

const CATALOG_BY_KIND = new Map<ProviderKind, CatalogEntry>(
  PROVIDER_CATALOG.map((entry) => [entry.kind, entry]),
);

const LEGACY_SECRET_IDS: Record<ProviderKind, string> = {
  claude: "champ.claude.apiKey",
  openai: "champ.openai.apiKey",
  gemini: "champ.gemini.apiKey",
  ollama: "champ.ollama.apiKey",
  llamacpp: "champ.llamacpp.apiKey",
  vllm: "champ.vllm.apiKey",
  "openai-compatible": "champ.openaiCompatible.apiKey",
};

export function catalogEntry(kind: ProviderKind): CatalogEntry {
  const entry = CATALOG_BY_KIND.get(kind);
  if (!entry) {
    throw new Error(`Unknown provider kind "${String(kind)}"`);
  }
  return entry;
}

export function legacySecretIdForProvider(kind: ProviderKind): string {
  return LEGACY_SECRET_IDS[kind];
}
