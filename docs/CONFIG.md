# Champ Configuration Reference

Champ reads configuration from a hierarchical YAML file instead of (or alongside) VS Code's flat `settings.json`. This is cleaner, version-controlled, and shareable with the rest of your team.

## Locations and precedence

Highest wins:

1. **`<workspace>/.champ/config.yaml`** — project-specific, committed to git, shared with the team
2. **`~/.champ/config.yaml`** — your personal defaults across all projects
3. **VS Code `champ.*` settings** — legacy backward-compatibility (still works, but YAML is preferred)
4. **Built-in defaults**

The workspace config is deep-merged on top of the user config. Nested objects merge field-by-field; arrays are replaced wholesale.

## Quick start

Run **`Champ: Generate Config File`** from the command palette (`Ctrl+Shift+P`). It writes a starter `.champ/config.yaml` in your workspace root and opens it in the editor. Edit and save — the extension watches the file and hot-reloads on change.

Or write it by hand:

```yaml
# .champ/config.yaml
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1
```

That's the minimum required to get a working setup. Everything else has sensible defaults.

## Full schema

```yaml
# Active provider — must match a key under `providers:` below.
# Valid: claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible
provider: llamacpp

# Per-provider settings. Add only the providers you actually use —
# Champ only reads the entry matching the active `provider:` above.
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
    baseUrl: http://192.168.1.24:21434/v1
    model: Qwen2.5-Coder-7B-Instruct.gguf

  vllm:
    baseUrl: http://localhost:8000/v1
    model: meta-llama/Llama-3.1-8B

  openai-compatible:
    baseUrl: http://localhost:9000/v1
    model: custom-model

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

When you save `.champ/config.yaml`, the extension automatically reloads the active provider. The status bar updates and a "switched to ..." notification appears. No need to reload the window.

If you save invalid YAML, the extension shows the parse error and keeps the previous provider active.

## Example: switching from settings.json to YAML

Before — `settings.json`:

```json
{
  "champ.provider": "llamacpp",
  "champ.llamacpp.baseUrl": "http://192.168.1.24:21434/v1",
  "champ.llamacpp.model": "Qwen2.5-Coder-7B-Instruct.gguf",
  "champ.autocomplete.enabled": true,
  "champ.autocomplete.debounceMs": 300,
  "champ.userRules": "Always write tests first."
}
```

After — `.champ/config.yaml`:

```yaml
provider: llamacpp
providers:
  llamacpp:
    baseUrl: http://192.168.1.24:21434/v1
    model: Qwen2.5-Coder-7B-Instruct.gguf
autocomplete:
  enabled: true
  debounceMs: 300
userRules: |
  Always write tests first.
```

You can keep both — the YAML file wins, and the `settings.json` values are silently ignored. To migrate cleanly, remove the `champ.*` entries from `settings.json` after creating the YAML file.

## Validation errors

The loader produces clear, actionable error messages:

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid YAML: ...` | Syntactically broken YAML | Check indentation, quotes, list dashes |
| `Invalid provider "X"` | `provider:` doesn't match a known name | Use one of: claude, openai, gemini, ollama, llamacpp, vllm, openai-compatible |
| `Active provider "X" is not configured under providers:` | You set `provider: ollama` but no `providers.ollama:` block | Add the block |
| `providers.X.apiKey is not allowed in YAML` | Tried to put a secret in YAML | Use `Champ: Set API Key` instead |
| `agent.defaultMode must be one of: ...` | Invalid mode name | Use one of: agent, ask, manual, plan, composer |
| `autocomplete.debounceMs must be a number` | Wrong type for a numeric field | Remove quotes from the number |

## What goes in workspace vs user config

**Workspace** (`.champ/config.yaml`, committed):
- Active provider (so the team uses the same one)
- Project-specific user rules ("our codebase uses tabs not spaces")
- MCP servers required for the project
- Indexing ignore patterns specific to the repo

**User** (`~/.champ/config.yaml`, personal):
- Personal model preferences
- Personal user rules ("always explain in plain English")
- Local llama.cpp endpoint URL (might differ from teammates')
- Per-machine autocomplete model

The workspace file usually ends up in the repo. The user file is private and should never be committed.

## Disabling YAML config

If you'd rather stick with `settings.json`, just don't create a `.champ/config.yaml`. The loader falls through to the legacy path automatically. Backward compatibility is permanent.
