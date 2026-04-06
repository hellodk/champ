# AIDev — Honest Gap Analysis vs Cursor

This document is the honest assessment of where AIDev currently stands relative to its stated goal of "Cursor-parity AI coding agent." It exists because the project's unit-test coverage is excellent (313 tests, 100% passing) but the runtime extension only assembles a subset of the components those tests cover. Knowing the gap is the first step to closing it.

Last updated: 2026-04-06 (after v0.1.2)

## How this happened

Across the 10 implementation phases, every component was built test-first and shipped with full unit-test coverage. The Phase 10 task — wiring everything into `extension.ts` — was scoped conservatively and only assembled the absolute minimum required to chat: provider, agent loop, tools, chat view, inline completion. Every other component (`@-symbol resolution`, `RulesEngine`, `CheckpointManager`, `AutoFixService`, `SecretScanner`, `MCPClientManager`, `ContextResolver`, the multi-agent orchestrator) was built and tested but never connected to the runtime.

The unit tests pass because each module satisfies its contract in isolation. But TDD at the component level **does not catch integration gaps**, and I claimed feature parity prematurely.

## Inventory

| # | Feature | Module exists? | Tested? | Wired into extension? | Cursor equivalent? |
|---|---------|----------------|---------|----------------------|-------------------|
| 1 | Tool calling for cloud models (Claude / OpenAI / Gemini) | ✅ | ✅ | ✅ | ✅ |
| 2 | Tool calling for local models (prompt-based XML fallback) | ✅ | ✅ | ✅ (v0.1.2) | ✅ |
| 3 | Agent system prompt with autonomous-execution directives | ✅ | ✅ | ✅ (v0.1.2) | ✅ |
| 4 | `@-symbol` resolution in chat input (`@Files`, `@Folders`, `@Codebase`, `@Web`, `@Git`, `@Docs`, `@Code`, `@Symbols`) | ✅ `ContextResolver` | ✅ | ❌ — chat sends literal `@Files(...)` text to the LLM | ✅ |
| 5 | Codebase indexing actually running on the workspace | ✅ `ChunkingService` + `VectorStore` | ✅ | ❌ — `@Codebase` is a dead reference | ✅ |
| 6 | Mode enforcement (Ask blocks edits, Plan blocks all writes, Manual requires per-call approval) | ✅ 5 mode prompts in `SystemPromptBuilder` | ✅ | ❌ — mode dropdown is cosmetic, AgentController uses one prompt | ✅ |
| 7 | Composer multi-file diff review (Plan → Diff → Apply) | ✅ `ComposerController` | ✅ | ❌ — no UI button to invoke composer mode | ✅ |
| 8 | Inline diff preview before apply | ⚠️ partial — `edit_file` applies directly | — | — | ✅ Cursor shows green/red inline first |
| 9 | Checkpoints created automatically before destructive tools | ✅ `CheckpointManager` | ✅ | ❌ — manager exists but nothing calls `create()` | ✅ |
| 10 | Checkpoint restore UI (click any past message to roll back) | ✅ `restore()` method | ✅ | ❌ — no UI surface | ✅ |
| 11 | Auto-fix loop after edits (LSP errors → re-prompt the model) | ✅ `AutoFixService` | ✅ | ❌ — service exists, never invoked | ✅ |
| 12 | Multi-agent orchestrator for complex tasks | ✅ `AgentOrchestrator` + 6 agents | ✅ | ❌ — only used by `ComposerController`, which is also unwired | partial |
| 13 | Tool approval flow piped through webview | ✅ approval callback exists | ✅ | ❌ — `ChatViewProvider` auto-approves; no dialog ever appears | ✅ |
| 14 | Rules system (`.aidev/rules/*.md` auto-attach by glob) | ✅ `RulesEngine` | ✅ | ❌ — engine exists, no extension code loads or injects rules | ✅ |
| 15 | MCP server connections | ✅ `MCPClientManager` (stub) | ✅ | ❌ — no real protocol wiring; settings schema exists | ✅ |
| 16 | Secret redaction before LLM calls | ✅ `SecretScanner` | ✅ | ❌ — scanner exists, AgentController never calls it | ✅ |
| 17 | Web search tool | ❌ in roadmap, not built | ❌ | ❌ | ✅ |
| 18 | Image input (paste screenshots into chat) | ✅ `LLMMessage` supports image content blocks | ✅ | ❌ — webview doesn't accept paste | ✅ |
| 19 | Inline ghost-text autocomplete | ✅ `AidevInlineCompletionProvider` | ✅ | ✅ | ✅ |
| 20 | Streaming chat with cancel | ✅ | ✅ | ✅ | ✅ |
| 21 | Provider hot-swap on settings change | ✅ | partial | ✅ (v0.1.1) | ✅ |
| 22 | Status bar provider indicator | ✅ | — | ✅ (v0.1.1) | partial (Cursor shows model in chat) |

### Score (as of v0.1.2)

- **Wired and working in the runtime**: 7 / 22 — chat streaming, inline autocomplete, status bar, hot-swap, native cloud tool calling, prompt-based local tool calling, system prompt
- **Built and tested but not wired**: 14 / 22
- **Not built at all**: 1 / 22 (web search)

## Closure plan (priority order)

Each item below is **integration work** — connecting existing modules — except where noted as new code. Roughly 1-3 commits each.

### Round 1 — anti-hallucination + safety (HIGH value, LOW-MEDIUM effort)

These directly address the failure mode the user just hit (model talks instead of acting + invents file paths/APIs). See `HALLUCINATION_MITIGATION.md` for the full analysis.

1. **Harden the system prompt** with explicit anti-hallucination directives, few-shot tool-use examples, and a "verify before claim" rule.
2. **Repo map injection** — generate a tree-sitter outline of the workspace's top-level files + symbols and inject it into the first turn so the model has factual grounding instead of guessing. (Aider's most effective grounding technique.)
3. **Verbose tool errors** — when `edit_file old_content` doesn't match, return the actual surrounding lines so the model self-corrects. When `read_file` fails, list nearby files. When `grep` returns nothing, suggest case-insensitive variants.

### Round 2 — closing the integration gaps (HIGH value, MEDIUM effort)

4. **Mode enforcement** — `AgentController` accepts a mode, picks the right system prompt, restricts tool list per mode (Ask blocks writes, Plan blocks all writes, Manual requires per-call approval).
5. **`@-symbol` resolution** — `ChatViewProvider` calls `ContextResolver.parseReferences()` + `resolve()` on every user message before sending to `AgentController`; resolved context is appended to the user message.
6. **Real approval flow piped through webview** — replace the auto-approve in `extension.ts` with a real prompt that round-trips through the chat panel.
7. **Secret redaction** — `AgentController` calls `SecretScanner.scan()` on file contents and tool outputs before they hit the LLM.

### Round 3 — verification loops (MEDIUM-HIGH value, MEDIUM effort)

8. **Checkpoints auto-created before destructive tools** — `ToolRegistry.execute()` calls `CheckpointManager.create()` if the tool's `requiresApproval` is true; the chat exposes restore.
9. **Auto-fix loop** — `AutoFixService.runAutoFixLoop()` invoked after each tool call that modifies files.
10. **Inline diff preview before apply** — `edit_file` posts a `diffReview` message to the webview, waits for accept/reject, only then applies.

### Round 4 — advanced features (MEDIUM value, HIGH effort)

11. **Codebase indexing on activation** — index workspace in background, make `@Codebase` actually search. Needs an embedding service (the only real new code).
12. **Composer mode UI** — toolbar button or mode that triggers the existing `ComposerController` workflow.
13. **Rules engine loads `.aidev/rules/*.md`** on activation; system prompt builder injects them.
14. **Image input** — webview accepts paste, encodes as base64, sends as `image` content block.

### Round 5 — extensibility (LOW value for solo users, HIGH effort)

15. **MCP protocol wiring** — replace `MCPClientManager` stubs with `@modelcontextprotocol/sdk`.
16. **Web search tool** — pick a provider (Tavily / Brave / SearXNG / Serper), build the tool.

## Why this list is honest about value

Items in Round 1 directly attack the hallucination problem — they make local models *actually do work* instead of describing it. Items in Round 2 close the safety/UX gaps that would embarrass the project on first use. Round 3 catches the rest of the failure modes (model edits the wrong thing, model breaks the build, etc). Rounds 4-5 are aspirational features — nice to have, not blocking.

If you only do Rounds 1 and 2, you have a usable Cursor-like experience for code changes. Rounds 3-5 push it from "works" to "polished".
