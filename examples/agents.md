# Agent Usage Guide

How to drive Champ's agent effectively from the sidebar chat.

## Modes

| Mode | Behaviour |
|------|-----------|
| `agent` | Full tool access: read/write files, run commands |
| `ask` | Read-only tools only — answers questions about your codebase |
| `plan` | Read-only; produces a step-by-step implementation plan |
| `manual` | You drive; Champ assists without autonomous actions |
| `composer` | Multi-file edit workflow: plan → diff → apply (git branch/commit/rollback) |

Switch modes in the chat header or via `champ.toggleMode` (`Ctrl+Shift+M`).

## Context injection (@-symbols)

Type `@` in the chat box for autocomplete:

| Symbol | Injects |
|--------|---------|
| `@Files src/foo.ts` | File contents |
| `@Folders src/tools` | Directory listing |
| `@Code` | Current editor selection |
| `@Codebase <question>` | Semantic search over the RAG index (top 8 chunks) |
| `@Web <query>` | Web search results |
| `@Git <cmd>` | Output of a git command |
| `@GitBlame(src/foo.ts:42)` | Blame for a line |
| `@TestFor(myFunction)` | Existing tests referencing the symbol |
| `@Terminal(50)` | Last N lines of agent terminal output |
| `@Docs <pkg>` | README of an installed node package |
| `@PR(123)` / `@Issue(456)` | GitHub PR/issue via `gh` CLI |
| `@MCP(server:uri)` / `@MCPPrompt(server:name)` | MCP resources & prompts |
| `@Symbols <query>` | Workspace symbol search |

## Built-in tools

`read_file`, `edit_file`, `create_file`, `delete_file`, `list_directory`,
`file_search`, `grep_search`, `run_terminal_cmd`, `remote_run_terminal_cmd`,
`browser_tool`, `fetch_url`, `web_search`, `codebase_search`, `delegate_task`,
`generate_doc`, `generate_diagram`, `publish_channel`, `run_tests`,
`read_file` variants for remote targets.

Destructive tools (`edit_file`, `create_file`, `delete_file`,
`run_terminal_cmd`, …) are **approval-gated**: you get a preview diff or
command before execution. Approve once, always-for-session, or deny.

- `champ.yoloMode: true` skips all prompts — use only in trusted workspaces
- Deny-by-default applies when no approval UI is wired (e.g. headless API use)

## Skills

Slash-command templates with variable interpolation:

```
/explain src/utils/url-guard.ts
/test parseToolCallsFromText
/refactor extract the SSE parser into its own module
```

Built-ins: `/explain /test /refactor /review /commit /doc /fix /optimize`.
Add your own in `.champ/skills/*.md` (workspace) or `~/.champ/skills/*.md`
(user) with frontmatter:

```markdown
---
name: migrate
description: Convert a JS file to TypeScript
mode: agent
allowedTools: [read_file, edit_file, run_terminal_cmd]
trigger: /migrate
---
Convert $input to TypeScript. Keep behaviour identical...
```

## Safety nets

- **Checkpoints** — shadow-copy snapshots before edits (`Champ: Save/Restore Checkpoint`)
- **Auto-fix** — after edits, LSP errors trigger up-to-N repair iterations (`agent.autoFix`)
- **Secret redaction** — keys/tokens found in tool output are masked before reaching the LLM
- **PromptGuard** — injection patterns blocked on input *and* tool outputs
- **Audit log** — hash-chained record of every action; `Champ: Verify Audit Log`

## Tips

1. Use `plan` mode first for anything non-trivial, then switch to `agent`.
2. Point at specific files with `@Files` — cheaper and more accurate than hoping retrieval finds them.
3. Cancelled turns discard staged edits by design; re-run if you changed your mind.
4. Long sessions: compaction summarises old turns automatically; start `Champ: New Chat` between unrelated tasks.
