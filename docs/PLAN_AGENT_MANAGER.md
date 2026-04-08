# PLAN: Agent Manager

Status: **design** — not yet implemented. Targets v0.2.

## Why

Today AIDev runs a single chat session. If you start a long task ("refactor the auth module"), then realize you need to ask a quick unrelated question, you have to either wait or destroy the long-running context. Cursor 3.0 introduced an "Agents Window" exactly to solve this — multiple parallel sessions, each with its own state and history, switchable from a sidebar list.

This is also a prerequisite for several other features:
- **Background agents** that work autonomously while you do other things
- **Best-of-N** runs that fan a single prompt out to multiple models
- **Plan-then-execute** workflows where the planning session and execution session are kept separate
- **Composer mode** sessions that don't pollute regular chat history

## Goals

- **Multiple parallel sessions.** Each is independent — separate history, mode, modified-files set, repo map cache, abort signal.
- **Lifecycle commands.** Create, switch, abort, archive, delete.
- **Persistence.** Sessions survive a window reload. Stored under `.aidev/sessions/`.
- **Visibility.** A sidebar list shows every session with its status badge (idle / running / completed / errored), title, and a quick-action menu.
- **Backward compatible.** v0.1.x users with a single chat see "session 1" and nothing else changes.

## Non-goals (for v0.2)

- Cross-session communication (one session referencing another's output) — possible later
- Distributed execution (sessions running on remote machines) — possible later
- Cloud-hosted sessions à la Cursor's background agents — that's v0.3+

## Architecture

```
+-----------------------------------+
| extension.ts (activate)            |
|                                    |
|   AgentManager                     |
|     ┌─ session-1: AgentSession     |
|     │     AgentController          |
|     │     mode, history, files     |
|     │     metrics                  |
|     │                              |
|     ├─ session-2: AgentSession     |
|     ├─ session-3: AgentSession     |
|     └─ activeSessionId             |
|                                    |
|   ChatViewProvider                 |
|     ↑↓ messages routed to active   |
|        session via manager         |
|                                    |
|   SessionStore (.aidev/sessions/)  |
+-----------------------------------+
```

## Module decomposition

### `src/agent-manager/types.ts`
```typescript
export type SessionState =
  | 'idle'
  | 'running'
  | 'aborted'
  | 'errored'
  | 'completed';

export interface SessionMetadata {
  id: string;
  label: string;          // user-provided or auto-generated from first message
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;
  mode: AgentMode;
  messageCount: number;
  modifiedFiles: string[];
  archived: boolean;
}

export interface AgentSession {
  metadata: SessionMetadata;
  controller: AgentController;
  /** Per-session abort controller — abort() cancels in-flight LLM call only. */
  abortInFlight: () => void;
}
```

### `src/agent-manager/agent-manager.ts`
```typescript
export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private activeId: string | null = null;
  private listeners = new Set<(event: ManagerEvent) => void>();

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly workspaceRoot: string,
    private readonly providerProvider: () => LLMProvider,
  ) {}

  // ─── lifecycle ─────────────────────────────────────────────────
  createSession(label?: string): AgentSession;
  getSession(id: string): AgentSession | undefined;
  getActive(): AgentSession | null;
  setActive(id: string): void;
  listSessions(includeArchived?: boolean): SessionMetadata[];
  abortSession(id: string): void;            // stops in-flight, keeps history
  archiveSession(id: string): void;          // hides from default list
  deleteSession(id: string): void;           // permanent

  // ─── events ────────────────────────────────────────────────────
  onChange(listener: (event: ManagerEvent) => void): () => void;

  // ─── persistence helpers (called by SessionStore) ──────────────
  exportSession(id: string): SerializedSession;
  importSession(serialized: SerializedSession): AgentSession;

  // ─── provider hot-swap (when user changes config) ──────────────
  swapProvider(provider: LLMProvider): void;
}

export type ManagerEvent =
  | { type: 'sessionCreated'; id: string }
  | { type: 'sessionStateChanged'; id: string; state: SessionState }
  | { type: 'activeChanged'; id: string | null }
  | { type: 'sessionDeleted'; id: string };
```

### `src/agent-manager/session-store.ts`
```typescript
export class SessionStore {
  constructor(private readonly storageRoot: string) {}

  /** Persist a session to <storageRoot>/<id>.json. */
  async save(session: SerializedSession): Promise<void>;

  /** Load all sessions from disk on activation. */
  async loadAll(): Promise<SerializedSession[]>;

  /** Delete a session file. */
  async delete(id: string): Promise<void>;

  /** Prune sessions older than `days` and not bookmarked. */
  async pruneOlderThan(days: number): Promise<number>;
}

export interface SerializedSession {
  metadata: SessionMetadata;
  history: LLMMessage[];
}
```

Storage: `<workspace>/.aidev/sessions/<sessionId>.json`. JSON is fine — sessions are small, and we want them human-readable for debugging.

### Updates to existing files

`src/ui/chat-view-provider.ts` — currently holds a single `AgentController`. Replace with an `AgentManager` reference. Every webview message routes to `manager.getActive().controller`. Add new message types: `sessionList`, `switchSession`, `newSession`, `abortSession`.

`src/ui/messages.ts` — add session-related messages to the discriminated unions.

`webview-ui/dist/main.js` — render a sidebar list of sessions above the message area. Click to switch. Plus icon to create. Status dot per session. Right-click context menu: rename, abort, archive, delete.

`src/extension.ts` — instantiate `AgentManager` in the activation flow (replacing the inline `AgentController` creation). Wire `SessionStore.loadAll()` on activation.

## UI sketch

```
┌──────────────────────────────────────────┐
│ [Agent ▾]   Sessions ▾   [+New]  [⋯]    │  ← toolbar
├──────────────────────────────────────────┤
│ ● refactor auth module      running      │  ← session list
│ ○ explain webhook flow      idle         │     (active highlighted)
│ ✓ add tests for utils       completed    │
│ ✗ migrate db schema         errored      │
├──────────────────────────────────────────┤
│                                          │
│  ... messages of the active session ...  │  ← message area
│                                          │
├──────────────────────────────────────────┤
│ Ask AIDev anything...                    │
│                                          │
│                  [Cancel] [Send]         │
└──────────────────────────────────────────┘
```

## Test plan (TDD-first as always)

### `test/unit/agent-manager/agent-manager.test.ts`
- creates sessions with auto-generated labels
- assigns unique ids
- switching active session works
- listing excludes archived by default
- aborting a session changes state to `aborted` but keeps history
- deleting a session removes it from the map
- onChange events fire on every state change
- `getActive()` returns null when no sessions exist

### `test/unit/agent-manager/session-store.test.ts`
- save → loadAll round-trips a serialized session
- pruneOlderThan removes only sessions older than the cutoff
- corrupted files are skipped (with a warning) instead of crashing loadAll
- save creates the storage directory if missing

### `test/unit/agent-manager/integration.test.ts`
- Two parallel sessions don't share history
- Aborting session A while session B is running doesn't affect B
- Provider hot-swap updates every session's controller
- Persistence: save sessions, recreate manager, sessions are restored

## Phasing

### Phase A — minimal in-memory manager (1 day)
- `AgentManager` with create/list/abort/switch/delete
- `ChatViewProvider` routes to active session
- Webview shows session count in toolbar (no list yet)
- All tests for the manager itself

### Phase B — UI session list (1 day)
- Webview adds sidebar list with status badges
- Click-to-switch works
- "+ new session" button
- Per-session right-click menu

### Phase C — persistence (½ day)
- `SessionStore` with file-system backend
- `loadAll()` on extension activation
- `save()` after every state change (debounced)
- Pruning command: `AIDev: Clean Up Old Sessions`

### Phase D — polish (½ day)
- Auto-generate session labels from first user message (truncated)
- Per-session status bar item showing the active one
- Archive command (hides without deleting)
- Bookmark flag (immune to pruning)

Total: ~3 days of focused work.

## Open questions

1. **Storage scope**: workspace-scoped (`<repo>/.aidev/sessions/`) or extension-global? Workspace makes more sense for sharing sessions across team members via git, but it pollutes the repo. **Recommendation**: workspace by default, with a setting to switch to extension-global.

2. **Label auto-generation**: take the first 60 chars of the first user message? Or LLM-generate a 4-word title in the background? **Recommendation**: truncate the first message; LLM titles can come later.

3. **Per-session vs shared provider**: should each session have its own `LLMProvider` instance, or share one? **Recommendation**: share. Provider state is stateless per call; sharing avoids re-initialization cost.

4. **Concurrency**: should the active session block background sessions from running, or allow true parallelism? **Recommendation**: allow parallelism. The user clicks "background" or just keeps the same session running while they create a new active one.

## Success criteria

- All Round 3 features (auto-fix, checkpoints, diff preview) work per-session
- A user can run "refactor the auth module" in session A and "explain this function" in session B simultaneously
- Closing and reopening VS Code restores all sessions exactly
- Test count grows by ≥30 (manager + store + integration tests)
- No regressions in the existing 364 tests
