# Deep Functionality Reference

The knobs behind Champ's smarter behaviours. All keys live in
`.champ/config.yaml` (workspace), `~/.champ/config.yaml` (user), or the
equivalent `champ.*` settings — precedence controlled by `champ.configSource`
([README](../README.md#configuration--one-source-of-truth)).

## Smart routing rules

Auto-routing picks models per task type. Add explicit rules that win before
automatic selection (first match applies):

```yaml
routing:
  mode: smart              # or "manual" to always use provider/model
  rules:
    - match: "coding"          # task type: coding | chat | completion | …
      provider: openai-compatible
      model: mlx-community--Meta-Llama-3.1-8B-Instruct-8bit
    - match: "*.test.ts"       # file-glob match for the active file
      provider: ollama
      model: qwen2.5-coder:1.5b
```

Unknown model on a provider → warning + route anyway; unknown provider →
falls back to auto-routing.

## Resilience chain

```yaml
fallback:
  providers: [ollama, llamacpp]   # tried in order when primary fails
  maxRetries: 1                   # retries per provider before next

rateLimit:
  requestsPerMinute: 30           # client-side token bucket
  warningAt: 0.8                  # fire onWarning at 80%

# Circuit breaker wraps every provider automatically: opens after repeated
# failures, half-open probe after a cooldown, and resets on success.
```

HTTP calls additionally get per-request timeouts, bounded exponential
backoff with `Retry-After`, and one immediate retry on empty 200 streams.
Model rescan aborts unresponsive servers at the 5 s discovery deadline.

## Telemetry export

```yaml
telemetry:
  enabled: true
  endpoint: "http://localhost:4318/v1/traces"
  format: "otlp"            # or "json"
  userId: "team-name"       # omitted from OTLP unless includeUserIdentity
  headers:
    Authorization: "Bearer ${env:OTLP_TOKEN}"
  bufferMaxEvents: 1000
  bufferMaxBytes: 5242880
  timeoutMs: 5000
```

Buffered events flush to your collector; unreachable endpoints retry with
capped backoff and keep events in buffer.

## Audit log

Every agent action lands in a hash-chained `.champ/audit.log`
(500-char detail truncation, 50 MB self-guard). Verify tampering any time:

```
Champ: Verify Audit Log
```

## Memory banks

Two persistent memory stores injected into system prompts:

| Store | File | Scope |
|-------|------|-------|
| Workspace | `.champ/memory.json` | This project |
| Global | `~/.champ/memory.json` | All projects |

Manage via **MemoryPanel** (`Champ: Open Memory Bank`, global variant) —
add manual notes, pin favourites (pinned items are always included),
delete. Caps: 50 items, 1000 chars/entry, oldest evicted.

## Triggers

Fire skills/commands automatically:

```yaml
triggers:
  - name: lint-on-save
    glob: "*.ts"
    run: /fix        # runs on save of matching files
```

Save triggers hook `onDidSaveTextDocument`; change triggers use a file
watcher; all watchers are disposed on config reload.

## Advanced sandbox (`sandbox.yaml`)

Beyond the default denylist command sandbox, drop `.champ/sandbox.yaml` in
the workspace for the advanced layer: workspace path allow-lists, restricted
environment variables stripped from child processes, per-command timeouts,
MCP server command validation (blocks dangerous commands/sudo, supports
explicit whitelisting), and approval memory (denied commands stay denied).

## Codebase index tuning

```yaml
indexing:
  enabled: true
  embeddingProvider: ollama     # ollama | openai (vllm/openai-compatible route too)
  ignore:
    - node_modules/**
    - dist/**
    - target/**
```

- Chunks: AST-aware for TS/JS, sliding windows elsewhere; symbol + line-range
  metadata kept per chunk
- Search: HNSW above 10k chunks, brute-force below; `minSimilarity` 0.65;
  tool accepts `topK` up to 20
- Persistence: `~/.champ/index/<workspace-hash>.idx` reused across sessions;
  watcher reindexes changed files ~immediately; embedding cache is
  content-hash keyed per model at `~/.champ/embed-cache/<model>.bin`

## Environment substitution

Any scalar value may reference env vars — unset vars stay literal:

```yaml
providers:
  openai-compatible:
    baseUrl: ${env:LLM_BASE_URL}/v1
mcp:
  servers:
    - name: gh
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"   # SecretStorage-backed
```

## Delegation

The `delegate_task` tool lets the main agent spawn scoped sub-runs:

> "Delegate a directory-scope task to refactor all parsers under src/parsers"

Parameters: `task`, `scope` (`file` | `directory` | `workspace`), optional
`model`, `context`. Progress streams back into the parent chat; failures are
contained to the sub-run.

## Inline completion

```yaml
autocomplete:
  enabled: true
  debounceMs: 300
  model: qwen2.5-coder:1.5b   # small fast model; falls back to chat model
```

Stale requests abort in-flight LLM calls; suffix context (FIM) is capped to
keep latency low.

## SSH targets

Remote tools (`remote_run_terminal_cmd`, remote edit) consume `ssh:`
targets with host/port/auth-method validation, key or password auth, trusted
host fingerprints, and a connection pool with MITM detection on fingerprint
change. Passwords support `${env:VAR}` substitution.
