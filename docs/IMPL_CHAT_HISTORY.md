# IMPL: Historical Chat Support — Multi-Session Persistence

Status: **design complete, ready for implementation**

Companion to [`PLAN_AGENT_MANAGER.md`](PLAN_AGENT_MANAGER.md). This doc provides the full implementation blueprint with architecture diagrams, data flow, code-level details, storage schema, and phased delivery plan.

---

## Problem Statement

Today Champ runs a **single in-memory chat session**. The conversation history (`AgentController.history: LLMMessage[]`) lives only in RAM. If the user:

- Reloads the VS Code window, all history is lost
- Clicks "New Chat", the previous conversation is destroyed
- Wants to revisit yesterday's debugging session, they can't
- Needs two parallel tasks (long refactor + quick question), they must choose one

**Goal**: Persistent, multi-session chat history that survives reloads, supports switching, and provides a browsable sidebar list — matching what modern AI coding tools offer.

---

## Current State — What Exists

```
src/agent/agent-controller.ts
  └─ history: LLMMessage[] .............. in-memory only, cleared on reset()
  └─ getHistory(): LLMMessage[] ......... returns a shallow copy
  └─ reset() ............................ clears history + caches

src/ui/chat-view-provider.ts
  └─ holds ONE AgentController .......... no notion of "sessions"
  └─ handleNewChat() .................... calls agent.reset(), posts empty history

src/ui/messages.ts
  └─ ConversationHistoryMessage ......... carries LLMMessage[] to webview
  └─ RequestHistoryRequest .............. webview asks host for current history

src/providers/types.ts
  └─ LLMMessage { role, content, toolCalls?, toolCallId? }
     └─ no timestamp, no session id, no metadata

src/checkpoints/checkpoint-manager.ts
  └─ creates file snapshots (shadow copies of workspace files)
  └─ NOT conversation snapshots — unrelated to chat history
```

**Summary**: Zero persistence. Zero multi-session support. History is ephemeral.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  extension.ts                                                    │
│                                                                  │
│    AgentManager                                                  │
│    ┌─────────────────────────────────────────────────────────┐   │
│    │  sessions: Map<string, AgentSession>                    │   │
│    │                                                         │   │
│    │  ┌─ sess-a3f2: AgentSession ────────────────────────┐   │   │
│    │  │  metadata: { id, label, state, createdAt, ... }  │   │   │
│    │  │  controller: AgentController (has its own history)│   │   │
│    │  └──────────────────────────────────────────────────┘   │   │
│    │                                                         │   │
│    │  ┌─ sess-b7c9: AgentSession ────────────────────────┐   │   │
│    │  │  metadata: { ... }                               │   │   │
│    │  │  controller: AgentController                     │   │   │
│    │  └──────────────────────────────────────────────────┘   │   │
│    │                                                         │   │
│    │  activeSessionId: "sess-a3f2"                           │   │
│    └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│    SessionStore                                                  │
│    ┌─────────────────────────────────────────────────────────┐   │
│    │  storageRoot: <workspace>/.champ/sessions/              │   │
│    │  save(session) ──► write <id>.json                      │   │
│    │  loadAll() ◄── read all *.json on activation            │   │
│    │  delete(id) ──► unlink <id>.json                        │   │
│    │  pruneOlderThan(days) ──► remove old sessions           │   │
│    └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│    ChatViewProvider                                              │
│    ┌─────────────────────────────────────────────────────────┐   │
│    │  routes all webview messages to:                         │   │
│    │    manager.getActive().controller                        │   │
│    │  new message types:                                     │   │
│    │    sessionList, switchSession, newSession,               │   │
│    │    deleteSession, renameSession                          │   │
│    └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘

Webview (sandboxed iframe)
┌──────────────────────────────────────────────────────────────────┐
│  ┌─── Header ──────────────────────────────────────────────────┐ │
│  │ Champ                                         [+] [⚙] [?]  │ │
│  │ ollama: qwen2.5-coder:14b                                  │ │
│  ├─── Session List (collapsible) ──────────────────────────────┤ │
│  │ ● refactor auth module                       running   [⋯] │ │
│  │ ○ explain webhook flow                       idle      [⋯] │ │
│  │ ✓ add tests for utils                        completed [⋯] │ │
│  │ ✗ migrate db schema                          errored   [⋯] │ │
│  ├─── Messages ────────────────────────────────────────────────┤ │
│  │                                                             │ │
│  │  [user] How does the auth middleware work?                  │ │
│  │  [assistant] Let me check... [read_file src/auth.ts]...     │ │
│  │                                                             │ │
│  ├─── Input ───────────────────────────────────────────────────┤ │
│  │  📎 [textarea]                                              │ │
│  │  [Agent ▾] [Model ▾]                    [Cancel] [Send]     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### SessionMetadata

```typescript
// src/agent-manager/types.ts

export type SessionState =
  | "idle"        // created, no messages yet or waiting for user
  | "running"     // LLM call in progress
  | "aborted"     // user cancelled mid-stream
  | "errored"     // LLM or tool error on last turn
  | "completed";  // model finished its final response

export interface SessionMetadata {
  id: string;               // nanoid, e.g. "sess-a3f2x9"
  label: string;            // first 60 chars of first user message
  state: SessionState;
  createdAt: number;        // Date.now()
  lastActivityAt: number;   // updated on every message
  mode: AgentMode;
  messageCount: number;     // history.length
  modifiedFiles: string[];  // files touched by tool calls
  archived: boolean;        // hidden from default list
}
```

### SerializedSession (on-disk format)

```typescript
// src/agent-manager/session-store.ts

export interface SerializedSession {
  /** Schema version — bump on breaking changes to the format. */
  version: 1;
  metadata: SessionMetadata;
  history: LLMMessage[];
}
```

### Storage location

```
<workspace>/
  .champ/
    config.yaml
    sessions/
      sess-a3f2x9.json     # one file per session
      sess-b7c9k2.json
      sess-c1d4m8.json
```

Each `.json` file is a complete `SerializedSession` — human-readable, git-trackable (if the team wants to share sessions), and trivially loadable.

**Why filesystem over VS Code state?**
- `globalState`/`workspaceState` have undocumented size limits
- Filesystem files can be inspected, backed up, shared via git
- `.champ/sessions/` is already in the project's `.gitignore` pattern
- The `SessionStore` class hides the I/O — switching to SQLite later is a one-class change

---

## Message Protocol Additions

### Extension → Webview

```typescript
// Full session list pushed on activation and after every session change.
interface SessionListMessage {
  type: "sessionList";
  sessions: SessionMetadata[];
  activeSessionId: string | null;
}
```

### Webview → Extension

```typescript
interface SwitchSessionRequest {
  type: "switchSessionRequest";
  sessionId: string;
}

interface NewSessionRequest {
  type: "newSessionRequest";
  label?: string;  // optional user-provided label
}

interface DeleteSessionRequest {
  type: "deleteSessionRequest";
  sessionId: string;
}

interface RenameSessionRequest {
  type: "renameSessionRequest";
  sessionId: string;
  newLabel: string;
}

interface ArchiveSessionRequest {
  type: "archiveSessionRequest";
  sessionId: string;
}
```

---

## Sequence Diagrams

### New session creation

```
User           Webview              ChatViewProvider      AgentManager      SessionStore
 │               │                        │                    │                 │
 │ click [+]     │                        │                    │                 │
 ├──────────────►│                        │                    │                 │
 │               │ postMessage            │                    │                 │
 │               │  {type:"newSessionReq"}│                    │                 │
 │               ├───────────────────────►│                    │                 │
 │               │                        │ createSession()    │                 │
 │               │                        ├───────────────────►│                 │
 │               │                        │                    │ new AgentSession │
 │               │                        │                    │ + setActive()   │
 │               │                        │                    │                 │
 │               │                        │                    │ save()          │
 │               │                        │                    ├────────────────►│
 │               │                        │                    │                 │ write
 │               │                        │                    │                 │ .json
 │               │                        │                    │                 │
 │               │                        │◄── sessionList ────┤                 │
 │               │                        │    + activeChanged │                 │
 │               │◄── post sessionList ───┤                    │                 │
 │               │                        │                    │                 │
 │               │◄── post convHistory ───┤ (empty for new)    │                 │
 │               │                        │                    │                 │
 │               │ render: empty chat     │                    │                 │
 │               │ + highlight new sess   │                    │                 │
```

### Switching between sessions

```
User           Webview              ChatViewProvider      AgentManager
 │               │                        │                    │
 │ click         │                        │                    │
 │ "sess-b7c9"   │                        │                    │
 ├──────────────►│                        │                    │
 │               │ postMessage            │                    │
 │               │  {type:"switchSession",│                    │
 │               │   sessionId:"sess-b7c9"}                    │
 │               ├───────────────────────►│                    │
 │               │                        │ setActive          │
 │               │                        │  ("sess-b7c9")     │
 │               │                        ├───────────────────►│
 │               │                        │                    │
 │               │                        │◄─ activeChanged ───┤
 │               │                        │                    │
 │               │                        │ getActive()        │
 │               │                        │  .controller       │
 │               │                        │  .getHistory()     │
 │               │                        ├───────────────────►│
 │               │                        │◄──── LLMMessage[] ─┤
 │               │                        │                    │
 │               │◄── post sessionList ───┤                    │
 │               │◄── post convHistory ───┤                    │
 │               │                        │                    │
 │               │ render: selected       │                    │
 │               │ session's messages     │                    │
```

### Activation — restoring persisted sessions

```
extension.ts                     AgentManager          SessionStore          Disk
     │                                │                      │                 │
     │ activate()                     │                      │                 │
     ├──┐                             │                      │                 │
     │  │ new AgentManager()          │                      │                 │
     │◄─┘                             │                      │                 │
     │                                │                      │                 │
     │ loadPersistedSessions()        │                      │                 │
     ├───────────────────────────────►│                      │                 │
     │                                │ store.loadAll()      │                 │
     │                                ├─────────────────────►│                 │
     │                                │                      │ readdir + parse │
     │                                │                      ├────────────────►│
     │                                │                      │◄────────────────┤
     │                                │◄── SerializedSession[]                 │
     │                                │                      │                 │
     │                                │ for each:            │                 │
     │                                │   importSession()    │                 │
     │                                │   (rebuilds          │                 │
     │                                │    AgentController    │                 │
     │                                │    from history)     │                 │
     │                                │                      │                 │
     │                                │ setActive(most recent)│                │
     │                                │                      │                 │
     │◄── ready ──────────────────────┤                      │                 │
     │                                │                      │                 │
     │ post sessionList to webview    │                      │                 │
```

### Auto-save after every message

```
AgentController         AgentManager              SessionStore
     │                        │                          │
     │ processMessage()       │                          │
     │  done (history updated)│                          │
     │                        │                          │
     │◄── return ─────────────┤                          │
     │                        │                          │
     │                        │ debounced save()         │
     │                        ├─────────────────────────►│
     │                        │                          │ write
     │                        │                          │ <id>.json
     │                        │                          │
     │                        │ update metadata          │
     │                        │  (lastActivityAt,        │
     │                        │   messageCount,          │
     │                        │   state)                 │
     │                        │                          │
     │                        │ broadcast                │
     │                        │  sessionList to webview  │
```

---

## Module Decomposition

### New files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/agent-manager/types.ts` | `SessionState`, `SessionMetadata`, `ManagerEvent` types | ~40 |
| `src/agent-manager/agent-manager.ts` | Multi-session orchestrator | ~200 |
| `src/agent-manager/session-store.ts` | Filesystem persistence (`.champ/sessions/`) | ~120 |
| `test/unit/agent-manager/agent-manager.test.ts` | Manager unit tests | ~200 |
| `test/unit/agent-manager/session-store.test.ts` | Store unit tests | ~150 |

### Modified files

| File | Changes |
|------|---------|
| `src/extension.ts` | Replace inline `AgentController` with `AgentManager`. Wire `SessionStore.loadAll()` on activation. Add `champ.cleanupSessions` command. |
| `src/ui/chat-view-provider.ts` | Accept `AgentManager` instead of `AgentController`. Route messages to `manager.getActive().controller`. Handle new session message types. |
| `src/ui/messages.ts` | Add 6 new message types (sessionList, switchSession, newSession, deleteSession, renameSession, archiveSession) |
| `webview-ui/dist/main.js` | Add collapsible session list panel above messages. Click-to-switch, context menu, status badges. |
| `webview-ui/dist/main.css` | Session list styles |
| `package.json` | Register `champ.showOnboarding`, `champ.cleanupSessions` commands |

---

## Storage Schema (example JSON)

```json
{
  "version": 1,
  "metadata": {
    "id": "sess-a3f2x9",
    "label": "How does the auth middleware work?",
    "state": "completed",
    "createdAt": 1712793600000,
    "lastActivityAt": 1712795400000,
    "mode": "agent",
    "messageCount": 8,
    "modifiedFiles": [],
    "archived": false
  },
  "history": [
    {
      "role": "user",
      "content": "How does the auth middleware work?"
    },
    {
      "role": "assistant",
      "content": "Let me check the codebase...",
      "toolCalls": [
        {
          "id": "tc_1",
          "name": "grep_search",
          "arguments": { "query": "auth middleware" }
        }
      ]
    },
    {
      "role": "tool",
      "content": [
        {
          "type": "tool_result",
          "toolUseId": "tc_1",
          "content": "src/middleware/auth.ts:5: export function authMiddleware...",
          "isError": false
        }
      ],
      "toolCallId": "tc_1"
    }
  ]
}
```

---

## Phased Implementation Plan

### Phase A — AgentManager + SessionStore (core, no UI) — ~1.5 days

**Tests first** (target: +20 tests):

```
test/unit/agent-manager/agent-manager.test.ts
  ✓ creates a session with auto-generated id
  ✓ auto-labels from first user message (truncated at 60 chars)
  ✓ assigns unique ids across sessions
  ✓ getActive() returns null when no sessions exist
  ✓ createSession sets the new session as active
  ✓ setActive switches to a different session
  ✓ setActive throws for unknown session id
  ✓ listSessions returns all non-archived sessions
  ✓ listSessions with includeArchived returns everything
  ✓ abortSession changes state to "aborted" but keeps history
  ✓ deleteSession removes it from the map
  ✓ archiveSession hides it from default listing
  ✓ onChange fires on create/switch/delete/state-change
  ✓ exportSession produces a SerializedSession
  ✓ importSession rebuilds from a SerializedSession
  ✓ swapProvider updates all sessions' controllers

test/unit/agent-manager/session-store.test.ts
  ✓ save + loadAll round-trips a serialized session
  ✓ loadAll returns empty array when directory doesn't exist
  ✓ corrupted files are skipped with a warning
  ✓ delete removes the session file
  ✓ pruneOlderThan removes old sessions
  ✓ save creates the storage directory if missing
```

**Implementation**:
1. `src/agent-manager/types.ts` — type definitions
2. `src/agent-manager/agent-manager.ts` — in-memory session orchestrator
3. `src/agent-manager/session-store.ts` — filesystem persistence
4. Wire `AgentManager` into `extension.ts` (replace direct `AgentController` usage)
5. `ChatViewProvider` constructor accepts `AgentManager` — routes to `getActive().controller`
6. `SessionStore.loadAll()` called on activation to restore persisted sessions

**Key design decisions**:
- `AgentManager` creates sessions with a default `AgentController` each. The controller's `setProvider()` is called with the active provider.
- On `swapProvider()`, every session's controller gets the new provider.
- Auto-save is debounced (300ms) — triggered after every `processMessage()` completion and after every state change.
- The session labeled from the first user message: `text.slice(0, 60).replace(/\n/g, " ")`.

### Phase B — Message protocol + ChatViewProvider session routing — ~1 day

**Tests first** (target: +12 tests):

```
test/unit/ui/messages.test.ts (+6)
  ✓ creates a sessionList message with sessions + activeId
  ✓ identifies switchSessionRequest
  ✓ identifies newSessionRequest
  ✓ identifies deleteSessionRequest
  ✓ identifies renameSessionRequest
  ✓ identifies archiveSessionRequest

test/unit/ui/chat-view-provider.test.ts (+6)
  ✓ switchSessionRequest changes the active session and posts history
  ✓ newSessionRequest creates a session and posts empty history
  ✓ deleteSessionRequest removes the session
  ✓ renameSessionRequest updates the label
  ✓ broadcastSessionList posts the full list to the webview
  ✓ every userMessage goes to the active session's controller
```

**Implementation**:
1. Add 6 new message types to `src/ui/messages.ts`
2. Add handlers in `ChatViewProvider` for each
3. `broadcastSessionList()` method on ChatViewProvider
4. Wire `AgentManager.onChange()` to auto-broadcast session list on every change

### Phase C — Webview session list UI — ~1 day

**Pure webview changes** (JS + CSS, no extension-side tests):

1. Collapsible session list panel between the header and messages area
2. Each row shows: status dot (color-coded), label, relative timestamp
3. Click to switch (sends `switchSessionRequest`)
4. Right-click context menu: Rename, Archive, Delete
5. Status badge colors:
   - `idle`: gray
   - `running`: blue (animated pulse)
   - `completed`: green
   - `errored`: red
   - `aborted`: orange
6. Active session is highlighted with a selection background
7. Session list is collapsible via a toggle arrow to save space

### Phase D — Polish + commands — ~0.5 days

1. `champ.cleanupSessions` command: prune sessions older than 30 days (configurable)
2. Per-session status bar indication: `Champ: <session label> (running)`
3. Keyboard shortcut: `Ctrl+Shift+N` / `Cmd+Shift+N` for new session
4. Session search/filter in the list (for users with many sessions)
5. Auto-archive: sessions older than 7 days auto-archive (configurable)

---

## Migration Path

**v0.2.2 → v0.3.0 (with history support)**:

1. On first activation after upgrade, no `.champ/sessions/` exists — `loadAll()` returns empty, a single default session is created (backward compatible)
2. Users with existing single-chat flows see "Session 1" in the list and nothing else changes
3. The `newChat` command from v0.2.x maps to creating a new session
4. No config migration needed — sessions are a new layer, orthogonal to provider config

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Large session JSON files (long conversations) | Configurable max history length per session; pruning command |
| Corrupted JSON on crash during write | Write to temp file first, then atomic rename |
| Too many session files cluttering workspace | Auto-prune after 30 days; `.gitignore` pattern |
| Performance with 100+ sessions | `loadAll()` reads only metadata first; lazy-load history on switch |
| Breaking change to `LLMMessage` format | Schema version field in JSON; migration function on load |

---

## Success Criteria

When complete (target: v0.3.0):

- [ ] Session list shows all past conversations with status badges
- [ ] Clicking a session loads its full message history
- [ ] Creating a new session preserves the old one
- [ ] Closing and reopening VS Code restores all sessions exactly
- [ ] Deleting a session removes its JSON file
- [ ] Sessions auto-save after every message (debounced)
- [ ] Test count grows by >=32 (manager + store + protocol + handler tests)
- [ ] No regressions in existing 474 tests
- [ ] Webview bundle stays under 35 KB (JS + CSS)
- [ ] `.vsix` stays under 400 KB

---

## What this doc is NOT

- Not a substitute for `PLAN_AGENT_MANAGER.md` (the high-level rationale)
- Not a design discussion — decisions are settled, this is execution-only
- Not a webview pixel-level spec — the session list visuals follow VS Code's native list patterns
