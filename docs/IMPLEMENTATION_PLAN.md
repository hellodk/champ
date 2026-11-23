# Champ standalone CLI — Phase 0 audit and implementation plan

This document is the approved Phase 0 deliverable. It records the repository
audit, the verified test baseline, the phase gates, and the implementation plan.
No capability work starts until this document is committed.

## 1. Scope and priorities

The goal is a production-quality standalone `champ` CLI that is competitive with
Claude Code, OpenCode, Pi, Aider and Cline while preserving the VS Code extension.
The non-negotiable priorities are:

1. Coding reliability.
2. Repository intelligence.
3. Execution reliability: permissions, sessions, recovery, Git safety, and
   predictable tool execution.

Delivery order:

| Phase | Focus |
|---|---|
| 0 | Audit, baseline, plan (this document) |
| 1 | CLI context, index, repo map, memory |
| 2 | Coding execution, Git workflow, verification |
| 3 | TUI, sessions, usability |
| 4 | Structured JSONL output |
| 5 | Subprocess RPC |
| 6 | CLI teams |
| 7 | Retrieval and internet research quality |
| 8 | Security and regression hardening |

A later phase must not start while the previous phase has unresolved critical
regressions. If the order changes, the reason must be documented here.

## 2. Verified baseline

### Environment

| Item | Value |
|---|---|
| Branch | `master` |
| Commit | `0254aae7fe4fba38e4006b7ab54677aa90f4ec9b` |
| Version | `champ 2.0.2` |
| Unified script | `scripts/champ` |
| Test reports | `test-reports/` (gitignored) |

### Static quality

```text
scripts/champ lint
  TypeScript: OK
  ESLint: 0 errors, 3 warnings

node esbuild.mjs
  succeeded — dist/cli.js 3.9mb
node dist/cli.js --version
  champ 2.0.2
```

Warnings:

- `src/tools/git/github-api.ts:49` — unused `error`
- `src/tools/git/github-api.ts:71` — unused `error`
- `src/ui/diff-overlay-controller.ts:153` — unused `oldIdx`

### Test results

| Suite | Command | Result |
|---|---|---|
| Unit | `scripts/champ test unit` | 248 files, 2200 passed, 5 skipped, 0 failed |
| Integration | `scripts/champ test integration` | 5 files, 23 passed, 14 failed |
| E2E | `scripts/champ test e2e` | 7 files, 111 passed, 2 failed |

`scripts/champ test report` summary:

```text
e2e                111  2   0
integration-latest  23  14  0
latest            2200  0   5
```

### Critical regressions

1. **Integration and E2E suites are red.** The failures are in
   `test/integration/cli-skills.integration.test.ts`,
   `test/integration/cli.integration.test.ts`, and `test/e2e/cli.test.ts`.
2. **CLI test harness is not hermetic.** Verified facts:
   - `test/helpers/cli-harness.ts:175-208` writes only a legacy
     `.champ/config.yaml`.
   - `test/helpers/cli-harness.ts:247-252` passes `CHAMP_CONFIG` and inherits the
     real `HOME`.
   - `src/cli.ts:214-258` selects from `~/.champ/providers.json` when present.
   - On the audit machine that registry points at `http://localhost:8080/v1`, so
     the mock server receives no requests.
3. **Provider errors exit 0.** Verified path:
   - `src/agent/agent-controller.ts:755-784` emits an error delta and returns
     normally.
   - `src/cli/turn-runtime.ts:104-113` records the error but does not set
     `TurnOutcome.error`.
   - `src/cli.ts:1454-1458` maps only `outcome.error` to a non-zero exit.

These are the first gate of Phase 1.

## 3. Architecture assessment

### Reuse these components

- `AgentController`, `ToolCallingLoop`, `ToolRegistry`
- `ProviderFactory`, `SmartRouter`, `EndpointRegistry`, `SettingsRepository`
- `ChainCredentialStore`, `SharedCredentialStore`
- `IndexingService`, `EmbeddingService`, `VectorStore`, `ChunkingService`
- `RepoMapBuilder`, `MemoryBank`, `GlobalMemoryBank`
- `SessionLog` (CLI JSONL), `SessionStore` (extension JSON)
- `TeamRunner`, `TeamLoader`, `DelegationManager`, `SharedMemory`
- `PolicyEngine`, `CommandSandbox`, `SecretScanner`, `PromptGuard`, `AuditLog`
- `TuiRuntime`, `executeTurn`

Do not duplicate the agent runtime, provider abstraction, tool registry, memory
system, or RAG framework.

### Verified gaps

| Priority | Gap |
|---|---|
| P0 | Red integration/E2E baseline |
| P0 | Provider errors exit 0 |
| P0 | CLI does not attach repo map or memory banks |
| P0 | Index freshness is a fixed 24h cache only |
| P0 | No `champ index` command |
| P0 | Simulated browser tool is registered as functional |
| P0 | MCP loads once at startup; no status/reload command |
| P0 | No explicit read-only/supervised/autonomous permission profiles |
| P1 | No JSONL event protocol |
| P1 | No subprocess RPC |
| P1 | No team CLI |
| P1 | Session formats remain split |
| P1 | CLI checkpoints are log markers only |
| P2 | TUI command set is limited |
| P3 | No hybrid retrieval or retrieval evaluation suite |
| Docs | `docs/USER_GUIDE.md` still says Node.js 20+ is required |
| Docs | No `OBSERVABILITY_ARCHITECTURE.md` |

## 4. Approved decisions

1. A single canonical home-directory override, `CHAMP_HOME`, is approved for
   hermetic CLI tests.
2. CLI `SessionLog` JSONL is canonical. Legacy extension JSON sessions get an
   import adapter; there is no second writer.
3. The simulated browser tool is removed from the CLI registry or fails
   explicitly as not implemented. It is never advertised as functional.
4. Index freshness is content-hash first. The parked `stash@{0}` work may be
   reused only where it matches that rule.
5. `package.json` is the single source of truth for the extension and CLI
   version. Both surfaces must report the same value.
6. Versioning and GitHub releases are automated on every push to `master`.
   Conventional commits only. No GitHub issues are required for this work.

## 5. Phase plan

### Phase 1 — Stabilise CLI context, indexing, repo map, memory

Gate: baseline green before new capability.

1. Hermetic CLI test environment
   - Add `CHAMP_HOME` to canonical path resolution.
   - Update `test/helpers/cli-harness.ts` to seed a temporary canonical
     `providers.json`.
   - Add a regression test proving the real `~/.champ/providers.json` cannot
     leak into a child CLI run.
2. Execution status and exit codes
   - Propagate stream errors into `TurnOutcome`.
   - Add additive status: `success | partial | failed | cancelled`.
   - Map status to CLI exit codes.
3. CLI repository context
   - Wire `RepoMapBuilder`, `MemoryBank`, `GlobalMemoryBank` into `src/cli.ts`.
4. Index freshness and management
   - Manifest with embedding model ID, file paths, per-file SHA256, size, chunk
     count, and ignore-pattern fingerprint.
   - Add `champ index`, `--status`, `--rebuild`, `--clear`, `--watch`.
   - Keep `codebase_search` keyword fallback.
5. Acceptance
   - Unit, integration, E2E green.
   - `champ index --status` reports model, files, chunks, stale reason.
   - Provider failure exits non-zero.
   - Repo map and both memory banks attached in tests.
   - No real `~/.champ` writes in tests.

### Phase 2 — Coding reliability and Git workflow

1. Wire `CheckpointManager` before mutating tools.
2. Add pre-execution Git status checks; never reset/clean/discard user changes.
3. Propagate execution status from `ToolCallingLoop` to `executeTurn`.
4. Enforce diff inspection → relevant tests → bounded retry → honest report.
5. Tests in real temporary Git repositories.

### Phase 3 — TUI, sessions, usability

1. Canonicalise on JSONL; add legacy JSON import adapter.
2. Add only defined commands: `/model`, `/mode`, `/status`, `/index`,
   `/export`, `/clear`, `/sessions`, `/session`, `/checkpoint`, `/compact`,
   `/help`, `/exit`.
3. Remove or explicitly disable simulated browser functionality.
4. Add `/mcp status` and `/mcp reload` only after lifecycle is safe.
5. Tests with `ink-testing-library` and `TuiRuntime`.

### Phase 4 — Structured JSONL output

1. `src/cli/jsonl-events.ts`, protocol version `1`.
2. `--json` makes stdout exclusively JSONL; diagnostics go to stderr.
3. Events: `session.started`, `message.delta`, `message.completed`,
   `tool.started`, `tool.completed`, `tool.failed`, `approval.required`,
   `agent.status`, `usage`, `error`, `session.completed`.
4. Tests validate events, failed status, cancellation, stdout purity.

### Phase 5 — Subprocess RPC

1. `src/cli/rpc.ts`, newline-delimited JSON over stdin/stdout.
2. Methods: `prompt`, `abort`, `get_state`, `get_session`, `set_model`,
   `set_mode`, `approve_tool`, `list_tools`.
3. Reuse existing runtime; no internal classes in wire protocol.
4. Tests cover abort, provider failure, approval denial, unknown methods.

### Phase 6 — CLI teams

1. `champ team list|run|history|resume`.
2. Reuse `TeamLoader`, `TeamRunner`, `SharedMemory`, `AgentOrchestrator`.
3. Define file ownership/conflict rules before parallel mutation.
4. Tests cover dependency order, bounded parallelism, timeout, failure,
   checkpoint, resume.

### Phase 7 — Retrieval and internet research

1. Hybrid retrieval: vector + ripgrep + symbol metadata, deduplicated by
   file/line overlap.
2. Retrieval evaluation suite in `test/eval/retrieval/`.
3. Web workflow: Brave credential via canonical store, `fetch_url` with
   `url-guard`, `PromptGuard`, source metadata, citations.
4. No simulated browser functionality.

### Phase 8 — Security and regression hardening

1. Explicit permission profiles: `read-only`, `supervised`, `autonomous`.
2. Enforce profiles independently of model instructions.
3. Adversarial tests: traversal, symlink escape, command execution, untrusted
   content, MCP permissions, secret leakage, approval denial.
4. Full matrix: unit + integration + E2E + the 18 mandatory CLI scenarios.

## 6. Version and release automation

Approved rule: every push to `master` produces a version bump and a GitHub
release whose tag matches the published version.

Implementation:

- `package.json` is the only version declaration used by both the CLI and the
  extension.
- A GitHub Actions workflow runs on `push` to `master`.
- The workflow computes the next patch version from the highest of:
  - the latest `v*` git tag, and
  - the current `package.json` version.
- It bumps `package.json`, commits as `github-actions[bot]`, tags `v<version>`,
  pushes the commit and tag, builds the VSIX, and publishes a GitHub release.
- The VSIX is the first release asset so `scripts/champ install latest`
  continues to work.
- The workflow ignores its own bot push to prevent recursion.
- `scripts/champ release` becomes a thin push wrapper; it must not create a
  second release.
- Documentation lives in `docs/RELEASING.md`.
- Tests verify the version source of truth and the release input contract.

## 7. Out of scope unless required

Custom vector DBs, knowledge graphs, autonomous swarms/background agents,
mandatory browser automation, graphical dashboards, hosted services, automatic
commits/resets by the agent, and multiple overlapping memory systems.
