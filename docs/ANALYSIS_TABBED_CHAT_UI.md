# Analysis: Tabbed Chat UI — open-source alternatives Pattern

Status: **analysis complete, ready for implementation review**

Reference: open-source alternatives VS Code extension screenshot (2026-04-10)

---

## What open-source alternatives Does Differently

### 1. Tabbed Sessions (Browser-Style)

```
┌──────────┬──────────┬──────────┬───┐
│ Chat 1 ✕ │ Chat 2 ✕ │ Chat 3 ✕ │ + │  ← tabs at top
├──────────┴──────────┴──────────┴───┤
│                                     │
│  ... active chat messages ...       │
│                                     │
└─────────────────────────────────────┘
```

**Current Champ approach**: Collapsible sidebar session list with time groups.

**open-source alternatives approach**: Horizontal tabs like browser tabs. Each chat is a tab. Click to switch, ✕ to close, + to create new.

**Why it's better**:
- **Familiar metaphor** — every user understands browser tabs
- **Zero-click switching** — tabs are always visible, no expand/collapse
- **Spatial memory** — users remember "the third tab" more easily than scanning a list
- **Less vertical space** — a tab bar is 30px vs a session list that can be 200px+
- **Multiple chats visible** — you can see how many are open at a glance

**Trade-off**: Tab bar gets cramped with 10+ sessions. open-source alternatives handles this with overflow scrolling + a dropdown menu for older chats.

### 2. Conversation Action Bar

```
┌─────────────────────────────────────────────┐
│ [History] [Settings]  [Compact] [Delete] [Copy] [👍] [👎] │
└─────────────────────────────────────────────┘
```

**Current Champ approach**: Settings via header ⚙ icon, no per-conversation actions.

**open-source alternatives approach**: A horizontal action bar below the tabs with:
- **History** — opens a session history browser (like our session list, but as a full panel)
- **Settings** — opens provider/model settings inline
- **Compact conversation** — collapses tool call cards and long messages to summaries
- **Delete chat** — deletes the current conversation
- **Copy** — copies the entire conversation to clipboard
- **Helpful / Not Helpful** — feedback buttons for the response quality

**Why it's better**:
- **Compact toggle** is huge for long agent sessions with many tool calls — reduces a 50-message chat to key points
- **Copy entire chat** — users frequently need this for sharing with teammates, pasting into docs, or filing bug reports
- **Feedback buttons** — even without a backend to collect them, they train users to evaluate outputs critically. With a backend, they become a gold mine for prompt tuning
- **Delete is per-chat** — cleaner than our right-click menu on a session row

### 3. Mode Dropdown (Chat / Plan / Agent)

```
┌──────────────┐
│ Chat      ▾  │  ← dropdown replaces radio/select
│ ─────────────│
│ ○ Chat       │
│ ○ Plan       │
│ ● Agent      │
└──────────────┘
```

**Current Champ approach**: Native `<select>` in the bottom bar.

**open-source alternatives approach**: A styled dropdown button in the input area, showing the current mode with a clear label.

**Why it's better**:
- **More prominent** — mode is a critical choice that affects behavior dramatically
- **Better labeling** — can show a description below each option
- **Consistent with model picker** — both are popup-style pickers, not native selects

### 4. Auto-Detected Models

```
┌────────────────────────────────┐
│ Models (auto-detected)         │
│ ──────────────────────────────│
│ ● llama3.1:8b       (ollama)  │
│ ○ qwen2.5-coder:7b  (ollama)  │
│ ○ codestral:22b     (ollama)  │
│ ○ default           (llamacpp)│
│ ○ Llama-3.1-8B      (vllm)   │
│ ──────────────────────────────│
│ + Add model manually           │
└────────────────────────────────┘
```

**Current Champ approach**: Models defined in `.champ/config.yaml` → listed in model picker.

**open-source alternatives approach**: Queries each configured provider's API for available models:
- **Ollama**: `GET /api/tags` → lists all pulled models
- **llama.cpp**: The loaded model is the only model (single model server)
- **vLLM**: `GET /v1/models` → lists served models
- **OpenAI-compatible**: `GET /v1/models` → lists available models

**Why it's better**:
- **No manual YAML per model** — pull a new model in Ollama, it appears automatically
- **Always accurate** — if a model was deleted, it disappears; if a new one was pulled, it appears
- **Discovery** — users see what's available without reading docs
- **Lower friction** — new users don't need to know model names upfront

**Implementation cost**: Low — all these endpoints already exist in the providers. Just need a `listModels()` method on each provider (some already have it).

### 5. Integrated History Panel

**Current Champ approach**: Session list in a collapsible sidebar above messages.

**open-source alternatives approach**: History is a **separate panel/tab** that shows all past conversations with search, not inline above the chat.

**Why it's better**:
- **Doesn't steal space** from the active conversation
- **Can show more metadata** — timestamps, message count, model used
- **Search across all conversations** — not just the visible list
- **Full-screen browsable** — not limited to 220px max-height

---

## Impact Assessment

| Feature | UX Impact | Implementation Effort | Priority |
|---------|-----------|----------------------|----------|
| Tabbed sessions | High — most requested pattern | Medium (2 days) | P0 |
| Auto-detect models | High — removes friction | Low (1 day) | P0 |
| Compact conversation | Medium — great for long chats | Low (0.5 day) | P1 |
| Copy entire chat | Medium — frequent need | Trivial (2 hrs) | P1 |
| Feedback buttons | Low now, high later | Trivial (2 hrs) | P2 |
| Mode as styled dropdown | Low — cosmetic upgrade | Low (0.5 day) | P2 |
| History as separate panel | Medium — cleaner layout | Medium (1 day) | P1 |

---

## Implementation Plan

### Phase 1: Tabbed Sessions + Auto-Detect Models (P0)

#### 1A. Tab Bar in Webview

Replace the session list panel with a horizontal tab bar:

```
Webview Layout:
┌──────────────────────────────────────────┐
│ Header: Champ-1.0.0            [⚙] [?]  │
├──────────┬──────────┬──────────┬───┐─────┤
│ Chat 1 ✕ │ Chat 2 ✕ │ Chat 3 ✕ │ + │ [≡] │  ← tab bar
├──────────┴──────────┴──────────┴───┴─────┤
│ [History] [Compact] [Delete] [Copy] [👍👎]│  ← action bar
├──────────────────────────────────────────┤
│                                          │
│  ... messages ...                        │
│                                          │
├──────────────────────────────────────────┤
│  📎 [textarea]                           │
│  [Agent ▾] [model ▾]     [Cancel][Send]  │
│  metrics footer                          │
└──────────────────────────────────────────┘
```

**New webview state:**
```javascript
state.tabs = [];            // { id, label, active }
state.activeTabId = null;
```

**New messages:**
```typescript
// No new protocol messages needed — tabs are a webview-only
// visual layer over the existing session system. Tab clicks
// send switchSessionRequest, tab close sends deleteSessionRequest,
// tab + sends newSessionRequest. The existing commands handle
// everything.
```

**CSS changes:**
- New `.tab-bar` flex container with horizontal scroll
- `.tab` items with label + close button
- `.tab.active` with highlighted background
- `.tab-bar-add` button at the end
- Remove `.session-panel`, `.session-list`, `.session-search`, etc.

#### 1B. Auto-Detect Models

Add `listModels()` to each provider and call it during `loadProvider()`:

```typescript
// In LLMProvider interface (src/providers/types.ts):
listModels?(): Promise<Array<{ id: string; name: string }>>;

// In OllamaProvider:
async listModels() {
  const res = await fetch(`${this.baseUrl}/api/tags`);
  const data = await res.json();
  return data.models.map(m => ({ id: m.name, name: m.name }));
}

// In OpenAICompatibleProvider (covers vLLM, llama.cpp):
async listModels() {
  const res = await fetch(`${this.baseUrl}/v1/models`);
  const data = await res.json();
  return data.data.map(m => ({ id: m.id, name: m.id }));
}
```

Then in `loadProvider()`, after the provider is ready:
```typescript
// Query each configured provider for available models.
const detectedModels = [];
for (const [name, conf] of Object.entries(yamlConfig.providers)) {
  try {
    const provider = factory.createTemporary(name, conf);
    const models = await provider.listModels();
    detectedModels.push(...models.map(m => ({
      providerName: name, modelName: m.name, label: `${m.name} (${name})`
    })));
  } catch { /* provider offline — skip */ }
}
// Merge with static config and broadcast.
```

### Phase 2: Action Bar + Compact + Copy (P1)

#### 2A. Conversation Action Bar

Add a slim bar between the tab bar and messages:

```javascript
const actionBar = el('div', { class: 'action-bar' });
const historyBtn = actionBtn('📋', 'History', () => toggleHistoryPanel());
const compactBtn = actionBtn('▤', 'Compact', () => toggleCompact());
const deleteBtn = actionBtn('🗑', 'Delete', () => deleteCurrentChat());
const copyBtn = actionBtn('📄', 'Copy', () => copyCurrentChat());
const helpfulBtn = actionBtn('👍', 'Helpful', () => markHelpful());
const notHelpfulBtn = actionBtn('👎', 'Not helpful', () => markNotHelpful());
actionBar.append(historyBtn, compactBtn, deleteBtn, copyBtn, helpfulBtn, notHelpfulBtn);
```

#### 2B. Compact Conversation Toggle

When active, replaces each message with a one-line summary:
- User messages: first 80 chars
- Assistant messages: first 80 chars  
- Tool call cards: collapsed to "🔧 tool_name → success/error"

```javascript
function toggleCompact() {
  state.compact = !state.compact;
  for (const msg of messagesContainer.querySelectorAll('.message')) {
    msg.classList.toggle('compact', state.compact);
  }
}
```

CSS:
```css
.message.compact .body {
  max-height: 1.6em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
.message.compact .tool-card {
  display: none;
}
```

#### 2C. Copy Entire Chat

```javascript
function copyCurrentChat() {
  const text = state.messages
    .map(m => `${m.role}: ${m.text}`)
    .join('\n\n');
  navigator.clipboard.writeText(text);
}
```

### Phase 3: Feedback + Mode Dropdown Polish (P2)

#### 3A. Feedback Buttons

Store feedback per-session in metadata:
```typescript
// In SessionMetadata:
feedback?: 'helpful' | 'not-helpful';
```

The buttons set this field and save. No backend needed now — the data lives in the session JSON for future analysis.

#### 3B. Mode as Styled Dropdown

Replace the `<select>` with a popup picker (same pattern as model picker):

```javascript
const modePickerBtn = el('button', { class: 'mode-picker-btn' }, ['Agent ▾']);
// Popup with Chat, Plan, Agent options + descriptions.
```

---

## Migration Path

The tab bar replaces the session list panel. The existing `sessionList` message protocol stays the same — the webview just renders tabs instead of rows. No backend changes needed.

Auto-detect models requires adding `listModels()` to the provider interface. Existing providers that don't implement it fall back to the YAML-defined model list.

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Tab bar overflows with many sessions | Horizontal scroll + overflow dropdown (≡ button) |
| Auto-detect slows activation | Query models in background, show YAML list first, merge when ready |
| Compact mode loses context | Toggle is per-session, not global; clicking a message expands it |
| Feedback data unused | Store locally in session JSON; no backend dependency |

---

## Success Criteria

- [ ] Tabs replace session list — click to switch, ✕ to close, + to create
- [ ] Auto-detected models appear in model picker without YAML changes
- [ ] Action bar: compact toggle, delete, copy, feedback buttons
- [ ] Copy entire chat works to clipboard
- [ ] Compact mode collapses messages to one-liners
- [ ] All existing 519 tests still pass
- [ ] Webview bundle stays under 40 KB

---

## Comparison: Before vs After

| Aspect | Current (Champ v1.0.0) | After (Champ v1.1.0) |
|--------|----------------------|---------------------|
| Session switching | Sidebar list, click to switch | Tab bar, click tab |
| Space usage | Session list takes 200px+ | Tab bar takes 30px |
| Model discovery | Manual YAML per model | Auto-detected from provider APIs |
| Long conversations | Scroll through everything | Compact toggle |
| Sharing chat | Manual copy-paste | One-click copy entire chat |
| Quality signal | None | Helpful/Not Helpful buttons |
| Mode selection | Native `<select>` | Styled popup picker |

---

## Conclusion

The open-source alternatives pattern is **objectively better** for these reasons:

1. **Tabs > sidebar list** — more familiar, less space, faster switching
2. **Auto-detect models > manual YAML** — zero friction for new models
3. **Action bar > scattered controls** — all conversation actions in one place
4. **Compact mode** — essential for long agent sessions that generate 50+ tool calls
5. **Copy chat** — a basic feature every chat tool should have

Total estimated effort: **4-5 days** for full implementation across all three phases.

Recommendation: **Implement Phase 1 (tabs + auto-detect) immediately** as it delivers the highest UX impact. Phases 2-3 can follow incrementally.
