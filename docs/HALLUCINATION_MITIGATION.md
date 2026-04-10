# LLM Hallucination Mitigation in Champ

A deep analysis of *why* coding agents hallucinate, *how* the leading tools (Cursor, Aider, Continue.dev, Cline, Codeium) address it, and a concrete implementation plan for Champ. Last updated: 2026-04-06.

## What "hallucination" means in this context

Three distinct failure modes get lumped together:

1. **Factual hallucination** — the model invents APIs, function signatures, library names, file paths, or line numbers that do not exist. Example: "I'll call `fs.readFileSyncAsync` from Node" (not a real function), or "edit line 42 of `main.ts`" when `main.ts` has 30 lines.

2. **Behavioral hallucination** — the model claims to have done something it did not do. Example: "I've created `hello.py` for you" when no `create_file` tool was actually called and no file was written. (This is what the user observed in the test that motivated this document.)

3. **Confabulation under pressure** — when the model lacks the information needed to answer, it produces a plausible-sounding answer instead of saying "I don't know" or asking. Example: explaining how a function in your codebase works without ever reading it, then describing logic that doesn't exist.

All three share a root cause: **the model's confidence is decoupled from the model's correctness**. LLMs always produce a continuation; the continuation is sometimes factually grounded and sometimes not, and the model has no internal signal that distinguishes the two.

## Why coding agents hallucinate more than chat models

A general chat model can hedge ("I think the answer might be X, but you should verify"). A coding agent **cannot hedge** — it has to commit to specific function names, file paths, and line numbers. Every guess has a binary right/wrong outcome that compiles or fails.

Compounding factors:

- **The model wasn't trained on your codebase.** It knows TypeScript syntax but not your `AuthService.validateToken`. Without grounding, it invents.
- **Greedy generation.** The model picks the most likely next token without lookahead. Once it commits to a wrong function name, it commits the rest of the call signature consistently with the wrong name, producing very confident wrong code.
- **Context window constraints.** Even when the right answer exists in your repo, fitting it into the prompt is non-trivial.
- **Reward hacking from RLHF.** Helpful-sounding answers were rewarded during training; "I don't know" was not. The model learned to be confident even when it shouldn't be.
- **Prompt-based tool calling fragility.** Local models that don't have native `tool_use` will sometimes emit broken XML, or call a tool that doesn't exist, or pass arguments in the wrong shape.

## How the leading tools address this

This section is based on publicly documented patterns from Cursor, Aider, Continue.dev, Cline, and Codeium. Where I'm uncertain about a specific implementation detail I say so.

### Cursor

Cursor's hallucination defense is **aggressive grounding plus user-in-the-loop**:

1. **Workspace embedding index.** Cursor indexes the entire repo into a vector store on first open and incrementally updates on file change. When you ask about your code, Cursor retrieves the most relevant chunks and stuffs them into the prompt. This means the model sees the actual code instead of guessing.
2. **Per-edit diff review.** Even when the model produces wrong code, the user reviews it as a green/red inline diff *before* it lands. The user is the verification step. This is the single most effective hallucination defense — it doesn't reduce hallucinations, it makes them harmless.
3. **Auto-attached context.** Open files, current selection, current git diff, and recent edits are automatically injected without the user needing to ask. The model rarely guesses about "what file are we in" because it knows.
4. **Auto-fix loop.** After applying changes, Cursor reads LSP diagnostics and re-prompts the model with any new errors. The model's hallucinations get caught by the type checker.
5. **Citation rendering.** When the model references code, Cursor renders clickable file:line citations. This is partly UX, partly a forcing function — the model learns to be specific because vague answers look bad in the UI.

### Aider

Aider's approach is the most rigorous and the one I learned the most from:

1. **Repo map injection.** Aider builds a tree-sitter outline of your entire repo (top-level files + symbols + signatures) and injects it as a preamble to every conversation. The model sees `class AuthService { validateToken(token: string): User }` even before reading the file. This eliminates a huge class of "what's that function called" hallucinations. **This is the highest-leverage technique I know of.**
2. **Strict diff format.** The model must produce diffs in a specific format with the exact original lines included for context. If the model invents lines that don't exist in the file, the diff fails to apply and the model gets a clear error. The model retries with the actual file content visible.
3. **Lint-after-edit reflection.** After every change, Aider runs the project's linter/formatter and feeds errors back to the model as a follow-up turn. The model sees its own broken code and fixes it. This catches most syntactic and many semantic hallucinations.
4. **"Show me the file" forcing.** If the model wants to edit a file it hasn't read yet in this session, Aider auto-injects a `read_file` first. The model can't hallucinate about content it just saw.
5. **Retry on apply failure.** If a diff doesn't apply cleanly, Aider asks the model "your diff didn't apply, here's the actual current file content, try again" — a single-turn correction.

### Continue.dev

Continue's defense is more modest but still effective:

1. **Required `@-symbols` for context.** The user must explicitly inject context via `@Files`, `@Code`, `@Codebase`. This forces the model to work with real content rather than guess.
2. **Slash commands with templated prompts.** Commands like `/edit`, `/comment`, `/test` use carefully tested system prompts that include anti-hallucination directives.
3. **Custom rules.** Users can define project-level rules that get appended to every prompt — useful for "always prefer this library over that one" guidance.

### Cline

Cline's defense is almost entirely **user approval**:

1. **Plan/Act separation.** The model first produces a plan (no edits), then the user approves each step before any tool runs. Mistakes get caught at the planning stage.
2. **Tool result feedback loop.** Every tool call's result is fed back into the model's context, so the model can self-correct when its assumption was wrong.
3. **Visual approval cards.** Each tool call appears as a card with an Approve/Reject button. User-in-the-loop on every action.

### Codeium

Codeium's autocomplete-focused approach uses **fine-tuning over prompting**:

1. **Codebase fine-tuning.** For enterprise users they fine-tune the model on the customer's codebase. The model literally learns the customer's APIs and patterns.
2. **Heavy RAG.** Top-K retrieved chunks from the embedding index are injected on every completion request.
3. **Confidence cutoff.** Suggestions below a confidence threshold are silently dropped.

## What we can do at the extension level

Not everything above is feasible in a VS Code extension, but the high-impact patterns are. Ranked by impact-per-effort:

### Tier P0 — implement first (this milestone)

| # | Technique | Source | Impact | Effort |
|---|-----------|--------|--------|--------|
| 1 | **Stricter system prompt with explicit anti-hallucination rules** | Aider, Continue | HIGH | LOW |
| 2 | **Repo map injection on first turn** | Aider | HIGH | MEDIUM |
| 3 | **Verbose tool error responses** ("here's the actual file content") | Aider | HIGH | LOW |
| 4 | **Force `read_file` before `edit_file`** when file not read this session | Aider | HIGH | LOW |
| 5 | **Auto-fix loop after edits** (LSP errors → re-prompt) | Cursor, Aider | HIGH | MEDIUM |

### Tier P1 — implement next

| # | Technique | Source | Impact | Effort |
|---|-----------|--------|--------|--------|
| 6 | **Tool result feedback** (already done) | Cline | HIGH | done |
| 7 | **Approval cards for destructive ops** | Cline, Cursor | MEDIUM | MEDIUM |
| 8 | **Inline diff preview before apply** | Cursor | HIGH | MEDIUM |
| 9 | **Mode enforcement** (Ask blocks edits) | Cursor | MEDIUM | LOW |
| 10 | **Auto-attached context** (open files, current selection) | Cursor | MEDIUM | LOW |

### Tier P2 — bigger lift

| # | Technique | Source | Impact | Effort |
|---|-----------|--------|--------|--------|
| 11 | **Embedding-based RAG for `@Codebase`** | Cursor, Codeium | HIGH | HIGH (needs embedding service) |
| 12 | **Citation rendering** with file:line links | Cursor | MEDIUM | MEDIUM |
| 13 | **Plan/Act mode separation** | Cline | MEDIUM | MEDIUM |

### Tier P3 — out of scope for now

| # | Technique | Source | Why later |
|---|-----------|--------|-----------|
| 14 | **Customer-specific fine-tuning** | Codeium | Requires training infrastructure |
| 15 | **Confidence scoring** | Codeium | Models don't expose calibrated confidence; would need post-hoc heuristics |

## Detailed mitigation specs (P0)

### 1. Stricter system prompt

Update `SystemPromptBuilder` and `AgentController` base instructions to include:

- **Mandatory tool use directive**: "When the user asks you to modify, create, or inspect anything in the workspace, you MUST use a tool. Do not describe the action — perform it."
- **Verify-before-claim rule**: "Before referencing a function, file, or line number, you MUST first verify it exists with `read_file` or `grep_search`. If you have not verified, do not claim it exists."
- **No-fabrication rule**: "If you do not know the answer or do not have the information needed, say so explicitly. Do not invent function names, library APIs, file paths, or line numbers."
- **Few-shot examples** showing both correct (uses tools) and incorrect (describes without tools) responses.

This is the single cheapest fix and probably catches 30-40% of behavioral hallucinations.

### 2. Repo map injection

Build a `RepoMapBuilder` that:

1. Walks the workspace using `vscode.workspace.findFiles('**/*', '**/node_modules/**', 500)`.
2. For each file, runs the existing `ChunkingService.chunkFile()` (which already extracts function/class symbols) but only keeps the symbol names + signatures, not the bodies.
3. Produces a compact outline like:
   ```
   src/auth/auth-service.ts:
     class AuthService
       login(email: string, password: string): Promise<User>
       logout(): void
       validateToken(token: string): User | null
   src/api/users.ts:
     function getUser(id: string): Promise<User>
     function listUsers(filter?: UserFilter): Promise<User[]>
   ```
4. Caps the total size at ~8K tokens.
5. Caches the result; invalidates on file watcher events.

The first user message in every chat session gets this map prepended as a system message: "Here is an outline of the user's workspace. Use this to ground your answers; do not invent symbols that are not in this outline."

This kills the "model invents `validateUser()` when the real function is `validateToken()`" failure mode.

### 3. Verbose tool error responses

Currently, when `edit_file` `old_content` doesn't match, the tool returns:
```
Could not find the specified old_content in src/main.ts
```

Better:
```
Could not find the specified old_content in src/main.ts.

Here is the actual content of src/main.ts (lines 1-30):
  1: import express from 'express';
  2: const app = express();
  3: ...

Suggested fix: re-read the file first, then construct your edit using the actual content.
```

The model self-corrects on the next turn instead of looping with the same wrong content.

Same pattern for:
- `read_file` not found → list nearby files in the same directory
- `grep_search` no matches → suggest case-insensitive variants and similar search terms
- `file_search` no matches → list a few files in the workspace as suggestions

### 4. Force `read_file` before `edit_file`

`AgentController` tracks which files have been read in the current session. When `edit_file` is called on a file that hasn't been read yet, the registry intercepts and either:

- **Strict mode**: refuses, returns "you must `read_file` before editing"
- **Auto mode**: silently injects a `read_file` call first, then the edit

Strict mode is safer; auto mode is more user-friendly. Default to auto mode.

### 5. Auto-fix loop

`AutoFixService` already exists. Wire it: after every successful tool call that modifies files, check `vscode.languages.getDiagnostics(uri)` for new errors. If any errors appeared, call `AutoFixService.runAutoFixLoop(errors)` which re-prompts the model with the diagnostic message and lets it iterate up to 3 times.

## Implementation plan

I'm rolling this out in two waves:

### Wave 1 (this milestone, v0.1.3)

- ✅ **Stricter system prompt** — modify the base instructions in `AgentController` and `SystemPromptBuilder`. TDD: add prompt-content tests.
- ✅ **Repo map builder** — new `src/indexing/repo-map-builder.ts` module with TDD coverage.
- ✅ **Repo map injection** — `AgentController.processMessage` injects on first turn of a session.
- ✅ **Verbose tool errors** — update each tool's error responses with actionable hints. Update `read-file.ts`, `edit-file.ts`, `grep-search.ts`, `file-search.ts`.
- ✅ **Force read before edit** — track read files in `AgentController`, auto-inject `read_file` before `edit_file` on unfamiliar paths.

### Wave 2 (next milestone, v0.1.4)

- **Auto-fix loop wiring** — invoke `AutoFixService` from `AgentController` after each tool call that modifies files.
- **Approval flow** — pipe approval requests through the webview.
- **Mode enforcement** — `AgentController` accepts a mode and restricts tools accordingly.
- **`@-symbol` resolution** — wire `ContextResolver` into `ChatViewProvider`.
- **Secret redaction** — call `SecretScanner.scan()` on tool results before adding to LLM context.

## Measuring effectiveness

Hallucination is hard to measure without a benchmark, but we can track proxies:

| Proxy metric | What it tells us |
|--------------|------------------|
| Tool call rate per chat turn | Higher = model is acting, not describing |
| `edit_file` success rate (`old_content` actually matched) | Higher = model is grounded |
| Auto-fix loop iterations per chat session | Lower = fewer errors slipping through |
| User rejections in approval flow | Higher = model is making wrong decisions |
| Average chat turns to complete a task | Lower = less back-and-forth correction |

`MetricsCollector` already tracks tool calls and failures. Adding the rest is one method per metric.

## What this doesn't fix

Even with everything in this document implemented, these failure modes remain:

- **Pretrained knowledge cutoff** — the model doesn't know about libraries released after its training. Mitigation: `@Web` search, but that's a Round 5 item.
- **Model lacks reasoning capability** — a 3B model still won't reason as well as a 70B. Mitigation: use a bigger model (see `MODEL_GUIDE.md`).
- **Pathologically weird codebases** — if the user's code follows non-standard conventions, the model will mispredict. Mitigation: project rules (`.champ/rules/*.md`) once that's wired.
- **Adversarial prompts** — a user actively trying to make the model fail will succeed. Out of scope.

The goal is not zero hallucination — it's "few enough hallucinations that the user trusts the agent". Cursor and Aider hit that bar with the techniques above. Champ can too.
