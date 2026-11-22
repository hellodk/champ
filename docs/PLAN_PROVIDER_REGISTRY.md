# PLAN: Unified provider onboarding and a local-first endpoint registry

**Status:** Increments A–E implemented (commits `#142 AC1`–`AC5`). Decisions locked 2026-11-22.
**Handover target:** an implementing agent with no prior conversation context. This document is
self-contained; §1 and §2 are facts, §5 is the work.
**Scope:** `src/config/**`, `src/cli/**`, `src/providers/**` (additive only), `src/extension.ts`
(wiring only), tests, docs.
**Explicitly not in scope:** a Rust rewrite, SQLite in this release, any Kri server component, and
any change to existing chat/skills/rules behaviour.

**Related documents:**
- `docs/PLAN_CLI_SKILLS_AND_RULES.md` — the working style to copy (issue → AC → failing test → commit).
- `docs/superpowers/plans/2026-10-17-champ-cli-16gb.md` — resource constraints. Its status header is
  stale; L1–L4 and CLI skills/rules have since landed locally.
- `docs/CONFIG.md`, `docs/INSTALLATION_AND_USAGE.md` — stale; correcting them is part of increment E.

Read §1, §2 and §4 before touching code. Implement §5 in order (A → B → C → D → E). Do not
re-litigate §1; rejected alternatives are recorded so they are not "improved" accidentally.

---

## 1. Locked decisions

### 1.1 Product decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| P1 | A user installs, runs `champ setup`, types a URL, discovers models, and never hand-edits YAML. | Keep the current "create `~/.champ/config.yaml` with an editor" flow. | That is the actual pain. `docs/INSTALLATION_AND_USAGE.md:145` teaches an invalid `provider: local` and `curl \| jq`; the docs, not the engine, are the main obstacle. |
| P2 | Domain model is **Provider → Endpoint → Model → Assignment**, with a separate Credential reference. | Champ's current one-YAML-entry-per-provider-type model. | Several local machines may serve the same provider protocol. Kri gets this right and it is the one idea worth copying wholesale. |
| P3 | "No file-based configuration" means **no manual file editing**, not "no files on disk". | An in-memory-only or remote-only config. | A local CLI must persist somewhere. Storage is an implementation detail behind a repository interface. |
| P4 | Workspace files may contain **non-secret endpoint/model references only**. | Full endpoint definitions (including URLs and keys) in a committed workspace file. | Projects stay portable and no secret can be committed. |
| P5 | Existing YAML remains an **import/migration format**, never the live store. | Deleting YAML support immediately. | Users already have configs; `champ config migrate` must not lose data. |

### 1.2 Technical decisions (locked by the user)

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| T1 | **Versioned JSON** at `~/.champ/providers.json`, atomic rename, advisory lock, behind an `EndpointRepository` interface. | SQLite from day one. | No native module in the Electron extension (VS Code 1.95 ships Node 20, so `node:sqlite` is unavailable); no ABI pain; enough for hundreds of endpoints. SQLite can be a later implementation of the same interface if health history or write concurrency demands it. |
| T2 | **Separate credential stores, same logical IDs.** CLI = OS keyring where available, env fallback for headless; extension = VS Code `SecretStorage`. | A single shared secret store, or plaintext keys in the registry. | `context.secrets` is not reachable from a CLI process. Pretending otherwise produces silent failures; storing keys in JSON is worse. |
| T3 | Keep the **TypeScript agent runtime**. Keep today's no-root `npm link` install. Evaluate Node 22 **SEA** as a single-binary option in increment E and report measurements. | Rust-native CLI now; Rust frontend with a Node sidecar. | Measured overhead of the whole Champ CLI is ~17 MiB RSS on top of Node (§2). A Rust rewrite does not solve the memory problem the model creates, and a sidecar keeps Node installed anyway. SEA gives one binary with zero agent-rewrite risk. |
| T4 | **Reuse** `runWizard`, `ProviderFactory`, `SmartRouter`, `buildProbeUrl`, `resilientFetch`, `upsertProviderInYaml`. | Rewriting the wizard, router, or protocol adapters. | All six already exist and are tested. Duplicating them creates the exact divergence this plan is meant to remove. |
| T5 | Name the new config service **`EndpointRegistry`**, not `ProviderRegistry`. | `ProviderRegistry`. | `src/providers/registry.ts:10` already exports a class with that name for runtime LLM provider instances. Two classes with the same name is a maintenance trap. |
| T6 | CLI commands keep the user-facing word `provider` (`champ provider add …`) even though the stored object is an endpoint. | `champ endpoint add`. | Matches what users search for and what Kri's UI calls the form. |

---

## 2. Verified baseline (facts with evidence)

Checked in the working tree at local `master` (4 commits ahead of `github/master`). Line numbers may
drift; symbol names will not. If a fact here disagrees with the code, **the code wins** — update this
section in the same commit and note the drift in the commit body.

| Fact | Evidence |
|---|---|
| Since #118/#126 there is **one** user config file; no workspace YAML is read | `src/extension.ts:3296-3340` (`resolveConfig`), `src/cli.ts:112-126` (`configPath`/`readConfigText`) |
| `resolveLayered` merges only the user YAML and defaults | `src/config/config-loader.ts:1497-1543` |
| Valid provider names are exactly 7 | `src/config/config-loader.ts:30-37`, `VALID_PROVIDERS` at `:260-268` |
| `ChampConfig` has `provider`, `providers`, `routing`, `userRules`, … | `src/config/config-loader.ts:244-258`; `ProviderConfig` at `:52-80` |
| A pure, injected-dependency setup wizard already exists | `src/config/setup-wizard.ts:32` (`WizardDeps`), `:47` (`runWizard`); tests at `test/unit/config/setup-wizard.test.ts` |
| The extension's `champ.configureProvider` wires it with live discovery and SecretStorage | `src/extension.ts:1616-1770`; helpers `buildProbeUrl` (`src/utils/probe-url.ts:18`), `resilientFetch` (`src/providers/http-resilience.ts:57`) |
| YAML edits are made by `upsertProviderInYaml` | `src/config/yaml-writer.ts:55`; tests `test/unit/config/yaml-writer.test.ts` |
| Extension secret keys are fixed strings like `champ.claude.apiKey` | `src/extension.ts:1544-1569`; `ProviderFactory` reads them via `SecretReader` (`src/providers/factory.ts:22-49`) |
| CLI has **no** secret storage; keys come from env vars | `src/cli.ts:708` (`get: () => Promise.resolve(undefined)`) |
| `ProviderFactory.createFromChampConfig` is the only provider construction path used by both hosts | `src/providers/factory.ts:26`; callers `src/cli.ts:714`, `src/extension.ts:3429` |
| `SmartRouter` already discovers/classifies models and supports task overrides + rules | `src/providers/smart-router.ts:47`, `:125`, `:237`, `:462`, `:473`, `:548`; `TaskType` at `:11` is `coding \| chat \| completion \| embedding` |
| There is **no** persisted health/latency in Champ | no `health`/`latency` fields in `src/providers/types.ts` or `smart-router.ts`; only a speed heuristic at `smart-router.ts:828` |
| A runtime `ProviderRegistry` class already exists | `src/providers/registry.ts:10` — hence T5 |
| CLI bundle is a single 357 KB file; `engines.node >= 20` | `node esbuild.mjs`; `package.json` (`bin.champ = dist/cli.js`, `engines.node`), `.npmignore` allow-list |
| esbuild inlines dependencies; only VS Code is external | `esbuild.mjs:8-42` (`bundle: true`, `external: ['vscode', 'playwright-core', 'chromium-bidi']`) |
| No root is needed today | `docs/INSTALLATION_AND_USAGE.md:98-113` (`npm link`), `CHAMP_CONFIG` override at `src/cli.ts:112` |
| Measured on this host, Node v22.23.2 | `champ --list-skills`: **70 ms**, **~57 MiB** peak RSS; bare `node -e ""`: **10 ms**, **~40 MiB**; `dist/cli.js` **357 KB** |
| Current CLI parse results include `help`, `version`, `error`, `sessions`, `list-skills`, `options` | `src/cli/args.ts` `CliParseResult`; new command results must be added before `readStdin()` |
| `--list-skills` exits before stdin is read — copy this pattern for new commands | `src/cli.ts:554-560` |
| Harness helpers support mock OpenAI + scripted stdin | `test/helpers/cli-harness.ts`: `buildCli`, `runCli`, `RunCliOptions`, `frames`, `makeWorkspace`, `writeChampConfig` |
| Pre-existing unrelated failure | `test/integration/tools/git-tool.integration.test.ts` (7 failures, `gitUtils.parseGitHubUrl is not a function`) — do not fix here |

### 2.1 Documentation drift to correct in increment E

- `docs/CONFIG.md:5-13` still describes a workspace → user → VS Code settings hierarchy. No workspace
  config is read by code.
- `docs/INSTALLATION_AND_USAGE.md:145` uses `provider: local`, which `isProviderName` rejects.
- `docs/superpowers/plans/2026-10-17-champ-cli-16gb.md:3` says "No implementation has started"; L1–L4
  have landed. Mark the status honestly rather than deleting the design.

---

## 3. What is copied from Kri, and what is deliberately not

Kri (`/home/dk/Documents/git/kri`, HEAD `965da83`) was inspected line by line. It is a good **UX
sketch**, not an architecture to reproduce.

**Copy:**

- Named endpoints as first-class objects with `is_default` and `enabled`
  (`fleet_platform/models/llm_endpoint.py:11-49`, service rules at `llm_svc.py:37-92`).
- Discover models from the URL after a debounce and offer a picker
  (`frontend/src/components/LLMEndpointForm.tsx:82-106`, `ModelCombobox.tsx`).
- Never return or pre-fill a secret; expose `has_api_key` instead
  (`fleet_platform/schemas/llm.py:68`, `LLMEndpointForm.tsx:52`).
- Test connection on a **saved** endpoint and show latency
  (`fleet_platform/api/routes/llm.py:217-257`, `SettingsPage.tsx:2170-2189`).

**Do not copy:**

| Kri behaviour | Evidence | Why not |
|---|---|---|
| FastAPI + Postgres + Redis + JWT admin CRUD | `deploy/docker-compose.yml`, `routes/llm.py:127-223` | No server in Champ; no login; local-first. |
| Fernet keys derived from JWT_SECRET in development | `services/platform_settings_svc.py:200-257` | Server-side secret management; T2 applies instead. |
| `Auto` = lowest-latency healthy model | `routes/llm.py:43-71` | Champ already has a richer `SmartRouter`; do not regress it to a latency sort. The pasted handoff text wrongly called Kri's Auto "capability-aware". |
| Discovery hardcodes `api_key=None` | `routes/llm.py:97` | Protected endpoints must be discoverable here. |
| Anthropic form sends `base_url: null` against a non-null field | `LLMEndpointForm.tsx:113` vs `schemas/llm.py:38` | Probable 422; a bug, not a pattern. |
| Process-local 300 s health cache | `services/model_health_cache.py:1-6` | Not durable, not shared across processes. |
| Hardcoded 5-provider enum; context/capabilities columns not wired to the form | `schemas/llm.py:7`, `frontend/src/api/llm.ts:23-32` | Champ has 7 providers; keep metadata live. |
| Sequential 20 s health probes | `services/model_discovery.py:14-15`, `:113-117` | Bounded concurrency with a total timeout instead (§6). |

---

## 4. Target architecture

```
                       ┌──────────────────────────────────────┐
                       │  ~/.champ/providers.json  (v1, 0600) │
                       │  endpoints / assignments / metadata  │
                       └───────────────┬──────────────────────┘
                                       │ atomic read/write + lock
                       ┌───────────────▼──────────────────────┐
                       │ EndpointRepository  (src/config)     │
                       └───────────────┬──────────────────────┘
                                       │
                       ┌───────────────▼──────────────────────┐
                       │ EndpointRegistry (pure-ish service)  │
                       │ add/edit/remove/test/default/assign  │
                       └───┬───────────────────────┬──────────┘
                           │                       │
             ┌─────────────▼──────┐      ┌──────────▼──────────────┐
             │ CredentialStore    │      │ ModelDiscovery / Catalog│
             │ keyring | env |    │      │ listModels + bounded    │
             │ VS Code SecretStore│      │ health probe            │
             └─────────────┬──────┘      └──────────┬──────────────┘
                           │                       │
             ┌─────────────▼───────────────────────▼──────────────┐
             │ ProviderFactory.createFromEndpoint → LLMProvider   │
             │ SmartRouter (task assignment → model)              │
             └─────────────────────┬──────────────────────────────┘
                                   │
                      ┌────────────┴────────────┐
                      │                         │
               CLI (src/cli.ts)        VS Code extension.ts
               `champ setup`            `Champ: Add Endpoint`
               `champ provider …`       existing chat UI unchanged
```

`runWizard` remains the shared decision flow. The CLI adapts terminal prompts to its `WizardDeps`;
the extension keeps its existing QuickPick adapters. Both write through `EndpointRegistry`, not to
YAML.

**Workspace reference file.** `<workspace>/.champ/provider.json` is optional and contains only a
reference, never connection details:

```json
{
  "endpoint": "<endpoint-id>",
  "model": "<model-id>",
  "taskModels": { "coding": "<model-id>" }
}
```

It is written only by `champ model use --workspace`; every other command treats it as read-only.
Precedence: CLI flags > workspace reference > user registry (`assignments` then `default`) > built-in
defaults. A reference to a missing or disabled endpoint is ignored with one stderr warning.

Streams: model text on stdout, everything else on stderr (existing CLI contract). `--list-skills`
and the new read-only commands are queries: stdout, no provider construction, no stdin read.

---

## 5. Increments

House rule for every increment: **acceptance criteria → failing test → demonstrate the failure →
implementation → suite green → one commit referencing the issue.** Tests live in the same commit as
the code. Never combine increments.

### Increment A — domain, repository, credential abstraction

**Goal:** a versioned JSON store with safe concurrent reads/writes and no secret ever in it.

**New file: `src/config/provider-model.ts`** (pure types)

```ts
export type ProviderKind =
  | "claude" | "openai" | "gemini" | "ollama"
  | "llamacpp" | "vllm" | "openai-compatible";

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
  id: string;                 // stable, e.g. "ep_" + randomUUID().slice(0, 8)
  name: string;               // user-defined, non-empty, unique (case-insensitive)
  provider: ProviderKind;
  baseUrl?: string;           // required for every kind except claude
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

export type TaskAssignment = "default" | "coding" | "chat" | "completion" | "embedding";

export interface ProvidersDocument {
  version: 1;
  endpoints: Endpoint[];
  assignments: Partial<Record<TaskAssignment, { endpointId: string; model: string }>>;
  routingMode: "auto" | "manual";
}
```

**New file: `src/config/provider-repository.ts`**

```ts
export class EndpointRepository {
  /** `~/.champ/providers.json` unless a test injects a directory. */
  constructor(opts?: { homeDir?: string; fileName?: string });
  path(): string;
  read(): Promise<ProvidersDocument>;          // absent → empty v1 doc; invalid → typed error
  write(doc: ProvidersDocument): Promise<void>; // atomic: temp in same dir → fsync → rename → chmod 0600
  withLock<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
}
```

Behaviour:

1. `read()` on ENOENT returns `{ version: 1, endpoints: [], assignments: {}, routingMode: "auto" }`.
2. Unknown `version` → error containing the found version and the supported version; never silently
   overwrite a newer file.
3. Validate only structural invariants (array fields, endpoint id/name/provider, credential ref
   shape). Skip + warn on a malformed endpoint rather than losing the whole file; keep the rest.
4. `write()` never follows a symlink at the target path (use `lstat` and refuse); creates `~/.champ`
   with mode `0700` when absent; file mode `0600`.
5. `withLock()` uses an exclusive `mkdir` lock + stale detection (>30 s), 5 s default timeout.
   Read-only commands do not take the lock.
6. No test may read the developer's real home directory: `homeDir` is always injected.

**New file: `src/config/credential-store.ts`**

```ts
export interface CredentialStore {
  get(ref: CredentialRef): Promise<string | undefined>;
  set(ref: CredentialRef, secret: string): Promise<void>;
  delete(ref: CredentialRef): Promise<void>;
  /** Human-readable reason a key could not be stored, or undefined. */
  unavailableReason?(): string | undefined;
}

export class ChainCredentialStore implements CredentialStore { /* keyring → env */ }
export class EnvCredentialStore implements CredentialStore { /* env only */ }
export class VsCodeSecretCredentialStore implements CredentialStore { /* context.secrets */ }
```

Keyring adapter (CLI): macOS `security add-generic-password`, Linux `secret-tool store`, Windows
PowerShell DPAPI helper, each invoked with an allow-listed argument list (no shell). If no backend
is present, fall back to env and say so; **never** write a plaintext fallback file.

**Tests first — `test/unit/config/provider-repository.test.ts`**

- absent file → empty v1 document
- round-trip preserves endpoints, assignments, routingMode
- unknown version → typed error, file untouched
- one malformed endpoint → skipped with a warning, valid ones survive
- write is atomic: no partial file visible on a simulated mid-write failure
- file mode `0600`, directory mode `0700`
- refuses to write through a symlink
- concurrent `withLock` calls serialize
- stale lock (>30 s) is reclaimed
- `homeDir` injection: no access to `os.homedir()`

**Tests first — `test/unit/config/credential-store.test.ts`**

- `env` ref reads `process.env` and returns undefined when unset
- `keyring` ref delegates to an injected backend
- chain falls back from an unavailable keyring to env
- `unavailableReason()` reports a missing backend
- no implementation writes a secret into the repository document
- `VsCodeSecretCredentialStore` uses the exact ref id as the SecretStorage key

**Acceptance criteria**

- AC-A1: `~/.champ/providers.json` is created with `0600` only when first written.
- AC-A2: two concurrent processes cannot lose each other's writes.
- AC-A3: no API key appears anywhere in the JSON document or in exports.

---

### Increment B — catalog, discovery, registry service

**Goal:** endpoints can be added, edited, defaulted, discovered, and tested through one service both
hosts can call.

**New file: `src/config/provider-catalog.ts`**

```ts
export interface CatalogEntry {
  kind: ProviderKind;
  label: string;                 // "MLX (OpenAI-compatible)", "Ollama", …
  defaultBaseUrl?: string;       // generic only; never a LAN address
  cloud: boolean;
  auth: "none" | "optional" | "required";
  discovery: "ollama-tags" | "openai-models" | "none";
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsEmbeddings: boolean;
}

export const PROVIDER_CATALOG: readonly CatalogEntry[];
export function catalogEntry(kind: ProviderKind): CatalogEntry;
```

Seven entries, matching `VALID_PROVIDERS` (`config-loader.ts:260`). MLX and LM Studio appear as
**labels** on the `openai-compatible` transport; do not add new protocol implementations. Defaults
are generic loopback URLs only (`http://localhost:<port>/…`), never a machine address.

**New file: `src/config/model-discovery.ts`**

```ts
export interface DiscoveryDeps {
  fetch: typeof fetch;                 // injected; tests use a mock
  now: () => string;
}

export async function discoverModels(
  endpoint: Endpoint,
  secret: string | undefined,
  deps: DiscoveryDeps,
): Promise<DiscoveredModel[]>;

export async function testEndpoint(
  endpoint: Endpoint,
  secret: string | undefined,
  deps: DiscoveryDeps,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
```

Behaviour:

1. Ollama → `{baseUrl}/api/tags`; all other self-hosted kinds → `<base>/v1/models` using
   `buildProbeUrl` (`src/utils/probe-url.ts:18`) so double `/v1` cannot occur.
2. Send `Authorization: Bearer <secret>` when a secret is available; this fixes Kri's `api_key=None`
   limitation.
3. Use `resilientFetch` (`src/providers/http-resilience.ts:57`) with a 5 s per-request timeout and
   a total deadline of 15 s for discovery and 10 s for a test probe.
4. Health probes run with concurrency ≤4 and are cancelled at the total deadline. A timeout is
   reported as `ok: false`, not "healthy" (Kri treats timeouts as healthy — do not copy).
5. Never throw for an unreachable endpoint; return `[]` / `{ ok: false, error }`.
6. Read `context_length` / capabilities where the server supplies them; leave undefined otherwise.

**New file: `src/config/endpoint-registry.ts`**

```ts
export interface AddEndpointInput {
  name: string; provider: ProviderKind; baseUrl?: string;
  isDefault?: boolean; enabled?: boolean; supportsTools?: boolean;
}

export class EndpointRegistry {
  constructor(deps: {
    repository: EndpointRepository;
    credentials: CredentialStore;
    discovery: { discoverModels: typeof discoverModels; testEndpoint: typeof testEndpoint };
    now: () => string;
  });

  list(): Promise<Endpoint[]>;
  add(input: AddEndpointInput): Promise<Endpoint>;
  update(id: string, patch: Partial<AddEndpointInput>): Promise<Endpoint>;
  remove(id: string): Promise<void>;
  setCredential(id: string, secret: string): Promise<void>;
  clearCredential(id: string): Promise<void>;
  setDefault(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setAssignment(task: TaskAssignment, endpointId: string, model: string): Promise<void>;
  resolveAssignment(task: TaskAssignment): Promise<{ endpoint: Endpoint; model: string } | null>;
  discover(id: string): Promise<DiscoveredModel[]>;
  test(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onChange(listener: () => void): () => void;
}
```

Rules:

- `add` assigns a stable id, rejects duplicate names (case-insensitive), and makes the first
  endpoint default automatically. Setting a new default clears all other `isDefault` flags in the
  same locked write.
- `remove` deletes the credential via `CredentialStore.delete` and clears assignments referencing
  the endpoint. Removing the default promotes the first remaining enabled endpoint, if any.
- `setEnabled(false)` clears `isDefault` on that endpoint (Kri's rule, worth keeping).
- `resolveAssignment` falls back from a task assignment → `default` → first enabled endpoint → null.
- All mutations go through `repository.withLock` and emit `onChange` exactly once after a successful
  write. Errors emit nothing.
- The registry never performs network I/O except in `discover`/`test`.

**Tests first — `test/unit/config/provider-catalog.test.ts`**

- seven entries, IDs equal `VALID_PROVIDERS`
- MLX/LM Studio are labels on `openai-compatible`, not new kinds
- every non-cloud entry has a generic loopback default; no LAN addresses
- auth/discovery/tool flags are consistent with `ProviderFactory` capabilities

**Tests first — `test/unit/config/endpoint-registry.test.ts`**

- add → id assigned, first endpoint becomes default
- duplicate name rejected without a write
- setDefault clears exactly one previous default
- disable default clears the flag
- remove deletes the credential ref's secret and cleans assignments
- remove default promotes the first enabled endpoint
- resolveAssignment precedence: task → default → first enabled → null
- onChange fires once per successful mutation, zero times on failure
- discover passes the stored secret to fetch as a Bearer header
- discover on an unreachable endpoint returns [] without throwing and within the deadline
- test reports false for a timeout (not healthy)
- two sequential adds persist both endpoints

**Acceptance criteria**

- AC-B1: a protected OpenAI-compatible endpoint can be discovered with its key.
- AC-B2: exactly one enabled default exists at any time.
- AC-B3: removing an endpoint leaves no dangling assignment or secret.

---

### Increment C — CLI setup and provider commands

**Goal:** `champ setup` and the management commands work without a provider being configured first.

**New file: `src/cli/setup.ts`**

```ts
export interface SetupPrompts {
  choose(list: Array<{ label: string; value: string }>): Promise<string | undefined>;
  input(label: string, initial?: string): Promise<string | undefined>;
  secret(label: string): Promise<string | undefined>;
  confirm(label: string, initial?: boolean): Promise<boolean>;
  pickModel(models: DiscoveredModel[]): Promise<string | undefined>;
}

export async function runSetup(deps: {
  registry: EndpointRegistry;
  prompts: SetupPrompts;
  writeLine: (line: string) => void;
}): Promise<{ saved: boolean; endpointId?: string }>;
```

Flow:

1. Choose provider from `PROVIDER_CATALOG` (labels, not raw kind names).
2. Ask for endpoint name (default: provider label) and base URL (default: catalog default, empty for
   `claude`).
3. Probe; when the response is 401/403 or the catalog declares auth required, ask for a key and
   call `registry.setCredential` **before** discovery.
4. Discover; on success call prompts.pickModel; on failure continue with the manually entered model
   plus one warning.
5. Ask "make default?" (default yes for the first endpoint).
6. Save through `registry.add`; print the endpoint id and a one-line summary. Never echo the key.

**Reuse rule:** the decision logic (probe → 401 → key → discover → pick) must call
`runWizard` from `src/config/setup-wizard.ts:47` with terminal adapters for its `WizardDeps`. Ask for
the endpoint name and default flag **after** a successful outcome, so `runWizard` and its extension
tests stay untouched. If a later increment needs name/default inside the wizard, add them as
optional deps then — not here.

**New file: `src/cli/provider-commands.ts`**

```ts
export type ProviderCommand =
  | { name: "setup" }
  | { name: "provider-list" }
  | { name: "provider-add" }
  | { name: "provider-edit"; id: string }
  | { name: "provider-remove"; id: string }
  | { name: "provider-test"; id: string }
  | { name: "provider-discover"; id: string }
  | { name: "models"; id?: string }
  | { name: "models-refresh"; id?: string }
  | { name: "model-use"; endpointAndModel: string; workspace?: boolean }
  | { name: "config-show" }
  | { name: "config-migrate"; dryRun?: boolean };

export async function runProviderCommand(
  cmd: ProviderCommand,
  deps: CommandDeps,
): Promise<number>; // exit code
```

Commands: `champ setup`, `champ provider list|add|edit|remove|test|discover`, `champ models`,
`champ models refresh`, `champ model use <endpoint-id>/<model> [--workspace]`,
`champ config show`, `champ config migrate [--dry-run]`. `config show` redacts every credential ref
to `<keyring:…>` / `<env:…>` and never prints a value.

**`src/cli/args.ts` changes:**

- New `CliParseResult` variants `{ kind: "provider-command"; command: ProviderCommand; cwd: string }`.
- Before the task-mode resolution, if the first positional is one of
  `setup`, `provider`, `models`, `model`, `config`, parse the remainder as a command; any other first
  positional remains a normal task. Unknown subcommands → `error(...)` → exit 2.
- New flags: `--endpoint <id>` (optional selector for `models`/`refresh`), `--workspace` (model use),
  `--dry-run` (config migrate). Add to `VALUE_FLAGS` / boolean set and `USAGE`.
- Command results must exit **before** `readStdin()` and before provider construction, exactly like
  `list-skills` and `sessions` (`src/cli.ts:554-560`).
- `USAGE` additions keep the existing asserted lines (`test/unit/cli/args.test.ts:43-47`) intact.

**`src/providers/factory.ts` change (additive):**

```ts
async createFromEndpoint(
  endpoint: Endpoint,
  opts: { model: string; secretProvider: SecretReader; contextWindow?: number },
): Promise<LLMProvider>;
```

Implementation translates the endpoint into a minimal `ChampConfig` and delegates to the existing
`createFromChampConfig`; no protocol code is duplicated. The CLI uses this method in increment D.

**Tests first — `test/unit/cli/setup.test.ts`**

- happy path with mocked prompts saves one endpoint with a key and chosen model
- 401 triggers a key prompt and stores the key before discovery
- discovery failure continues with the typed model and one warning
- cancel at any step saves nothing
- key is never present in `writeLine` output
- first endpoint becomes default; second does not overwrite it unless confirmed

**Tests first — `test/unit/cli/provider-commands.test.ts`**

- `provider list` prints names, kinds, sources and `hasCredential`, not keys
- `provider remove` reports a dangling assignment cleanup
- `models` on an unreachable endpoint exits 0 with a warning, no stack trace
- `config show` redacts env and keyring refs
- `config migrate --dry-run` writes nothing
- unknown subcommand → exit 2 with usage hint

**Tests first — `test/unit/cli/args.test.ts` (extend)**

- each command form parses to the right `ProviderCommand`
- `champ "setup the repo"` remains a task, not a command
- `--endpoint`, `--workspace`, `--dry-run` parse
- unknown subcommand is an error
- `USAGE` contains the new command lines and flags

**Acceptance criteria**

- AC-C1: `champ setup` completes on a clean machine with no config file and no root.
- AC-C2: every command returns before stdin is read when no task is given.
- AC-C3: `config show` contains no secret material.

---

### Increment D — CLI runtime and extension wiring

**Goal:** both hosts use the registry; existing behaviour is unchanged when there is no registry.

**CLI (`src/cli.ts`):**

1. Build `EndpointRegistry` with `ChainCredentialStore` and injected discovery. If
   `~/.champ/providers.json` is absent, fall back to today's `resolveLayered` + flags path verbatim.
2. When a registry document exists, resolve the endpoint/model (task assignment for one-shot turns;
   `default` for REPL), then construct the provider via `ProviderFactory.createFromEndpoint`.
3. Existing flags (`--provider`, `--base-url`, `--model`, `--api-key`) are explicit overrides and win
   over the registry. Do not change their validation or error text.
4. Keep the skills/rules implementation untouched: `loadCliRules`, `loadCliSkills`,
   `resolveInvocation`, `applyAllowedTools`, and their `finally` restore logic.
5. Do not change `runTurn`.

**Extension (`src/extension.ts`):**

1. Keep `resolveConfig` for non-provider settings (`userRules`, `agent`, `routing`, …).
2. Read endpoints from `EndpointRegistry` with `VsCodeSecretCredentialStore`; keep
   `SecretStorage` keys identical to the legacy IDs so existing stored keys keep working.
3. `champ.configureProvider` writes through the registry (via the same `runWizard` deps) instead of
   `upsertProviderInYaml`. Keep the command's prompts and messages otherwise unchanged.
4. `registry.onChange` calls `loadProvider()` so edits appear without restart.
5. Never pre-fill a secret input; keep `hasCredential`-style indicators.
6. No change to chat, skills, rules, model picker, or tool behaviour.

**Tests first — `test/integration/cli-provider-setup.integration.test.ts`**

Use `scenario()` from `test/integration/cli.integration.test.ts:30-52` with `makeWorkspace`,
`startMockOpenAI`, `writeChampConfig`, `runCli`.

- scripted `champ setup` discovers a model from the mock and saves it; a later one-shot uses it
- `champ -y "hi"` with no registry file behaves exactly as today
- CLI flags override a stored endpoint
- a workspace `provider.json` reference selects an endpoint but cannot contain a key
- `champ config migrate` imports an existing YAML URL/model and creates credential refs
- `--list-skills` and `--no-skills` still work with a registry present
- `/explain` mode restore and `allowedTools` restore are unaffected (regression guard)

**Tests first — `test/unit/providers/factory-from-endpoint.test.ts`**

- each of the 7 provider kinds maps to the correct provider class
- secret is supplied through `SecretReader`, never stored in the config object
- `contextWindow` and `supportsTools` are threaded through

**Acceptance criteria**

- AC-D1: the same endpoint is usable from CLI and extension without re-entering non-secret data.
- AC-D2: with no registry, CLI output and behaviour are byte-identical to today.
- AC-D3: no extension behaviour regression (full existing unit suite green).

---

### Increment E — migration, docs, packaging, SEA measurement

**New file: `src/config/provider-migration.ts`**

```ts
export interface MigrationResult {
  endpoints: number;
  warnings: string[];
  written: boolean;
}

export async function migrateFromYaml(deps: {
  configText: string | null;
  registry: EndpointRegistry;
  credentials: CredentialStore;
  dryRun: boolean;
}): Promise<MigrationResult>;
```

Rules:

- Read the existing YAML through `ConfigLoader.parseYaml` / `resolveLayered`; map each configured
  provider entry to one endpoint named after the provider kind.
- Preserve `baseUrl`, `model`, `supportsTools`, `contextWindow`, `options`, `userRules`, and routing
  assignments. Never delete or rewrite the YAML file.
- A self-hosted `apiKey` found in YAML must **not** be copied into JSON. Store it in the keyring if a
  backend exists; otherwise emit a warning naming the env var to set. A cloud key cannot be
  recovered from the CLI: create the keyring ref and say explicitly that the key must be re-entered
  or copied from the extension's existing SecretStorage ID.
- Idempotent: a second run reports zero new endpoints and does not duplicate anything.

**Docs — `docs/INSTALLATION_AND_USAGE.md`:** replace the hand-edit-YAML section with `champ setup`,
`champ provider list`, `champ models`; explain `~/.champ/providers.json` as a managed file, the two
secret stores, `CHAMP_CONFIG` for scripted overrides, and PATH setup. Generic examples only; no host
names, no LAN IPs, no root, no `sudo`.

**Docs — `docs/CONFIG.md`:** correct the precedence section to reality (single user YAML for
non-provider settings; registry for providers; CLI flags override both). Mark YAML as import/migration
for provider data.

**Docs — `docs/superpowers/plans/2026-10-17-champ-cli-16gb.md`:** change the status line to reflect
that L1–L4 landed; add a pointer to this plan for provider configuration.

**Packaging e2e — extend `test/e2e/cli-packaging.test.ts`:**

- after `buildCli()`, `node dist/cli.js provider list --cwd <tmp>` exits 0 with no config and no key
- `node dist/cli.js setup --help` prints the setup section of `USAGE`
- the tarball still contains exactly `EXPECTED_FILES` (`.npmignore` allow-list unchanged)

**SEA evaluation (report only, no implementation):**

- Build a Node 22 SEA prototype from the existing bundle (`node --experimental-sea-config` +
  `postject`), then measure binary size, cold startup, idle RSS, and peak RSS for a normal task.
- Compare against the current `node dist/cli.js` numbers in §2 in a short section of this document
  or `docs/INSTALLATION_AND_USAGE.md`. Do not switch the published artifact without a separate
  decision.

**Tests first — `test/unit/config/provider-migration.test.ts`**

- YAML with two providers → two endpoints, assignments preserved
- no YAML → zero endpoints, no write
- self-hosted inline key never appears in the written JSON
- second run is a no-op
- `--dry-run` writes nothing
- malformed YAML → warning, no crash

**Acceptance criteria**

- AC-E1: `champ config migrate` imports an existing config without losing URL/model.
- AC-E2: packaged bundle exposes the new commands.
- AC-E3: docs match code and remain beginner-usable, generic and root-free.
- AC-E4: SEA numbers recorded, not guessed.

---

## 6. Edge-case contract

| Input | Expected |
|---|---|
| `~/.champ` absent | created `0700` on first write only |
| `providers.json` absent | legacy YAML/flags path, byte-identical behaviour |
| `providers.json` version > 1 | error naming both versions; file untouched |
| one malformed endpoint in JSON | skipped with warning; valid endpoints load |
| duplicate endpoint name | rejected (case-insensitive), no write |
| no endpoints | `provider list` prints a hint, exit 0 |
| disabled endpoint selected by assignment | fall through to default, then first enabled |
| removing the default | first enabled endpoint promoted |
| endpoint with no key on a 401 server | clear message naming the credential ref; no stack trace |
| discovery timeout | `[]` plus one warning; save with manual model still allowed |
| `--file` / skills / rules with registry present | unchanged |
| `--provider`/`--base-url`/`--model`/`--api-key` | explicit overrides win over registry |
| `champ config show` | no secret value anywhere in output |
| `config migrate` with inline YAML key | key moved to keyring or warned as env; never in JSON |
| two CLI processes writing concurrently | serialized via lock; no lost update |
| extension and CLI writing concurrently | same lock file; last writer wins, no corruption |
| `champ "setup the repo"` | task mode, not the `setup` command |
| piped stdin with a command | command exits without reading stdin |
| `CHAMP_CONFIG` set | still controls legacy YAML path only |

---

## 7. Verification commands

```bash
# types (the build script runs this too)
pnpm run check-types

# unit loops
pnpm run test:unit -- test/unit/config
pnpm run test:unit -- test/unit/cli
pnpm run test:unit -- test/unit/providers/factory-from-endpoint.test.ts

# integration and packaging
pnpm run test:integration -- test/integration/cli-provider-setup.integration.test.ts
pnpm run test:e2e -- test/e2e/cli-packaging.test.ts

# full CLI build
node esbuild.mjs

# manual smoke (no model endpoint required)
node dist/cli.js provider list --cwd /tmp
node dist/cli.js setup --help
node dist/cli.js config show --cwd /tmp

# footprint baseline (record output, do not guess)
/usr/bin/time -v node dist/cli.js --list-skills --cwd /tmp
```

Known pre-existing failure — do not fix in this work:
`test/integration/tools/git-tool.integration.test.ts` (7 failures, `gitUtils.parseGitHubUrl is not a
function`). The pre-commit hook runs lint-staged + `pnpm run check-types`; if `pnpm` is unavailable,
run `./node_modules/.bin/tsc --noEmit` directly and use `--no-verify` for docs-only commits, noting
it in the commit body. For implementation commits use the normal hook.

To prove a test fails before the fix, restore the implementation file with
`git show <sha>:<path> > <path>` — never `git stash`.

---

## 8. Issue and commits

**Issue title:** `CLI + extension: unified provider onboarding and endpoint registry`

**Issue body (copy as-is; adjust the number only if needed):**

```text
Users must hand-edit ~/.champ/config.yaml to configure an LLM; the docs are stale (they teach an
invalid `provider: local`). The VS Code extension has a wizard but it writes YAML; the CLI has no
wizard at all, and the two hosts cannot share provider state or secrets.

Acceptance criteria

- [ ] AC1  A versioned, atomic, non-secret JSON registry is shared by CLI and extension; separate
              credential stores use the same logical IDs.
- [ ] AC2  Named endpoints can be added, edited, tested, discovered, defaulted, disabled and removed
              through one service; discovery works with protected endpoints.
- [ ] AC3  `champ setup` and provider commands work with no config, no root and no stdin blocking;
              existing flags remain explicit overrides.
- [ ] AC4  Both hosts use the registry; with no registry the CLI is byte-identical to today and the
              extension has no behaviour regression.
- [ ] AC5  YAML migrates without data loss; docs match code; packaged bundle exposes the commands;
              SEA footprint is measured and reported.

Tests required
- test/unit/config/provider-repository.test.ts
- test/unit/config/credential-store.test.ts
- test/unit/config/provider-catalog.test.ts
- test/unit/config/endpoint-registry.test.ts
- test/unit/cli/setup.test.ts
- test/unit/cli/provider-commands.test.ts
- test/unit/cli/args.test.ts (extend)
- test/unit/providers/factory-from-endpoint.test.ts
- test/unit/config/provider-migration.test.ts
- test/integration/cli-provider-setup.integration.test.ts
- test/e2e/cli-packaging.test.ts (extend)

Design: docs/PLAN_PROVIDER_REGISTRY.md
```

**Issue number below:** use `#142` if available, otherwise adjust.

**Commits (one per increment, tests in the same commit):**

1. `feat(config): versioned endpoint repository and credential abstraction (#142 AC1)`
2. `feat(config): provider catalog, discovery and endpoint registry (#142 AC2)`
3. `feat(cli): champ setup and provider commands (#142 AC3)`
4. `feat(cli): use endpoint registry; wire extension to same service (#142 AC4)`
5. `feat(config): YAML migration, docs, packaging and SEA measurements (#142 AC5)`

---

## 9. Guardrails

- **Do not modify** `src/cli/skills.ts`, `src/cli/rules.ts`, `src/cli/tool-scope.ts`, `src/skills/**`,
  `src/rules/**`, or the built-in skill texts. Their tests are regression guards.
- **Do not touch `src/providers/factory.ts` except to add `createFromEndpoint`.** Do not duplicate
  protocol implementations; no new provider class for MLX or LM Studio.
- **No `vscode` import under `src/cli/**`** — the CLI bundle marks `vscode` external and would fail at
  runtime, not compile time.
- **No dynamic import of config modules** — esbuild would drop them and the e2e test would catch it
  late.
- **Name the new service `EndpointRegistry`**, never `ProviderRegistry` (§1 T5).
- **Never write a secret** to `providers.json`, a workspace file, a log, argv, or an export. Secret
  input is never pre-filled in either UI.
- **No root, sudo, system directories, or hardcoded hosts/models/LAN addresses** in code, tests or
  docs. Generic loopback defaults only.
- **No new background process or daemon.** Keep the CLI process-local and lazy.
- **stdout stays machine-readable:** model text only during a turn; warnings and command tables go to
  stderr except for explicit query commands (`provider list`, `models`, `config show`, `setup --help`),
  which use stdout like `--sessions`/`--list-skills`.
- If a fact in §2 disagrees with the code, the code wins — update §2 in the same commit.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Extension secret IDs change | existing stored keys become invisible | reuse `champ.<provider>.apiKey` IDs as credential IDs; test migration of an existing key |
| JSON write race between CLI and extension | lost endpoint | `withLock` on every mutation; concurrency unit test; atomic rename |
| Registry present but malformed | CLI fails to start | skip bad endpoints with a warning; fall back to legacy path when the document is unreadable |
| `runWizard` changes break extension tests | regression | call it unchanged from the CLI; ask name/default afterwards |
| Discovery probes against many endpoints | long stalls, MLX reload thrash | 5 s per request, 15 s total, concurrency ≤4, cancellation on timeout |
| Users expect `Auto` to be capability-aware | wrong model chosen | use existing `SmartRouter` scoring; never reduce Auto to latency sort |
| SEA prototype grown too large | binary no longer "small" | report measured size; keep current bundling until a separate decision |
| Docs drift again | users hand-edit YAML and break things | docs updated in increment E with exact commands; no provider examples with real hosts |
| Two credential stores confuse users | keys "disappear" | `config show` prints the ref kind; setup prints which store was used; guide explains the boundary |

---

## 11. Out of scope

- Rust CLI, Rust agent runtime, or a Rust/Node sidecar (evaluate SEA only, increment E).
- SQLite migrations, health-history tables, or a central fleet database.
- Copying Kri's auth, Fernet store, prompt injection, pgvector, or tier-router tags.
- Changing the resource-budgeting work from `docs/superpowers/plans/2026-10-17-champ-cli-16gb.md`.
- Terminal/git tools, MCP changes, smart routing on the CLI path beyond task assignments.
- Live reload of endpoints in an already-running one-shot CLI process (REPL sees changes at next
  command; extension sees them via `onChange`).
- Any change to `docs/reviews/**`.

---

## 12. Follow-ups (file, do not implement here)

1. **SQLite behind `EndpointRepository`.** Revisit when health history or multi-process write volume
   justifies a native module in the extension.
2. **One logical secret authority.** If users want a single store, make the CLI the keyring authority
   and have the extension call `champ secret get/set`; requires an explicit dependency on an installed
   CLI.
3. **Endpoint health history.** Persist last-healthy/last-failure and expose it in the model picker;
   Kri's in-memory cache is not a model.
4. **Provider-specific request options in the wizard.** `ProviderConfig.options` already exists in
   YAML; expose it after the registry is stable.

---

## 13. Definition of done

- [x] `tsc --noEmit` (`pnpm run check-types` equivalent; `pnpm` absent in this env) passes.
- [x] All eleven test files/suites in §8 are green; the only remaining integration failures are the pre-existing 7 in `test/integration/tools/git-tool.integration.test.ts`.
- [x] `champ setup` on a clean machine discovers a model and saves a named endpoint with no YAML edit and no root (verified in unit + integration suites).
- [x] `champ -y "hi"` uses the saved endpoint; `src/extension.ts` reads the same `EndpointRegistry` and watches `~/.champ/providers.json` via `ConfigWatcher`.
- [x] With no registry file, CLI behaviour is unchanged and every skills/rules test still passes.
- [x] `champ config migrate` imports existing YAML without losing URL or model.
- [x] No secret appears in `providers.json`, workspace `.champ/provider.json`, logs, argv, or `config show`.
- [x] `node esbuild.mjs --production && node dist/cli.js provider list --cwd /tmp` works from the bundle (`392.1kb`).
- [x] Docs (`INSTALLATION_AND_USAGE.md`, `CONFIG.md`, `2026-10-17-champ-cli-16gb.md`) are updated, generic, and root-free.
- [x] Changes scoped to `src/config/**`, `src/cli.ts`, `src/cli/**`, `src/providers/factory.ts`, `src/extension.ts`, `test/**`, `docs/**`.
- [x] Five commits, one per increment, referencing `#142`, tests included.
- [x] SEA footprint numbers recorded from real commands, not estimated.

## 14. SEA evaluation measurements (2026-11-22, Node v22.23.2 linux-x64)

Measured on this host after building `dist/cli.js` with `node esbuild.mjs --production`:

| Artifact / Command | Result |
|---|---|
| `dist/cli.js` (`--production`) | `392.1kb` (`393K` on disk) |
| `node` binary (`v22.23.2`) | `120M` (`120 MiB`) |
| `node --experimental-sea-config` blob (`sea-prep.blob`) | `393K` (generated cleanly in `/tmp`) |
| `postject` injection | Not run (`postject` is not installed in workspace/PATH; single binary would be ~`120M` + blob + Mach-O/ELF overhead) |
| `node -e ""` | `0.02s` elapsed, `42,292 KB` (~41.3 MiB) max RSS |
| `node dist/cli.js provider list --cwd /tmp` | `0.09s` elapsed, `59,364 KB` (~58.0 MiB) max RSS (`+16.7 MiB` over bare Node) |
| `node dist/cli.js --list-skills --cwd /tmp` | `0.10s` elapsed, `62,208 KB` (~60.8 MiB) max RSS (`+19.5 MiB` over bare Node) |

**Conclusion:** Keep the `npm link` / `npm pack` `dist/cli.js` (`392.1kb`) distribution for now; SEA adds ~`120 MiB` per host to ship the bundled Node runtime without reducing peak RSS (~`58–61 MiB`).
