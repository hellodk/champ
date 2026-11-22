# Configuration & Model Selection Reference

Champ separates **provider endpoint management** (`~/.champ/providers.json`) from **non-provider settings** (`~/.champ/config.yaml`).

## Index

1. [Locations & Precedence](#locations--precedence)
2. [YAML Schema](#yaml-schema)
3. [SSH Configuration](#ssh-configuration)
4. [Environment Variables & Secrets](#environment-variables--secrets)
5. [YAML Migration & Validation](#yaml-migration--validation)
6. [Model Selection & Hardware Guide](#model-selection--hardware-guide)

---

## Locations & Precedence

### Provider & model selection (highest wins)

1. **CLI flags**: `--provider`, `--base-url`, `--model`, `--api-key`
2. **Workspace endpoint reference (`<workspace>/.champ/provider.json`)**: non-secret `{ "endpoint": "<id>", "model": "<model-id>", "taskModels": { ... } }` created by `champ model use <id>/<model> --workspace`
3. **User endpoint registry (`~/.champ/providers.json`)**: managed by `champ setup`, `champ provider ...`, and `Champ: Configure Provider`
4. **Built-in defaults** (or legacy `~/.champ/config.yaml` / `CHAMP_CONFIG` when `providers.json` is absent)

### Non-provider settings

`userRules`, `agent`, `autocomplete`, `indexing`, `mcp`, `triggers`, `routing`, `telemetry`, `fallback`, `rateLimit`, and `ssh` are read from the single user file `~/.champ/config.yaml` (or `CHAMP_CONFIG`). Workspace `.champ/config.yaml` is not read; workspace overrides use `.champ/provider.json`, `.champ/rules/*.md`, `.champ/skills/*.md`, `.champ/agents/*.md`, and `.champ/teams/*.yaml`.

Saving `~/.champ/providers.json` or `~/.champ/config.yaml` triggers automatic hot reload in VS Code via `ConfigWatcher`.

---

## YAML Schema

```yaml
# Optional legacy/migration provider block (prefer `champ setup` / `providers.json`):
# Valid kinds: claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:8b
    contextWindow: 16384 # optional cap (#119)
    supportsTools: true # opt-in native tool_calls for OpenAI-spec servers
    structuredOutput: false
    cachePrompt: true
    options: # decode overrides (#120)
      temperature: 0.2
      topP: 0.9
      topK: 40
      minP: 0.05
      repeatPenalty: 1.1
      presencePenalty: 0.0
      frequencyPenalty: 0.0
      seed: 42
      stop: ["</s>"]

autocomplete:
  enabled: true
  debounceMs: 300
  provider: ollama
  model: qwen2.5-coder:1.5b

agent:
  yoloMode: false
  defaultMode: agent # agent | ask | manual | plan | composer
  autoFix:
    enabled: true
    maxIterations: 3
  promptGuard:
    enabled: true # screen inbound/outbound text for injection

indexing:
  enabled: true
  embeddingProvider: ollama # ollama | openai | vllm | openai-compatible
  embeddingModel: nomic-embed-text
  ignore:
    - "node_modules/**"
    - "dist/**"
    - ".git/**"

routing:
  mode: smart # smart | manual
  coding: qwen3:8b
  chat: llama3.1:8b
  completion: qwen2.5-coder:1.5b
  embedding: nomic-embed-text
  rules: []

fallback:
  providers: [ollama, claude]
  maxRetries: 1

rateLimit:
  requestsPerMinute: 60

telemetry:
  enabled: false
  endpoint: http://localhost:4318/v1/traces
  format: otlp # otlp | json
  flushIntervalMs: 5000

triggers:
  - name: "security scan on TS save"
    glob: "src/**/*.ts"
    on: save # save | change
    run: security-auditor
    debounceMs: 3000

userRules: |
  Always write deterministic tests.

mcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: ${env:GITHUB_TOKEN}
```

---

## SSH Configuration

```yaml
ssh:
  defaults:
    port: 22
    connectTimeoutSeconds: 15
  trustedHosts:
    - host: build-host.internal
      fingerprint: SHA256:...
  targets:
    - name: staging
      host: build-host.internal
      port: 22
      username: deploy
      authMethod: key # key | password | agent
      keyPath: ~/.ssh/id_ed25519
      # password: ${env:SSH_PASS}   # only when authMethod: password
```

---

## Environment Variables & Secrets

- Placeholders `${env:VAR_NAME}` in YAML resolve against `process.env` (unset vars stay literal so misconfiguration is obvious).
- Cloud provider keys (`claude`, `openai`, `gemini`) are rejected if placed in YAML and must live in OS keyring / env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) or VS Code `SecretStorage` (`champ.<provider>.apiKey`).
- `providers.json` and `.champ/provider.json` never contain API keys.

---

## YAML Migration & Validation

Import existing YAML endpoints and routing assignments into `~/.champ/providers.json`:

```bash
champ config migrate --dry-run
champ config migrate
champ config scrub-secrets --dry-run   # preview removing migrated inline apiKey entries
champ config scrub-secrets             # remove only verified keyring-backed inline apiKey entries
champ model assign coding <id>/<model> # assign coding | chat | completion | embedding | default
champ config routing auto              # auto | manual
```

Migration preserves URLs, models, `supportsTools`, `contextWindow`, `options`, and routing tasks without modifying `~/.champ/config.yaml`, moves self-hosted inline keys to the keyring (or offers explicit `{ kind: "env", name }` references when headless), and never writes keys to JSON. Run `champ config scrub-secrets` explicitly to delete inline `apiKey` fields from `config.yaml` once migrated. Inspect config with `champ config show` (secrets redacted to `<keyring:...>` / `<env:...>`) or VS Code `Champ: Show Effective Config`.

---

## Model Selection & Hardware Guide

### Minimum requirements for agentic editing

1. **Instruct-tuned model (`-Instruct`)**: base completion models explain instead of editing.
2. **Sufficient parameter size**: $\ge$7B for reliable tool calling; 1–3B models fail structured edits and complex Mermaid diagrams.
3. **Tool-calling format**: Ollama (`qwen3`, `llama3.1+`) and cloud models use native `tool_use`; other servers fall back to `<tool_call>` XML parsing.

### Recommended Open Models

| Tier         | Model                                          | Disk (Q4_K_M) | VRAM / RAM | Best For                                        |
| ------------ | ---------------------------------------------- | ------------- | ---------- | ----------------------------------------------- |
| Autocomplete | `qwen2.5-coder:1.5b`                           | ~1 GB         | 2 GB       | Inline ghost text (`autocomplete.model` only)   |
| Embedding    | `nomic-embed-text` / `mxbai-embed-large`       | <1 GB         | 1–2 GB     | `@Codebase` vector search                       |
| General 8B   | `qwen3:8b`                                     | ~5 GB         | 8 GB       | Daily coding, native Ollama tools, good Mermaid |
| Code 7B–14B  | `Qwen2.5-Coder-7B` / `14B-Instruct`            | 4.5–8 GB      | 8–16 GB    | File editing, refactoring, tests                |
| Generalist   | `Llama-3.1-8B-Instruct`                        | ~5 GB         | 8 GB+      | Multi-step planning & Q&A                       |
| Vision       | `gemma4:4b` / `gemma4:27b`                     | 3–16 GB       | 4–24 GB+   | Screenshot analysis & structured docs           |
| MoE / Large  | `DeepSeek-Coder-V2-Lite` / `Qwen2.5-Coder-32B` | 10–18 GB      | 12–24 GB+  | Deep multi-file refactors                       |

### Capability by Task Size

| Task                               | Min Size              | Notes                                   |
| ---------------------------------- | --------------------- | --------------------------------------- |
| Simple Q&A / file summary          | 3B+                   | Fast responses                          |
| Single-function edits / tests      | 7B+                   | Fewer hallucinations                    |
| Architecture docs / Mermaid        | 8B (`qwen3:8b`) / 27B | 3B breaks Mermaid syntax                |
| Multi-file refactoring / debugging | 14B+ or Cloud API     | Needs larger context & chain-of-thought |

### Tool-calling smoke test

Send `create a hello world python file` — a properly tuned model emits a `create_file` tool card rather than prose. Follow with: `read package.json and tell me the version` (`read_file`), `find all files that import "vscode"` (`grep_search`), `read_file`+`edit_file` bug fix, and `run_terminal_cmd` (`run the tests`).
