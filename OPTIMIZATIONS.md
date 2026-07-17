# Performance Optimizations

## Overview

This document tracks 10 performance and architecture optimizations for the Champ VS Code extension. Each fix targets a specific bottleneck identified through codebase analysis.

**Branch:** `optimize/perf-improvements`
**Date:** 2026-07-17

---

## Fix 1 — Parallel Embedding Indexing

**File:** `src/indexing/indexing-service.ts`

**Problem:** `indexWorkspace()` processes files sequentially. Each file's chunks are embedded one at a time via `await embed()`. For a workspace with 500 files averaging 5 chunks each, this means 2500 serial embedding calls.

**Solution:** Replace the sequential `for` loop with a concurrency-limited parallel mapper. Use an inline `pLimit` pattern (no new dependency) to run 4–8 file index operations concurrently.

**Impact:** ~4–8x speedup on multi-core machines with batch-capable embedding providers.

---

## Fix 2 — Embedding Content-Hash Cache

**File:** `src/indexing/embedding-service.ts`

**Problem:** Every `indexFile()` re-embeds all chunks even if the chunk text hasn't changed since the last index. The 24-hour disk cache (`~/.champ/index/`) avoids full re-indexing but doesn't help with partial re-indexing on file save.

**Solution:** Add a content-hash → embedding cache (`Map<sha256(text), Float32Array>`) inside `EmbeddingService`. Before calling the embedding API, check if the hash is already cached. Persist the cache to `~/.champ/embed-cache/<model-id>.json`.

**Impact:** Eliminates redundant API calls for unchanged chunks during incremental re-indexing.

---

## Fix 3 — Tool Result Truncation

**File:** `src/agent/tool-calling-loop.ts`

**Problem:** Tool results are truncated to 500 characters (line 207). This loses most meaningful output, causing the LLM to re-request the same information in subsequent iterations.

**Solution:** Increase truncation limit to 3000 characters. For outputs exceeding the limit, preserve first 1500 + last 1500 characters with a `... [truncated N chars] ...` separator.

**Impact:** Reduces re-request loops, improves task completion rate per iteration.

---

## Fix 4 — Parallel Independent Tool Calls

**File:** `src/agent/tool-calling-loop.ts`

**Problem:** Tool calls are executed sequentially (lines 191–238). When the LLM emits multiple independent read-only tool calls (e.g., `read-file` + `grep-search`), they run serially.

**Solution:** Classify tools as read-only (`read-file`, `grep-search`, `file-search`, `list-directory`, `codebase-search`) vs write (`edit-file`, `create-file`, `delete-file`, `run-terminal`, `run-tests`, `git-tool`). Run all read-only calls concurrently with `Promise.allSettled()`. Write calls run sequentially in order.

**Impact:** Reduces multi-tool iteration latency when LLM requests parallel reads.

---

## Fix 5 — Lazy Imports in Extension Entry

**File:** `src/extension.ts`

**Problem:** 96 static imports at the top of a 4336-line file. Every import executes at activation, even for features not used in the current session.

**Solution:** Move non-critical modules to dynamic `import()`:
- `IndexingService` → lazy in background init
- `MultiAgentRunner` → lazy in workflow start handler
- `TeamRunner` → lazy in team run handler
- `TeamMarketplaceClient` → lazy in marketplace panel open
- `AgentManager` → lazy in agent panel open

Keep static imports for essentials: `ProviderRegistry`, `ProviderFactory`, `RulesEngine`, `ToolRegistry`, `ChatViewProvider`, `SmartRouter`, `ConfigLoader`.

**Impact:** Faster activation time, lower memory footprint for users who don't use all features.

---

## Fix 6 — ANN Vector Index

**File:** `src/indexing/vector-store.ts`

**Problem:** Brute-force L2 scan is O(n*d) per search. Fast for ≤50K chunks but degrades on large monorepos.

**Solution:** Add HNSW index via `hnswlib-node` (optional peer dependency, try/catch on import). If entries > 10K and hnswlib is available, use HNSW for O(log n) approximate nearest neighbor search. Fallback to brute-force for small stores or when hnswlib is not installed.

**Impact:** Sub-millisecond search on large workspaces (100K+ chunks).

---

## Fix 7 — Smart Router Dedup Elimination

**File:** `src/providers/smart-router.ts`

**Problem:** `discover()` runs 3 redundant dedup passes (lines 146–161, 180–192, 198–208) using array filtering. `staticModels` is an unbounded array with spread-on-append.

**Solution:** Replace `staticModels: DiscoveredModel[]` with `Map<string, DiscoveredModel>` keyed by `providerName:id`. Eliminates all filter/dedup passes — `map.set()` handles dedup inherently. Single merge pass: `new Map([...discovered, ...staticModels])`.

**Impact:** Cleaner code, O(1) dedup instead of O(n²), bounded memory.

---

## Fix 8 — Wire Response Cache into Tool Loop

**File:** `src/agent/tool-calling-loop.ts`

**Problem:** `ResponseCache` exists and is wired into `AgentController` but not into `ToolCallingLoop` used by team-agent flows. Identical queries hit the API every time.

**Solution:** Add optional `responseCache?: ResponseCache` to `ToolCallingLoop` constructor. Before `provider.chat()`, check cache. On `done` delta with no tool calls, store response.

**Impact:** Eliminates redundant API calls for repeated queries in team-agent workflows.

---

## Fix 9 — Tree-Sitter Chunking (Documented, Not Implemented)

**File:** `src/indexing/chunking-service.ts`

**Problem:** Regex-based chunking is fragile — misses complex arrow functions, overloaded signatures, nested destructuring. The sliding-window fallback creates low-quality chunks.

**Status:** Documented as future work. Adding `tree-sitter-typescript` is a native dependency addition that warrants its own ticket.

**Path:** Swap `extractTsJsChunks()` regex logic for `tree-sitter-typescript` parser. Keep `ChunkingService` interface unchanged.

---

## Fix 10 — Unbounded staticModels

**Covered by:** Fix #7 (Map replaces array, dedup is inherent).

---

## Verification

After all fixes:
```bash
pnpm run lint && pnpm run typecheck && pnpm run test:unit
```
