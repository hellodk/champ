# PLAN: Chat UI v2 — Cursor-style layout + onboarding

Status: **design** — not yet implemented. Targets v0.2.

Motivation from direct user feedback (v0.1.6):
1. Need a **settings button** directly on the chat panel, not just a status bar item in the bottom corner
2. Need a **sample settings file** experience — first-time users shouldn't have to read `docs/CONFIG.md` before getting started
3. **Agent options should be at the bottom near the input**, matching Cursor's layout (not at the top like a traditional toolbar)

While we're touching the chat UI, a few more small refinements pair naturally with these three changes. This doc bundles all seven items as a cohesive v0.2 chat UI pass.

---

## Current layout vs target layout

### Before (v0.1.6)

```
┌──────────────────────────────────────┐
│ [Agent ▾]              [New Chat]    │  ← top toolbar (mode + new chat)
├──────────────────────────────────────┤
│                                      │
│   assistant                          │
│   ┌────────────────────────────┐    │
│   │ Sure, I'll read that file. │    │
│   │ 🔧 read_file                │    │
│   │   {"path": "main.ts"}      │    │
│   └────────────────────────────┘    │
│                                      │
│   user                               │
│   ┌────────────────────────────┐    │
│   │ Read main.ts                │    │
│   └────────────────────────────┘    │
│                                      │
├──────────────────────────────────────┤
│  [slash-command dropdown]            │
│  Ask AIDev anything...               │
│                                      │
│                  [Cancel] [Send]     │
└──────────────────────────────────────┘
```

Problems:
- Mode switcher is 6 cm away from the Send button — you have to move your eye up to change mode, down to type, up to verify, down to send
- No way to tell which provider is active without hovering the bottom-right status bar
- Settings gear only exists in the status bar — hidden from users who don't know to look
- First-run experience: chat loads with no config → provider fails → error in chat → user has to find the Command Palette to run `AIDev: Generate Config File`
- No message-level actions (copy, retry)
- No indication of whether messages in-progress are at the top or bottom of your scroll position

### After (Cursor-style, proposed v0.2)

```
┌──────────────────────────────────────┐
│  AIDev  ·  ollama:qwen2.5-coder:14b  │  ← 1. header shows active model
│                      [+] [⚙] [?]    │  ← 2. new chat + settings + help
├──────────────────────────────────────┤
│                                      │
│   user                               │
│   ┌────────────────────────────┐    │
│   │ Read main.ts                │    │
│   │                    [📋][↻] │    │  ← 3. per-message copy / retry
│   └────────────────────────────┘    │
│                                      │
│   assistant                          │
│   ┌────────────────────────────┐    │
│   │ Sure, I'll read that file. │    │
│   │ 🔧 read_file  ▶            │    │  ← 4. expandable tool cards
│   │                    [📋][↻] │    │
│   └────────────────────────────┘    │
│                                      │
│                      [↓ new msgs]    │  ← 5. scroll-to-bottom affordance
├──────────────────────────────────────┤
│  [slash-command dropdown]            │
│ ┌────────────────────────────────┐  │
│ │ [📎] Ask AIDev... / for cmds   │  │  ← 6. attach button beside textarea
│ └────────────────────────────────┘  │
│ [Agent ▾] [Model: qwen ▾]  [↵ Send] │  ← 7. mode + model + send, one row
└──────────────────────────────────────┘
```

Seven items all together. Let me design each one.

---

## Feature 1 — Settings button in chat header

**Problem**: Users can't find the settings from the chat panel. The only entry points today are:
- Clicking the status bar item (bottom-right, easy to miss)
- `Ctrl+Shift+P → AIDev: Settings` (requires knowing the command name)

**Solution**: Three icon buttons in the chat header, on the right side:

| Icon | Command | Tooltip |
|---|---|---|
| `+` | `aidev.newChat` | "New chat" |
| `⚙` (gear) | `aidev.openSettings` | "Open AIDev settings" |
| `?` (question) | `aidev.showHelp` | "AIDev help and examples" |

Clicking settings executes the existing `workbench.action.openSettings` command filtered to `aidev.*`. Clicking help opens `docs/USER_GUIDE.md` in a new editor tab (extension copies it from the bundled `extensionUri` first).

### Implementation

- `webview-ui/dist/main.js`: replace the current `[New Chat]` button with an icon group. Add three buttons using VS Code codicons (available to webviews via the built-in codicon font — no extra dependency).
- `webview-ui/dist/main.css`: style the icon group using `var(--vscode-toolbar-hoverBackground)` for hover, `var(--vscode-icon-foreground)` for glyph color. Keep the header compact (32px tall).
- `src/ui/messages.ts`: new outbound message type `openSettingsRequest`, `showHelpRequest`. Type guards.
- `src/ui/chat-view-provider.ts`: handle both requests by executing the corresponding VS Code commands.
- `src/extension.ts`: add `aidev.showHelp` command that opens `docs/USER_GUIDE.md` bundled with the extension.

### Test plan

- Messages protocol tests: 2 new guards + 2 factories (already testable in isolation)
- ChatViewProvider tests: clicking either button triggers the expected VS Code command via `vscode.commands.executeCommand` (spy it)
- Integration: the header renders three icon buttons with the right tooltips

**Effort**: ~half a day

---

## Feature 2 — Onboarding config picker (sample settings file)

**Problem**: First-run experience is broken. New user opens AIDev → no YAML config → provider loader falls through to legacy settings → no `aidev.*` keys set → tries `claude` by default → no API key → error in chat. User has to read `docs/CONFIG.md` or `docs/SETUP_GUIDE.md` to figure out what to do.

**Solution**: When activation runs and finds **no** workspace YAML **and** no legacy `aidev.*` settings, show a first-run onboarding panel inside the chat view with a picker:

```
┌──────────────────────────────────────┐
│  Welcome to AIDev                    │
│                                      │
│  Let's get started. Pick a setup:    │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ ○ Local: Ollama (recommended)  │ │
│  │   Privacy-first, no API key    │ │
│  │   Uses: qwen2.5-coder:7b       │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ ○ Local: llama.cpp             │ │
│  │   Apple Silicon / CPU native   │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ ○ Local: vLLM                  │ │
│  │   GPU inference, multi-model   │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ ○ Cloud: Claude                │ │
│  │   Best quality, needs API key  │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │ ○ Cloud + local autocomplete   │ │
│  │   Claude chat, Ollama complete │ │
│  └────────────────────────────────┘ │
│                                      │
│  [Create .aidev/config.yaml]         │
│  [Skip — I'll configure manually]    │
└──────────────────────────────────────┘
```

The 5 options map to the existing files in `examples/`:

| Option | Source file |
|---|---|
| Local: Ollama (recommended) | `examples/config.ollama-basic.yaml` |
| Local: llama.cpp | `examples/config.llamacpp.yaml` |
| Local: vLLM | `examples/config.vllm-basic.yaml` |
| Cloud: Claude | (derived — provider claude + no keys prompt) |
| Cloud + local autocomplete | `examples/config.cloud-fallback.yaml` |

Clicking "Create .aidev/config.yaml" copies the chosen template into the workspace and opens it in an editor tab for review. The existing YAML config file watcher picks it up automatically and hot-reloads the provider.

### Implementation

- `src/extension.ts`: detect "first run" condition (no workspace YAML, no user YAML, no `aidev.provider` setting set to a non-default value). When true, post a new `firstRunWelcome` message to the webview.
- Bundle the example files into the extension. They already live at `examples/*.yaml` and `.vscodeignore` includes them — I need to add them to the bundle by making sure they're NOT excluded. Alternatively, inline them as TS constants like I did for built-in skills (`src/skills/built-in.ts`). **Recommendation**: inline them via a new `src/config/sample-configs.ts` module so the extension ships self-contained without depending on external file resolution.
- `src/ui/messages.ts`: add `firstRunWelcomeMessage` (ext→webview) and `firstRunSelectRequest` (webview→ext, carrying the chosen template id).
- `src/ui/chat-view-provider.ts`: when `firstRunSelectRequest` arrives, write the chosen template into `<workspace>/.aidev/config.yaml`, open it in an editor, and clear the onboarding view.
- `webview-ui/dist/main.js`: render the onboarding panel instead of the default empty-state when `firstRunWelcome` is received. Handle the radio-button picker and the Create/Skip buttons.

### Edge cases

- User picks Cloud: Claude → we still write the YAML but immediately prompt for the API key via the existing `AIDev: Set API Key` command
- User hits Skip → show the regular empty-state, never show the onboarding again this session, and set a `aidev.onboardingDismissed: true` key in VS Code global state
- Workspace already has a config → onboarding never shows
- User has a user-level `~/.aidev/config.yaml` but no workspace config → onboarding does not show; the user-level config is enough

### Test plan

- `sample-configs` module: one test per template that it parses cleanly via the existing `ConfigLoader`
- `ChatViewProvider` tests: `firstRunSelectRequest` writes the expected file and opens it
- Onboarding detection logic tests: first-run when conditions X, not-first-run when conditions Y
- Integration: onboarding → select → config written → watcher fires → provider loads

**Effort**: ~1 day

---

## Feature 3 — Mode switcher relocated below input (Cursor layout)

**Problem**: Mode switcher is at the top of the panel, far from the Send button. Cognitively expensive: "what mode am I in" requires looking at the top while you're typing at the bottom.

**Solution**: Move the mode dropdown to a new **bottom bar** that sits below the input area, alongside a model selector and the Send button. Remove it from the top toolbar.

### New bottom bar layout

```
┌────────────────────────────────────────┐
│ [Agent ▾]  [qwen2.5-coder:14b ▾]   [Cancel] [↵ Send]
└────────────────────────────────────────┘
```

- **Mode dropdown** (left): agent / ask / manual / plan / composer — same 5 modes as today
- **Model dropdown** (middle-left): shows the active provider and model name. Clicking opens a picker listing the models defined in `providers:` from the YAML config. Selecting one fires `setModel` (new message) which the extension translates to a config edit
- **Cancel / Send buttons** (right): same as today

The top header only shows: the "AIDev" label, the **active model summary** (read-only small text), and the three icon buttons from Feature 1. No more mode dropdown at the top.

### Implementation

- `webview-ui/dist/main.js`:
  - Remove `modeSelect` from `toolbar`
  - Add new `bottomBar` element appended after the textarea inside `inputArea`
  - Move `modeSelect` into `bottomBar`
  - Add a new `modelSelect` populated from the configured providers
  - Move `cancelBtn` and `sendBtn` from `actions` into `bottomBar` (replace the current `actions` div)
- `webview-ui/dist/main.css`:
  - `.bottom-bar { display: flex; align-items: center; gap: 8px; margin-top: 6px; }`
  - `.bottom-bar .spacer { flex: 1; }` to push Cancel/Send to the right
- `src/ui/messages.ts`: new `setModelRequest` (webview→ext) carrying the new model id + provider
- `src/ui/chat-view-provider.ts`: handle `setModelRequest` by firing a VS Code command that edits `.aidev/config.yaml` (write the new `providers.<name>.model` value in place)
- `src/extension.ts`: register `aidev.setActiveModel` command

### Test plan

- Message protocol tests for `setModelRequest`
- ChatViewProvider tests: `setModelRequest` triggers the `aidev.setActiveModel` command
- Integration: changing the model in the webview writes the YAML and the file watcher reloads the provider

**Effort**: ~1 day (most of the work is getting the model picker populated correctly)

---

## Feature 4 — Model indicator in chat header

**Problem**: Users can't tell at a glance which model they're talking to. They have to look at the status bar in the bottom-right of VS Code.

**Solution**: Show the active provider + model as a small grey line in the chat header, updated whenever the provider reloads.

```
┌──────────────────────────────────────┐
│  AIDev  ·  ollama:qwen2.5-coder:14b  │  ← this line
│                      [+] [⚙] [?]    │
├──────────────────────────────────────┤
```

### Implementation

- `src/ui/messages.ts`: extend the existing `ready` message to carry `providerName` and `modelName`, OR add a dedicated `providerStatus` message (preferred — cleaner separation, and provider can change without a new ready handshake)
- `src/extension.ts`: in `loadProvider()`, after successfully instantiating a new provider, post `providerStatus` to the webview with the names
- `webview-ui/dist/main.js`: render the model name in the header. Update on `providerStatus`
- On error: show "AIDev · provider not configured" in red with a link to Settings

### Test plan

- Message protocol tests for `providerStatus`
- ChatViewProvider integration: a provider reload triggers a `providerStatus` post

**Effort**: ~2 hours

---

## Feature 5 — Message actions (copy, retry)

**Problem**: No way to copy a past response without selecting text. No way to retry a failed response without typing the same prompt again.

**Solution**: Small icon buttons on each message bubble:
- **📋 Copy**: copies the message text to clipboard (webview uses `navigator.clipboard.writeText` — allowed in webviews)
- **↻ Retry**: only on user messages, re-sends the same text as a new message (dropping any subsequent assistant turns)

### Implementation

- `webview-ui/dist/main.js`: add a `.message-actions` div to each `.message` element. Two buttons, initially hidden, revealed on `:hover` via CSS
- `webview-ui/dist/main.css`: `.message .message-actions { display: none; } .message:hover .message-actions { display: flex; }`
- Retry: on click, take the user message's text and send a new `userMessage` request. The agent controller sees it as a fresh message (doesn't know it's a retry). No special handling needed on the extension side.

### Test plan

- No new extension-side code → no new unit tests
- Manual QA: hover a message, click copy, verify clipboard; click retry, verify a new exchange starts

**Effort**: ~2 hours

---

## Feature 6 — Attach-file button (scaffold)

**Problem**: Webview doesn't accept file uploads. Image input is a documented gap in `GAP_ANALYSIS.md` (#18).

**Solution**: Add a paperclip icon to the left of the textarea. Clicking opens a native file picker. Selected files are read into base64 and posted as a new `attachFile` message. The extension-side handler passes them to the existing `FileUploadService` which was built in Phase 7 and never wired.

This is a **scaffold** — the actual handling of image content blocks in the LLM message is a separate larger feature (Round 4 in `PLAN_ROADMAP_V2.md`). This item just gets the button in the UI and plumbs the file bytes through to the existing service.

### Implementation

- `webview-ui/dist/main.js`: add the paperclip button. On click, create a hidden `<input type="file">` and trigger it. On file select, read via FileReader, post `attachFile` with filename, mimeType, base64 content
- `src/ui/messages.ts`: `attachFileRequest` type with the 3 fields
- `src/ui/chat-view-provider.ts`: handle `attachFileRequest` by calling `FileUploadService.processFile()` (already exists, already tested). Store the processed result in a per-session attachment list. On the next `userMessage`, append the attachments as resolved context (reusing the same `# Referenced context` section already used by `@-symbol` resolution)

### Test plan

- Message protocol tests
- ChatViewProvider tests: an `attachFileRequest` calls `FileUploadService.processFile()` and stores the result; the next user message includes the file content in the enriched text

**Effort**: ~half a day

---

## Feature 7 — Scroll-to-bottom affordance during streaming

**Problem**: During a long streaming response, if the user scrolls up to read an earlier message, the chat keeps auto-scrolling to the bottom and fights them.

**Solution**:
- Track whether the user has scrolled up during streaming
- When they scroll up, stop auto-scrolling
- Show a floating "↓ new messages" pill near the bottom right of the message area
- Clicking the pill jumps to the bottom and re-enables auto-scroll

### Implementation

- `webview-ui/dist/main.js`: add a scroll event listener on `messagesContainer`. Track `isScrollAtBottom` by comparing `scrollTop + clientHeight >= scrollHeight - threshold`. When it becomes false during streaming, show the pill; when the user clicks the pill or scrolls back to the bottom, hide it and resume auto-scrolling
- `webview-ui/dist/main.css`: floating pill positioned with `position: absolute; bottom: 12px; right: 12px;` inside the `.messages` container (which needs `position: relative`)

### Test plan

- No extension-side logic → no new unit tests
- Manual QA: stream a long response, scroll up, confirm the pill appears and clicking it works

**Effort**: ~2 hours

---

## Cross-cutting: message protocol additions

Summary of every new webview-to-extension message and extension-to-webview message across the 7 features:

| Direction | New message type | Feature |
|---|---|---|
| webview → ext | `openSettingsRequest` | 1 |
| webview → ext | `showHelpRequest` | 1 |
| ext → webview | `firstRunWelcome` | 2 |
| webview → ext | `firstRunSelectRequest` | 2 |
| webview → ext | `setModelRequest` | 3 |
| ext → webview | `providerStatus` | 4 |
| webview → ext | `attachFileRequest` | 6 |

All 7 types need: a TypeScript interface, a factory helper (for the ext→webview ones), a type guard (for the webview→ext ones), and a unit test for the factory + guard. That's ~20 new unit tests in `test/unit/ui/messages.test.ts`.

---

## Phased rollout

### Phase A — layout restructure (v0.2.1)

Items 1, 3, 4: settings button, mode-switcher-below, model indicator. These are all structural layout changes and benefit from being shipped together so the user sees one coherent UI update rather than drip-feed refinements.

**Tests**: message protocol tests + ChatViewProvider handler tests  
**Effort**: ~1.5 days

### Phase B — onboarding (v0.2.2)

Item 2: first-run config picker. Requires the inlined sample-configs module, the onboarding webview panel, and the selection handler.

**Tests**: sample config parse tests, detection logic tests, selection handler tests  
**Effort**: ~1 day

### Phase C — polish (v0.2.3)

Items 5, 6, 7: message actions, attach-file button, scroll-to-bottom pill. Small UX refinements that don't depend on each other; ship when ready.

**Tests**: message protocol + FileUploadService wiring test  
**Effort**: ~1 day

Total: ~3.5 days of focused work for the full v0.2 chat UI refresh.

---

## Open questions

1. **Codicons in webviews**: the VS Code codicon font is exposed to webviews via a specific CSS import. Should the webview bundle its own copy (adds ~50KB), or load from `vscode-webview://` (smaller but one more thing that can break)? **Recommendation**: bundle a subset (just the 10 icons we need: plus, gear, question, paperclip, copy, retry, send, stop, arrow-down, model). ~8KB.

2. **Model dropdown source**: should it list every model defined under `providers:` in the current config, or also offer to pull a new Ollama model on the fly? **Recommendation**: v0.2 lists configured models only. Pulling new models is a v0.3+ feature — requires an Ollama `/api/pull` wrapper and a progress indicator.

3. **Onboarding persistence**: when the user hits Skip, should the onboarding come back on the next window reload or never again? **Recommendation**: never again per-workspace. Store a `aidev.onboardingDismissed` key in `context.globalState`. Re-surface if the user runs a new `AIDev: Show Onboarding` command.

4. **Setting model via YAML rewrite vs in-memory**: when the user picks a new model from the dropdown, do we edit `.aidev/config.yaml` on disk or just update the in-memory provider? **Recommendation**: edit the file. This way the user sees their change persisted, can undo it, and the file-watcher hot-reload keeps everything consistent.

5. **Message-level retry semantics**: clicking retry on a user message — should it delete everything after that point in the history, or just send a new parallel message? **Recommendation**: delete. Retry means "I wanted a different answer to this question". The old answer should go away to avoid confusion.

---

## Success criteria

When the v0.2 chat UI refresh ships:
- A first-time user with no config can open the AIDev panel, pick a local template, and send their first message without ever touching JSON or reading docs
- The mode switcher is visible where the user's attention is (near the input)
- The active model is visible at a glance in the chat header
- The settings button is discoverable in the chat header, not hidden in the status bar
- Users can retry a previous message with one click
- File attachment scaffolding is in place so the image-input feature can land incrementally in v0.3+
- Test count grows by ~30 (message protocol additions + handler wiring tests)
- No regressions in the existing 442 tests

## Out of scope (deferred)

These pair naturally but are bigger lifts and belong in later releases:

- **Full image input pipeline**: webview attaches image → extension forwards as `image` content block → provider serializes as base64 → Claude/Gemini/GPT-4o multimodal. Feature 6 is just the scaffold; the actual multimodal round-trip is a ~2 day separate item.
- **Token counter / cost estimator**: nice-to-have, deferred to v0.3
- **Voice input**: deferred indefinitely (see `PLAN_ROADMAP_V2.md`)
- **Custom themes**: VS Code already themes us; don't add complexity
