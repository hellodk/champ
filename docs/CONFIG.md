# Champ Configuration Reference

Champ separates **provider endpoint management** (stored automatically in `~/.champ/providers.json`) from **non-provider settings** (`userRules`, `agent`, `routing`, `indexing`, `mcp`, stored in `~/.champ/config.yaml`).

## Locations and precedence

For **provider and model selection** (highest wins):

1. **CLI flags** — `--provider`, `--base-url`, `--model`, `--api-key`
2. **Workspace endpoint reference (`<workspace>/.champ/provider.json`)** — optional non-secret `{ "endpoint": "<id>", "model": "<model-id>" }` created by `champ model use --workspace`
3. **User endpoint registry (`~/.champ/providers.json`)** — managed by `champ setup`, `champ provider ...`, and VS Code `Champ: Configure Provider`
4. **Built-in defaults** (or legacy `~/.champ/config.yaml` / `CHAMP_CONFIG` when `~/.champ/providers.json` is not yet created)

For **non-provider settings** (`userRules`, `agent`, `mcp`, `indexing`, `routing`, `telemetry`), Champ reads the single user-level YAML file **`~/.champ/config.yaml`** (or `CHAMP_CONFIG` on the CLI). No workspace `.champ/config.yaml` is read; workspace-level overrides use `.champ/rules/*.md`, `.champ/skills/*.md`, and `.champ/provider.json`.

Existing YAML `provider:` / `providers:` sections remain supported as an **import/migration format** (`champ config migrate`), not the primary live provider store.

## Quick start

In the CLI:

```bash
champ setup
```

In VS Code: run **`Champ: Configure Provider`** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`). Both write to the same `~/.champ/providers.json` registry while keeping credentials in separate host stores (OS keyring/env for the CLI, VS Code `SecretStorage` for the extension).

To create `~/.champ/config.yaml` for non-provider settings (`userRules`, `mcp`, `agent`, `indexing`), run **`Champ: Generate Config File`** in VS Code.

## YAML schema (non-provider settings + migration source)

```yaml
# Legacy/migration provider keys (use `champ setup` or `champ config migrate` instead):
# Valid: claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible
provider: llamacpp

providers:
  claude:
    model: claude-sonnet-4-20250514

  openai:
    model: gpt-4o

  gemini:
    model: gemini-2.0-flash

  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1

  llamacpp:
    baseUrl: http://localhost:8080/v1
    model: <your-model-id>

  vllm:
    baseUrl: http://localhost:8000/v1
    model: <your-model-id>

  openai-compatible:
    baseUrl: http://localhost:8080/v1
    model: <your-model-id>

# Inline ghost-text autocomplete (Ctrl+Space style suggestions as you type).
autocomplete:
  enabled: true        # default: true
  debounceMs: 300      # default: 300
  # Optional: use a different (smaller, faster) provider for autocomplete.
  # If omitted, autocomplete uses the same provider as chat.
  provider: ollama
  model: qwen2.5-coder:1.5b

# Agent behavior knobs.
agent:
  # Skip approval prompts for destructive tools (rm, edit_file, etc).
  # Use with extreme caution.
  yoloMode: false      # default: false

  # Default mode when a chat session starts.
  # Valid: agent, ask, manual, plan, composer
  defaultMode: agent   # default: agent

  # Auto-fix loop after edits — re-prompts the model with LSP errors.
  autoFix:
    enabled: true        # default: true
    maxIterations: 3     # default: 3

# Codebase indexing for @Codebase semantic search.
indexing:
  enabled: true                    # default: true
  embeddingProvider: ollama        # default: ollama
  ignore:                          # gitignore-style patterns
    - node_modules/**
    - dist/**
    - .git/**

# Always-applied rules. Injected into every chat's system prompt.
userRules: |
  Always write tests first.
  Use TypeScript strict mode.
  Prefer composition over inheritance.

# MCP (Model Context Protocol) servers — extend the agent with
# external tools like GitHub, Slack, or your internal APIs.
mcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: ${env:GITHUB_TOKEN}
```

## Secrets handling

**API keys are never stored in YAML.** They live in VS Code's encrypted `SecretStorage`, accessed via the **`Champ: Set API Key`** command.

The schema validator actively rejects any config that tries to put a key under `providers.*.apiKey`:

```yaml
providers:
  openai:
    apiKey: sk-real-secret    # ERROR: rejected at parse time
```

This protects you from accidentally committing a key when you commit the config file.

To set a key:

1. `Ctrl+Shift+P` → `Champ: Set API Key`
2. Pick the provider
3. Paste the key
4. The extension stores it in `SecretStorage` and reloads the provider

To rotate or remove a key, repeat the command with the new value (or empty).

## Environment variable substitution

Any string in the config can reference an environment variable with `${env:VAR_NAME}`:

```yaml
providers:
  llamacpp:
    baseUrl: ${env:LLAMA_HOST}
    model: ${env:LLAMA_MODEL}

mcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: ${env:GITHUB_TOKEN}
```

If the variable is not set, the literal `${env:VAR_NAME}` text is left in place so you notice the misconfiguration rather than getting a silent empty string.

## Hot reload

When you modify `~/.champ/providers.json` (from the CLI or VS Code) or `~/.champ/config.yaml`, the extension automatically reloads the active provider. No window restart is required.

If you save invalid YAML, the extension shows the parse error and keeps the previous provider active.

## Workspace vs user files

**Workspace** (`.champ/` inside the repo, safe to commit):
- `.champ/provider.json` — non-secret endpoint/model reference (`{ "endpoint": "<id>", "model": "<model-id>" }`)
- `.champ/rules/*.md` — project-specific rules
- `.champ/skills/*.md` — team skills

**User** (`~/.champ/`, private — never commit):
- `~/.champ/providers.json` — named endpoints, discovered models, and task assignments (no API keys)
- `~/.champ/config.yaml` — personal `userRules`, `agent`, `mcp`, `indexing`, `routing`, and legacy YAML provider config

## Validation and inspection

Run **`champ config show`** on the CLI (secrets are redacted to `<keyring:...>` or `<env:...>`) or **`Champ: Show Effective Config`** in VS Code.

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid YAML: ...` | Syntactically broken YAML | Check indentation, quotes, list dashes |
| `Invalid provider "X"` | `provider:` doesn't match a known name | Use one of: claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible |
| `Active provider "X" is not configured under providers:` | You set `provider: ollama` but no `providers.ollama:` block | Add the block |
| `providers.X.apiKey is not allowed in YAML` | Tried to put a cloud secret in YAML | Use `Champ: Set API Key` or `champ setup` instead |
| `agent.defaultMode must be one of: ...` | Invalid mode name | Use one of: agent, ask, manual, plan, composer |
| `autocomplete.debounceMs must be a number` | Wrong type for a numeric field | Remove quotes from the number |
