# PLAN: v0.2 Roadmap (post-YAML config)

Status: **planning** — concrete proposals for what comes after v0.1.4.

## Where we are

- **v0.1.4 shipped** (current): YAML config, anti-hallucination, mode enforcement, @-symbol resolution, approval flow, secret redaction, repo map injection.
- **GAP_ANALYSIS score**: 11/22 features wired and working in the runtime.
- **364 tests passing**, TypeScript clean, ESLint clean.
- **Open gaps**: 11 still on the table — see GAP_ANALYSIS.md for the full inventory.

## v0.2 themes

Three big themes for the next milestone, in priority order:

### Theme 1 — Workflow ergonomics (Skills + Agent Manager)

The features that change *how* you use AIDev day-to-day. Highest impact-per-effort because they unlock things you can't do today at all.

| Feature | Status | Plan doc | Estimated effort |
|---------|--------|----------|-------------------|
| **Skills system** (`/explain`, `/test`, `/commit`, custom skills) | designed | [`PLAN_SKILLS.md`](PLAN_SKILLS.md) | ~2.5 days |
| **Agent Manager** (parallel sessions, persistence, switcher) | designed | [`PLAN_AGENT_MANAGER.md`](PLAN_AGENT_MANAGER.md) | ~3 days |

### Theme 2 — Closing the verification gaps

The features that exist as built-but-unwired modules. Cheap to wire because the modules already have full unit-test coverage.

| Feature | Effort | Why it matters |
|---------|--------|----------------|
| **Auto-fix loop wiring** — call `AutoFixService` after every successful tool call | ½ day | Catches most hallucinations because they fail to compile |
| **Checkpoint auto-create before destructive tools** | ½ day | Lets the user roll back any agent action |
| **Inline diff preview before apply** | 1 day | The single biggest "feels like Cursor" missing piece |
| **Rules engine loads `.aidev/rules/*.md`** | ½ day | Per-file glob-attached project rules |
| **Codebase indexing on activation** | 2 days | `@Codebase` actually works; needs an embedding service |

### Theme 3 — New capabilities

Features that need new code (not just wiring), but unlock big workflows.

| Feature | Effort | Why |
|---------|--------|-----|
| **Custom modes** (user-defined modes via YAML) | 1 day | Power users want a security-reviewer mode, doc-writer mode, etc. |
| **Plan persistence** (`.aidev/plans/<timestamp>.md`) | ½ day | Plan mode produces a plan; today it's lost when chat closes |
| **Image input** (paste screenshots into chat) | 1 day | Multimodal models can use them |
| **Memory system** (`.aidev/memory/`) | 2 days | Long-term recall across sessions |
| **Background agents** (run without UI) | 2 days | Long tasks like "refactor entire repo to async" |
| **Best-of-N** (run prompt across multiple models, compare) | 1 day | Quality boost when one model hallucinates |
| **MCP protocol wiring** (replace stub with real SDK) | 2 days | Extensibility — github, slack, db, etc. |
| **Web search tool** (Tavily/Brave/SearXNG) | ½ day | `@Web` actually works |

## Recommended order

I'd attack v0.2 in this order:

1. **Skills system** — biggest UX win, lowest risk, builds team adoption  
2. **Agent Manager Phase A+B** (in-memory + UI list) — unlocks parallel work  
3. **Auto-fix loop wiring** — anti-hallucination win, almost free  
4. **Checkpoint auto-create + restore UI** — safety net for the user  
5. **Inline diff preview** — biggest "feels like Cursor" missing piece  
6. **Custom modes** — power-user feature with low effort  
7. **Agent Manager Phase C+D** (persistence + polish)  
8. **Plan persistence** — quick win  
9. **Rules engine `.aidev/rules/`** — quick win  
10. **Image input** — multimodal users  
11. **Codebase indexing on activation** — biggest single-feature in this list  
12. **Memory system** — important but the contract needs more thought  
13. **MCP, background agents, best-of-N, web search** — nice-to-haves  

This sequence frontloads the high-impact-low-effort items so each release feels like a meaningful upgrade.

## Custom modes — design sketch

Already partially designed in v0.1's package.json schema. The implementation needs:

```yaml
# .aidev/config.yaml
modes:
  security-reviewer:
    extends: ask
    description: Reviews code for security issues
    systemPromptAppend: |
      You are a security-focused code reviewer. Look for:
      - Injection vulnerabilities (SQL, XSS, command)
      - Authentication and authorization issues
      - Data exposure risks
      - Insecure dependencies
      Use grep_search to find similar patterns elsewhere in the codebase.
    allowedTools: [read_file, grep_search, file_search, codebase_search]
  doc-writer:
    extends: agent
    description: Writes JSDoc comments
    systemPromptAppend: |
      Add comprehensive JSDoc to every exported function. Follow the
      JSDoc style already in use elsewhere in this file.
    allowedTools: [read_file, edit_file]
```

Components:
- `src/agent/custom-modes.ts` — load + register modes from config
- `AgentController.setMode()` accepts custom names
- `SystemPromptBuilder` reads custom mode definitions
- ChatViewProvider mode dropdown lists custom modes

Estimated effort: 1 day. TDD: parser tests, registry tests, integration test that custom mode restricts tools correctly.

## Memory system — design sketch

The hardest item on the list. Memory is genuinely useful but the contract is subtle. Sketch:

- `.aidev/memory/` directory with categorized markdown files:
  - `user.md` — facts about the user (role, preferences, conventions)
  - `project.md` — facts about the project (architecture decisions, history)
  - `feedback.md` — corrections the user has given the agent
  - `references.md` — external systems + where to look
- An LLM-controlled MEMORY tool: `read_memory`, `write_memory`, `update_memory`
- Memory loaded into the system prompt at session start (truncated to a budget)
- Memory updates require explicit user approval (so the agent can't poison its own memory with hallucinations)

This is a 2-3 day effort minimum. **Recommendation**: defer to v0.3. The contract is too important to rush.

## Background agents — design sketch

Builds on Agent Manager. A "background agent" is just a session that:
- Doesn't have a UI focus
- Persists across window reloads
- Runs autonomously without per-step approval
- Reports back via notifications when it completes (or errors)
- Optionally posts a PR/branch when done

Implementation:
- `AgentSession.background = true` flag
- A "Run in background" button next to "Send"
- Status bar shows count of running background agents
- Notifications on completion
- Per-session log under `.aidev/sessions/<id>.log`

Depends on Agent Manager Phase C (persistence). Estimated effort: 2 days after Agent Manager is in place.

## Best-of-N — design sketch

Run the same prompt across N providers in parallel, present the user with all responses to pick from. Useful when a single model hallucinates.

- New command: `AIDev: Run with Best-of-N`
- Pick N providers from a dropdown
- Send the same prompt to each
- Render all responses side-by-side in the chat panel with "Use this response" buttons
- Continue the conversation with the chosen response

Depends on multiple providers being configured. Estimated effort: 1 day.

## Voice input

Out of scope for v0.2. Whisper is a ~150MB model and the latency for high-quality input is hard to hit on consumer hardware. **Recommendation**: defer to v0.4+ when a smaller realtime ASR model exists.

## Success criteria for v0.2

When v0.2 ships:
- Skills system is wired with 8 built-in skills + user-defined support
- Multiple parallel sessions via Agent Manager
- Auto-fix loop catches LSP errors and re-prompts the model
- Checkpoints auto-create before every destructive tool call
- Inline diff preview shows green/red before applying
- Custom modes work
- Plan persistence
- Rules engine loads `.aidev/rules/`
- Test count grows by ≥80 (skills, agent manager, auto-fix, checkpoints, custom modes, rules wiring)
- GAP_ANALYSIS.md score: 18/22 wired (up from 11)
- Test report on every commit, hook discipline preserved

## Out of scope for v0.2

Explicitly deferred to v0.3+:
- Codebase embedding indexing (needs an embedding service — bigger lift than expected)
- Memory system (contract design needs more thought)
- MCP protocol wiring (low immediate value for the target user)
- Background agents Phase 2 (cloud execution)
- Best-of-N
- Voice input
- Image generation

## Continuous discipline

Even with all this new code, the rules from `GROUND_RULES.md` stay:

- Tests written first, every time
- Pre-commit hook lints + typechecks
- Post-commit hook runs the full suite + generates a per-commit JSON report
- No regression: existing 364 tests stay green
- ESLint clean
- TypeScript strict mode, zero errors
