# IMPL: Chat UI v2 — Phase-wise Implementation Guide

Status: **active implementation** as of v0.2.0.

Companion to [`PLAN_CHAT_UI_V2.md`](PLAN_CHAT_UI_V2.md). The plan doc covers *what* and *why*; this doc covers *how*, with diagrams, sequence flows, and concrete file lists per phase. Read both before touching the code.

---

## Top-level architecture

```
                  ┌──────────────────────────────────────────┐
                  │  Extension Host (Node.js, src/)          │
                  │                                          │
                  │  ┌─────────────────┐  ┌────────────────┐ │
                  │  │ extension.ts    │  │ ProviderFactory│ │
                  │  │  · activate()   │──│ ConfigLoader   │ │
                  │  │  · loadProvider │  │ ProviderRegistry│ │
                  │  │  · commands     │  └────────────────┘ │
                  │  └────────┬────────┘                     │
                  │           │                              │
                  │  ┌────────┴────────┐  ┌────────────────┐ │
                  │  │ ChatViewProvider│──│ AgentController│ │
                  │  │  · routes msgs  │  │ ToolRegistry   │ │
                  │  │  · onMessage    │  │ SkillRegistry  │ │
                  │  │  · postMessage  │  └────────────────┘ │
                  │  └────────┬────────┘                     │
                  └───────────┼──────────────────────────────┘
                              │  postMessage / onDidReceiveMessage
                              │  (JSON-serialized discriminated unions)
                  ┌───────────┴──────────────────────────────┐
                  │  Webview (sandboxed iframe, vanilla JS)  │
                  │                                          │
                  │  ┌────────────────────────────────────┐  │
                  │  │ Top Header                          │  │
                  │  │  · "Champ · model" indicator        │  │
                  │  │  · [+] [⚙] [?] icon buttons         │  │
                  │  ├────────────────────────────────────┤  │
                  │  │ Messages list                       │  │
                  │  │  · streamed deltas                  │  │
                  │  │  · tool call cards                  │  │
                  │  │  · per-message [📋][↻] (Phase C)    │  │
                  │  ├────────────────────────────────────┤  │
                  │  │ Input area                          │  │
                  │  │  · slash autocomplete dropdown      │  │
                  │  │  · [📎] textarea (📎 in Phase C)    │  │
                  │  │  ── Bottom bar ──                   │  │
                  │  │  [Mode ▾] [Model ▾]    [✕][Send]    │  │
                  │  └────────────────────────────────────┘  │
                  └──────────────────────────────────────────┘
```

The host and webview only communicate through typed messages defined in `src/ui/messages.ts`. Every message has a `type` discriminator, a factory helper (for ext→webview), and a type guard (for webview→ext). Tests live in `test/unit/ui/messages.test.ts`.

---

## Phase A — Layout restructure (settings + mode-below + model indicator)

**Targets**: v0.2.0  
**Effort**: ~1.5 days  
**Items addressed**: §1, §3, §4 from `PLAN_CHAT_UI_V2.md`

### Goals

1. **Three icon buttons** in the top header: new chat (`+`), settings (`⚙`), help (`?`)
2. **Mode dropdown moved** from the top toolbar to a new bottom bar below the textarea
3. **Active model indicator** shown as a subtitle under the "Champ" label in the top header
4. **Model dropdown** in the bottom bar listing every model defined in the YAML config
5. **Send/Cancel buttons** moved into the bottom bar alongside Mode and Model

### Files added / modified

| File | Action | Lines (approx) |
|---|---|---|
| `src/ui/messages.ts` | + 4 message types, 4 factories/guards | +70 |
| `src/ui/chat-view-provider.ts` | + 3 webview handlers + providerStatus broadcast | +90 |
| `src/extension.ts` | + 2 commands, providerStatus emission, YAML rewrite helper | +110 |
| `webview-ui/dist/main.js` | restructured layout: top header + bottom bar | ±150 |
| `webview-ui/dist/main.css` | new selectors for header icons, bottom bar | +100 |
| `package.json` | + 2 contribute commands, version bump | +10 |
| `test/unit/ui/messages.test.ts` | + 8 tests | +120 |
| `test/unit/ui/chat-view-provider.test.ts` | + 6 tests | +180 |

Total: roughly **830 lines added/changed**, **14 new unit tests**.

### New message protocol additions

```typescript
// Extension → Webview
interface ProviderStatusMessage {
  type: "providerStatus";
  state: "loading" | "ready" | "error";
  providerName?: string;     // e.g. "ollama"
  modelName?: string;        // e.g. "qwen2.5-coder:14b"
  errorMessage?: string;     // when state === "error"
  /** Every provider+model combination defined in the YAML config. */
  available: Array<{
    providerName: string;
    modelName: string;
    label: string;           // user-visible "ollama: qwen2.5-coder:14b"
  }>;
}

// Webview → Extension
interface OpenSettingsRequest { type: "openSettingsRequest"; }
interface ShowHelpRequest      { type: "showHelpRequest"; }
interface SetModelRequest      { type: "setModelRequest"; providerName: string; }
```

### Sequence diagram — opening settings from the chat

```
User              Webview                  ChatViewProvider          VS Code
 │                  │                            │                     │
 │ click [⚙]       │                            │                     │
 ├─────────────────►│                            │                     │
 │                  │ postMessage                │                     │
 │                  │   {type:"openSettingsReq"} │                     │
 │                  ├───────────────────────────►│                     │
 │                  │                            │ executeCommand      │
 │                  │                            │   "workbench.action │
 │                  │                            │    .openSettings",  │
 │                  │                            │   "champ"           │
 │                  │                            ├────────────────────►│
 │                  │                            │                     │ Settings
 │                  │                            │                     │ tab opens
 │                  │                            │                     │ filtered
 │                  │                            │                     │ to champ.*
```

### Sequence diagram — provider status broadcast on activation

```
extension.ts                ChatViewProvider             Webview
     │                            │                        │
     │ activate()                 │                        │
     ├──┐                         │                        │
     │  │ resolveConfig()         │                        │
     │  │ (reads .champ/...yaml)  │                        │
     │◄─┘                         │                        │
     │                            │                        │
     │ post providerStatus        │                        │
     │   {state: "loading"}       │                        │
     ├───────────────────────────►│                        │
     │                            ├───────────────────────►│
     │                            │                        │ render
     │                            │                        │ "loading…"
     │                            │                        │ in header
     │                            │                        │
     │ loadProvider()             │                        │
     ├──┐                         │                        │
     │  │ factory.createFrom...   │                        │
     │◄─┘                         │                        │
     │                            │                        │
     │ post providerStatus        │                        │
     │   {state: "ready",         │                        │
     │    providerName, model,    │                        │
     │    available: [...]}       │                        │
     ├───────────────────────────►│                        │
     │                            ├───────────────────────►│
     │                            │                        │ "Champ ·
     │                            │                        │  ollama:
     │                            │                        │  qwen2.5-…"
     │                            │                        │ in header
     │                            │                        │ + populate
     │                            │                        │ model dropdown
```

### Sequence diagram — switching the active model from the dropdown

```
User       Webview            ChatViewProvider     extension.ts          File system
 │            │                       │                  │                    │
 │ pick a    │                       │                  │                    │
 │ different │                       │                  │                    │
 │ model      │                       │                  │                    │
 ├───────────►│                       │                  │                    │
 │            │ postMessage           │                  │                    │
 │            │  {type:"setModelReq", │                  │                    │
 │            │   providerName:"vllm"}│                  │                    │
 │            ├──────────────────────►│                  │                    │
 │            │                       │ executeCommand   │                    │
 │            │                       │  "champ.set      │                    │
 │            │                       │   ActiveModel"   │                    │
 │            │                       ├─────────────────►│                    │
 │            │                       │                  │ readFile           │
 │            │                       │                  │ .champ/config.yaml │
 │            │                       │                  ├───────────────────►│
 │            │                       │                  │◄───────────────────┤
 │            │                       │                  │                    │
 │            │                       │                  │ regex replace      │
 │            │                       │                  │ "^provider:" line  │
 │            │                       │                  │                    │
 │            │                       │                  │ writeFile          │
 │            │                       │                  ├───────────────────►│
 │            │                       │                  │                    │
 │            │                       │                  │ ◄── file watcher fires ─┐
 │            │                       │                  │                         │
 │            │                       │                  │ loadProvider() (again)  │
 │            │                       │                  ├──┐                      │
 │            │                       │                  │  │                      │
 │            │                       │                  │◄─┘                      │
 │            │                       │                  │                         │
 │            │                       │                  │ post providerStatus     │
 │            │                       │                  │   {state:"ready",       │
 │            │                       │                  │    providerName:"vllm"} │
 │            │                       │                  ├────────────────────────►│ChatVw
 │            │                       │◄────────────────────────────────────────────┤
 │            │◄──────────────────────│                  │                         │
 │            │ update header label   │                  │                         │
 │            │ + dropdown highlight  │                  │                         │
```

### YAML rewrite helper

The new `setActiveProvider` helper does a **single-line surgical regex replacement**, not a full parse-modify-serialize. This preserves all comments and formatting in the user's YAML — only the value of the top-level `provider:` key changes.

```typescript
/**
 * Replace the value of the top-level `provider:` key in a YAML
 * document. Preserves all comments, indentation, and other lines.
 *
 * Returns the modified text. If no top-level `provider:` line exists,
 * returns the original text unchanged.
 */
function setActiveProviderInYaml(yamlText: string, newProvider: string): string {
  return yamlText.replace(
    /^provider:[^\n]*$/m,
    `provider: ${newProvider}`,
  );
}
```

The `^...$` with `/m` flag pins the match to a line at the top level (no leading whitespace, so it won't accidentally match an indented `provider:` inside `providers:`).

### Configuration touched by Phase A

The model selection writes back to the active workspace YAML. Example before/after:

```yaml
# .champ/config.yaml — BEFORE the user picks a different model

provider: ollama          # ← this line gets rewritten

providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:14b
  vllm:
    baseUrl: http://localhost:8000/v1
    model: meta-llama/Llama-3.1-8B
```

```yaml
# .champ/config.yaml — AFTER picking "vllm: meta-llama/Llama-3.1-8B"

provider: vllm            # ← only this line changes

providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:14b
  vllm:
    baseUrl: http://localhost:8000/v1
    model: meta-llama/Llama-3.1-8B
```

Comments, indentation, and the rest of the file are preserved. The file watcher hot-reloads `loadProvider()` automatically.

### Test plan

```
test/unit/ui/messages.test.ts (+8)
  ✓ creates a providerStatus message
  ✓ providerStatus carries provider+model+available list
  ✓ creates an openSettingsRequest factory
  ✓ identifies an openSettingsRequest from the webview
  ✓ creates a showHelpRequest
  ✓ identifies a showHelpRequest
  ✓ creates a setModelRequest with providerName
  ✓ identifies a setModelRequest

test/unit/ui/chat-view-provider.test.ts (+6)
  ✓ openSettingsRequest fires the "workbench.action.openSettings" command
  ✓ showHelpRequest fires the champ.showHelp command
  ✓ setModelRequest fires champ.setActiveModel with the providerName
  ✓ broadcastProviderStatus posts the message to the webview
  ✓ broadcastProviderStatus includes the available models list
  ✓ broadcastProviderStatus state="error" includes errorMessage
```

### Acceptance criteria for Phase A

When Phase A ships as v0.2.0:

- [ ] Top header shows `Champ · <provider>:<model>` (or "loading…" / "error" states)
- [ ] Top header has 3 icon buttons: `+` (new chat), `⚙` (settings), `?` (help)
- [ ] Clicking `⚙` opens VS Code Settings filtered to `champ.*`
- [ ] Clicking `?` opens `docs/USER_GUIDE.md` in an editor tab
- [ ] Clicking `+` resets the conversation
- [ ] Mode dropdown is in the bottom bar (no longer in the top toolbar)
- [ ] Model dropdown is in the bottom bar, listing every configured `provider:model` combo
- [ ] Picking a different provider+model rewrites the YAML's `provider:` line and the file watcher reloads
- [ ] Send / Cancel buttons are in the bottom bar
- [ ] All previous tests still pass (442 baseline)
- [ ] +14 new tests pass (target: 456)
- [ ] TypeScript clean, ESLint clean, build clean

---

## Phase B — Onboarding config picker

**Targets**: v0.2.1  
**Effort**: ~1 day  
**Items addressed**: §2 from `PLAN_CHAT_UI_V2.md`

### Goals

1. Detect "first-run" condition: no workspace YAML, no user YAML, no `champ.provider` in settings
2. Show an in-chat onboarding panel with **5 starter templates** (Ollama / llama.cpp / vLLM / Claude / cloud+local hybrid)
3. On selection, write the chosen template to `<workspace>/.champ/config.yaml` and open it in an editor
4. On dismiss, set a `champ.onboardingDismissed` flag in `globalState` so it doesn't reappear
5. New `Champ: Show Onboarding` command to bring it back manually

### Architecture

```
extension.ts                                    Webview
   │                                                │
   │ if (firstRunCondition):                        │
   │   post {type:"firstRunWelcome",                │
   │         templates: [...inlined from            │
   │         src/config/sample-configs.ts]}         │
   ├───────────────────────────────────────────────►│
   │                                                │
   │                                                │ render
   │                                                │ onboarding
   │                                                │ panel with
   │                                                │ 5 radio
   │                                                │ buttons
   │                                                │
   │                                                │ user picks
   │                                                │ "ollama-basic"
   │                                                │ then clicks
   │                                                │ "Create"
   │                                                │
   │                  postMessage                   │
   │                  {type:"firstRunSelectReq",    │
   │                   templateId:"ollama-basic"}   │
   │◄───────────────────────────────────────────────┤
   │                                                │
   │ writeFile .champ/config.yaml ←── content from  │
   │   src/config/sample-configs.ts                 │
   │                                                │
   │ open .champ/config.yaml in editor              │
   │                                                │
   │ ── file watcher fires ──                       │
   │                                                │
   │ loadProvider() (now succeeds)                  │
   │                                                │
   │ post providerStatus                            │
   │   {state:"ready", ...}                         │
   ├───────────────────────────────────────────────►│
   │                                                │
   │                                                │ replace
   │                                                │ onboarding
   │                                                │ with
   │                                                │ regular chat
```

### New module: `src/config/sample-configs.ts`

Inlines the 5 templates from `examples/` as TS constants so the extension is self-contained.

```typescript
export interface SampleConfig {
  id: string;            // "ollama-basic"
  label: string;         // "Local: Ollama (recommended)"
  description: string;   // "Privacy-first, no API key. Uses qwen2.5-coder:7b."
  yaml: string;          // the inlined YAML content
}

export const SAMPLE_CONFIGS: ReadonlyArray<SampleConfig> = [
  { id: "ollama-basic", label: "Local: Ollama", description: "...", yaml: `...` },
  { id: "llamacpp",     label: "Local: llama.cpp", description: "...", yaml: `...` },
  { id: "vllm-basic",   label: "Local: vLLM", description: "...", yaml: `...` },
  { id: "claude",       label: "Cloud: Claude", description: "...", yaml: `...` },
  { id: "cloud-hybrid", label: "Cloud + local autocomplete", description: "...", yaml: `...` },
];
```

### Configuration written by Phase B

When the user picks "Local: Ollama (recommended)", Champ writes this to `<workspace>/.champ/config.yaml`:

```yaml
# Champ — basic Ollama configuration (created by onboarding)
# See examples/ in the Champ repo for more templates.

provider: ollama

providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:7b-instruct

agent:
  defaultMode: agent
  yoloMode: false
  autoFix:
    enabled: true
    maxIterations: 3

autocomplete:
  enabled: true
  debounceMs: 300
```

The file is opened in an editor immediately so the user sees what was created and can edit any value before they start chatting.

### Test plan

```
test/unit/config/sample-configs.test.ts (new, +6)
  ✓ ships exactly 5 sample configs
  ✓ every sample has id, label, description, yaml
  ✓ every yaml parses cleanly via ConfigLoader
  ✓ every yaml resolves to a valid active provider config
  ✓ ollama-basic uses Ollama
  ✓ cloud-hybrid uses claude as chat + ollama as autocomplete

test/unit/ui/messages.test.ts (+4)
  ✓ creates firstRunWelcome with templates list
  ✓ identifies firstRunSelectRequest with templateId

test/unit/ui/chat-view-provider.test.ts (+4)
  ✓ firstRunSelectRequest writes the chosen template to disk
  ✓ firstRunSelectRequest opens the written file in an editor
  ✓ firstRunSelectRequest is a no-op for unknown templateId
  ✓ broadcastFirstRunWelcome only fires when no config exists
```

### Acceptance criteria for Phase B

- [ ] Fresh install + open Champ panel + no config → onboarding panel appears
- [ ] Picker shows 5 templates with descriptions
- [ ] Picking one writes `.champ/config.yaml` with the template content
- [ ] Picked file opens in an editor automatically
- [ ] File watcher reloads the provider; chat panel switches from onboarding to ready state
- [ ] Skip button dismisses the panel and sets `champ.onboardingDismissed`
- [ ] `Champ: Show Onboarding` command brings the panel back
- [ ] +14 new tests pass

---

## Phase C — Polish (message actions, attach button, scroll pill)

**Targets**: v0.2.2  
**Effort**: ~1 day  
**Items addressed**: §5, §6, §7 from `PLAN_CHAT_UI_V2.md`

### Goals

1. **Message actions**: hover any message bubble to reveal `[📋 Copy] [↻ Retry]`
2. **Attach button**: paperclip left of textarea opens native file picker, posts file bytes through to `FileUploadService`
3. **Scroll pill**: floating "↓ new messages" affordance during streaming when the user has scrolled up

### Architecture (attach button)

```
User      Webview            ChatViewProvider         FileUploadService
 │           │                       │                       │
 │ click 📎 │                       │                       │
 ├──────────►│                       │                       │
 │           │ trigger hidden        │                       │
 │           │ <input type="file">   │                       │
 │           │                       │                       │
 │ pick      │                       │                       │
 │ file       │                       │                       │
 ├──────────►│                       │                       │
 │           │ FileReader →          │                       │
 │           │ base64                │                       │
 │           │                       │                       │
 │           │ postMessage           │                       │
 │           │  {type:"attachFile",  │                       │
 │           │   filename, mime,     │                       │
 │           │   contentBase64}      │                       │
 │           ├──────────────────────►│                       │
 │           │                       │ processFile({         │
 │           │                       │   name, content:      │
 │           │                       │   Buffer.from(b64),   │
 │           │                       │   mimeType            │
 │           │                       │ })                    │
 │           │                       ├──────────────────────►│
 │           │                       │◄──── ProcessResult ───┤
 │           │                       │                       │
 │           │                       │ store in              │
 │           │                       │ pendingAttachments    │
 │           │                       │ map                   │
 │           │                       │                       │
 │           │ post {type:"attachOk",│                       │
 │           │        filename}      │                       │
 │           │◄──────────────────────┤                       │
 │           │                       │                       │
 │           │ render attachment     │                       │
 │           │ chip above textarea   │                       │
 │           │                       │                       │
 │           │                       │                       │
 │           │ user sends a message  │                       │
 │           │                       │                       │
 │           │ postMessage           │                       │
 │           │  {type:"userMessage", │                       │
 │           │   text:"..."}         │                       │
 │           ├──────────────────────►│                       │
 │           │                       │ enrichedText =        │
 │           │                       │ text +                │
 │           │                       │ pendingAttachments    │
 │           │                       │ as `# Attached files` │
 │           │                       │ section               │
 │           │                       │                       │
 │           │                       │ agent.processMessage  │
 │           │                       │   (enrichedText)      │
 │           │                       │                       │
 │           │                       │ pendingAttachments    │
 │           │                       │ .clear()              │
```

This piggy-backs on the same "enriched text" pattern that `@-symbol` resolution and `expandSkill` already use. No new agent-controller plumbing needed for Phase C — that's a Phase D item if you want true multimodal `image` content blocks.

### Test plan summary

| Test file | New tests | What |
|---|---|---|
| `test/unit/ui/messages.test.ts` | +4 | attachFileRequest factory + guard |
| `test/unit/ui/chat-view-provider.test.ts` | +6 | attach handler invokes FileUploadService; pendingAttachments cleared after send; copy/retry don't need extension-side tests (pure webview) |

Total Phase C: ~10 new tests.

### Acceptance criteria for Phase C

- [ ] Hover a user message → copy + retry icons appear
- [ ] Click copy → message text in clipboard
- [ ] Click retry → message resent, history truncated to that point
- [ ] Click 📎 → file picker opens
- [ ] Pick a `.txt` or `.md` → chip appears above textarea
- [ ] Send a message → next agent turn includes the file content
- [ ] Stream a long response, scroll up → pill appears
- [ ] Click pill → jumps to bottom + resumes auto-scroll
- [ ] +10 new tests pass

---

## Cross-cutting: success criteria for the full Chat UI v2

When all three phases ship (target: v0.2.2):

| Metric | v0.1.6 baseline | v0.2.2 target |
|---|---|---|
| Tests passing | 442 | ≥480 |
| Test files | 50 | ≥53 |
| TypeScript errors | 0 | 0 |
| ESLint warnings | 0 | 0 |
| `dist/extension.js` size | 678 KB | ≤720 KB |
| Webview bundle size | 18 KB | ≤30 KB |
| `.vsix` package size | 342 KB | ≤380 KB |
| GAP_ANALYSIS.md score | 12/22 | 13/22 (image input scaffold lands) |
| Direct user-feedback items addressed | 0 | 3 (settings button, sample config, mode-below) |

---

## Why phase boundaries are where they are

- **Phase A is the layout fix** — touching every part of the chat UI at once. It's atomic; you can't half-move the mode dropdown. Better to land it as one coherent visual change than drip-feed three small changes that each break the layout temporarily.
- **Phase B is the onboarding fix** — independent of A. Could ship before A in principle, but A is a smaller more contained change so it goes first to build momentum.
- **Phase C is polish** — message actions, attach button, scroll pill are independent of each other and of A/B. Could ship in any order.

Each phase ends with a working, shippable, tested release. Nothing is left half-implemented across a phase boundary.

---

## What this doc is NOT

- Not a substitute for `PLAN_CHAT_UI_V2.md` (the why and tradeoffs)
- Not a design discussion — design decisions are settled, this is execution-only
- Not a test-by-test write-up — only the test names and counts; the actual TDD flow is "write the failing test, watch it fail, implement, watch it pass" in tight cycles

Read `PLAN_CHAT_UI_V2.md` first for context, then use this doc as the implementation reference while writing the code.
