/**
 * Built-in sample configurations for the onboarding flow.
 *
 * When Champ detects a "first-run" condition (no workspace YAML, no
 * user YAML, no champ.provider VS Code setting), the chat panel shows
 * an onboarding picker with these templates. The user picks one, Champ
 * writes it to `<workspace>/.champ/config.yaml`, and the file watcher
 * hot-reloads the provider.
 *
 * Each template is a self-contained, valid YAML config that passes
 * ConfigLoader.parseYaml() and resolves to a working active provider
 * (assuming the backend is running at the default URL).
 */

export interface SampleConfig {
  /** Machine-readable id, e.g. "ollama-basic". */
  id: string;
  /** User-facing label, e.g. "Local: Ollama (recommended)". */
  label: string;
  /** Short description shown below the label. */
  description: string;
  /** The YAML content written to .champ/config.yaml. */
  yaml: string;
}

export const SAMPLE_CONFIGS: ReadonlyArray<SampleConfig> = [
  {
    id: "ollama-basic",
    label: "Local: Ollama (recommended)",
    description:
      "Privacy-first, no API key needed. Uses Ollama at localhost with qwen2.5-coder.",
    yaml: `# Champ — Ollama configuration (created by onboarding)
# Edit freely. The file watcher reloads on save.

provider: ollama

providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:7b-instruct

agent:
  defaultMode: agent
  yoloMode: false
  autoFix:
    enabled: true
    maxIterations: 3

autocomplete:
  enabled: true
  debounceMs: 300
`,
  },
  {
    id: "llamacpp",
    label: "Local: llama.cpp",
    description:
      "Direct llama.cpp server connection. Good for custom GGUF models.",
    yaml: `# Champ — llama.cpp configuration (created by onboarding)

provider: llamacpp

providers:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    model: default

agent:
  defaultMode: agent
  yoloMode: false
  autoFix:
    enabled: true
    maxIterations: 3

autocomplete:
  enabled: true
  debounceMs: 300
`,
  },
  {
    id: "vllm-basic",
    label: "Local: vLLM",
    description:
      "High-throughput local inference with vLLM. Great for multi-GPU setups.",
    yaml: `# Champ — vLLM configuration (created by onboarding)

provider: vllm

providers:
  vllm:
    baseUrl: http://localhost:8000/v1
    model: meta-llama/Llama-3.1-8B

agent:
  defaultMode: agent
  yoloMode: false
  autoFix:
    enabled: true
    maxIterations: 3

autocomplete:
  enabled: true
  debounceMs: 300
`,
  },
  {
    id: "claude",
    label: "Cloud: Claude",
    description:
      "Anthropic Claude API. Requires an API key (set via Champ: Set API Key).",
    yaml: `# Champ — Claude configuration (created by onboarding)
# Set your API key with the "Champ: Set API Key" command.

provider: claude

providers:
  claude:
    model: claude-sonnet-4-20250514

agent:
  defaultMode: agent
  yoloMode: false
  autoFix:
    enabled: true
    maxIterations: 3

autocomplete:
  enabled: true
  debounceMs: 300
`,
  },
  {
    id: "cloud-hybrid",
    label: "Cloud + local autocomplete",
    description:
      "Claude for chat/agents, Ollama for fast local ghost-text completions.",
    yaml: `# Champ — hybrid configuration (created by onboarding)
# Claude handles chat; Ollama handles autocomplete locally.
# Set your Claude API key with the "Champ: Set API Key" command.

provider: claude

providers:
  claude:
    model: claude-sonnet-4-20250514
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:1.5b

autocomplete:
  enabled: true
  debounceMs: 300
  provider: ollama
  model: qwen2.5-coder:1.5b

agent:
  defaultMode: agent
  yoloMode: false
  autoFix:
    enabled: true
    maxIterations: 3
`,
  },
];
