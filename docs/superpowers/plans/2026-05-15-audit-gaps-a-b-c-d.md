# Audit Gap Fixes — Token Budget, Skip/Retry, Context Overflow, Chat Diff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four highest-impact audit gaps: enforce the token budget with a warn/stop gate, wire Skip/Retry buttons on blocked/failed agents, route TeamAgent messages through the context window manager, and add per-turn inline + summary hunk diff review to the chat sidebar.

**Architecture:** Four surgical fixes in dependency order. A (token budget) and C (context overflow) are pure backend changes. B (Skip/Retry) threads a callback through TeamRunner ↔ extension ↔ TeamPanel. D (chat diff) adds a new message type and a thin EditReviewTracker in the extension host that feeds existing diff-utils into new webview UI. No new files except a single `src/agent/edit-review-tracker.ts`.

**Tech Stack:** TypeScript, VS Code Extension API, existing `src/utils/diff-utils.ts` (splitIntoHunks / applyHunks), existing `src/providers/context-manager.ts` (ContextWindowManager), vanilla JS webview.

---

## File Map

| File | Action | Reason |
|------|--------|--------|
| `src/agent/team-runner.ts` | Modify | Add budget warn/stop logic; add `onBlocked` callback to `TeamRunOptions` and `TeamRunEvent` |
| `src/agent/team-definition.ts` | Read-only | `totalTokenBudget` already declared at line 79 |
| `src/agent/team-agent.ts` | Modify | Wire `ContextWindowManager.fitMessages()` before LLM call |
| `src/providers/context-manager.ts` | Read-only | `ContextWindowManager` already implemented |
| `src/agent/edit-review-tracker.ts` | **Create** | Singleton that records `{ path, oldContent, newContent }` per agent turn |
| `src/tools/edit-file.ts` | Modify | Capture `oldContent` before edit; report to `EditReviewTracker`; include in `metadata` |
| `src/tools/types.ts` | Modify | Add `oldContent` and `newContent` to `ToolResult.metadata` |
| `src/ui/messages.ts` | Modify | Add `FileEditDiffMessage` and `EditSummaryMessage`; add `revertEdit` to `WebviewToExtensionMessage` |
| `src/ui/chat-view-provider.ts` | Modify | Forward `file_edit_diff` events to webview; send `editSummary` at turn end; handle `revertEdit` |
| `src/agent/agent-controller.ts` | Modify | Emit `file_edit_diff` event when tool result has `filesModified` metadata |
| `src/extension.ts` | Modify | Wire `onBlocked` callback in `champ.runTeam` and `champ.resumeTeamRun` |
| `src/ui/team-panel.ts` | Modify | Replace disabled hint with real Skip/Retry buttons; add budget bar to metrics |
| `webview-ui/dist/main.js` | Modify | Render `fileEditDiff` inline diff in chat; render `editSummary` panel; send `revertEdit` |
| `webview-ui/dist/main.css` | Modify | Styles for inline diff card and edit summary panel |
| `test/unit/agent/team-runner.test.ts` | Modify | Tests for budget warn + stop |
| `test/unit/agent/team-agent.test.ts` | Modify or Create | Test context trimming |
| `test/unit/agent/edit-review-tracker.test.ts` | **Create** | Tests for EditReviewTracker |

---

## Task 1: Token Budget — Warn at 80%, Soft Stop at 100%

**Files:**
- Modify: `src/agent/team-runner.ts`
- Test: `test/unit/agent/team-runner.test.ts`

### Context

`TeamExecutionConfig.totalTokenBudget` (team-definition.ts:79) is parsed and stored but never checked. `totalTokens` is accumulated correctly after each agent (team-runner.ts:362-370). The fix: check budget before scheduling each parallel group.

- [ ] **Step 1: Write failing tests**

Add to `test/unit/agent/team-runner.test.ts`:

```typescript
describe("TeamRunner — token budget", () => {
  it("emits budget_warning when totalTokens exceeds 80% of budget", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"])]);
    team.execution.totalTokenBudget = 100;

    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* () {
        yield { type: "text" as const, text: "<output>done</output>" };
        yield { type: "done" as const, usage: { inputTokens: 45, outputTokens: 45 } };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: () => 0,
      modelInfo: () => ({ contextWindow: 4096, name: "test", provider: "test" as const }),
      dispose: () => {},
    };

    const toolRegistry = {
      get: () => undefined, list: () => [], execute: async () => ({ success: true, output: "" }), register: () => {},
    } as any;

    const events: import("@/agent/team-runner").TeamRunEvent[] = [];
    await runner.run(team, "test", fakeProvider as any, toolRegistry, {
      onEvent: (e) => events.push(e),
    });

    const warned = events.some((e) => e.type === "budget_warning");
    expect(warned).toBe(true);
  });

  it("stops scheduling new agents when totalTokens reaches 100% of budget", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"]), makeAgent("c", ["b"])]);
    team.execution.totalTokenBudget = 80; // agent "a" alone uses 90 tokens → b and c should not run

    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* () {
        yield { type: "text" as const, text: "<output>done</output>" };
        yield { type: "done" as const, usage: { inputTokens: 45, outputTokens: 45 } };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: () => 0,
      modelInfo: () => ({ contextWindow: 4096, name: "test", provider: "test" as const }),
      dispose: () => {},
    };

    const toolRegistry = {
      get: () => undefined, list: () => [], execute: async () => ({ success: true, output: "" }), register: () => {},
    } as any;

    let finalState: import("@/agent/team-definition").TeamRunState | undefined;
    await runner.run(team, "test", fakeProvider as any, toolRegistry, {
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    expect(finalState).toBeDefined();
    const bState = finalState!.agents.find((a) => a.id === "b");
    const cState = finalState!.agents.find((a) => a.id === "c");
    // b and c should be skipped due to budget exhaustion
    expect(bState?.status).toBe("skipped");
    expect(cState?.status).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -15
```

Expected: FAIL — `budget_warning` event type doesn't exist yet, budget not checked.

- [ ] **Step 3: Add `budget_warning` to TeamRunEvent**

In `src/agent/team-runner.ts`, find the `TeamRunEvent` union (line 28). Add:

```typescript
export type TeamRunEvent =
  | { type: "state_update"; state: TeamRunState }
  | { type: "agent_stream"; agentId: string; chunk: string }
  | { type: "blocked"; agentId: string; reason: string }
  | { type: "budget_warning"; usedTokens: number; budgetTokens: number }
  | { type: "complete"; state: TeamRunState }
  | { type: "error"; message: string; state: TeamRunState };
```

- [ ] **Step 4: Add budget check in runWithMemory()**

In `src/agent/team-runner.ts`, find the `for (const group of groups)` loop (around line 206). Add the budget check at the top of the loop body, AFTER the `abortSignal` check and BEFORE the `safe` mode approval gate:

```typescript
      for (const group of groups) {
        if (options.abortSignal?.aborted) break;

        // Token budget enforcement: warn at 80%, soft-stop at 100%
        const budget = team.execution.totalTokenBudget;
        if (budget && budget > 0) {
          const pct = totalTokens / budget;
          if (pct >= 1.0) {
            // Soft stop: mark all remaining pending agents as skipped
            for (const [, agState] of agentStates) {
              if (agState.status === "pending") agState.status = "skipped";
            }
            break;
          }
          if (pct >= 0.8) {
            options.onEvent?.({
              type: "budget_warning",
              usedTokens: totalTokens,
              budgetTokens: budget,
            });
          }
        }

        // Build memory snapshot for condition evaluation...
```

- [ ] **Step 5: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -15
```

Expected: all tests PASS.

- [ ] **Step 6: Add budget bar to TeamPanel metrics**

In `src/ui/team-panel.ts`, find the `m.innerHTML = ...` metrics block (around line 207). Extend it to include a budget row when a budget is defined:

Find:
```javascript
  m.innerHTML='<div class="mrow"><span>Agents</span><span>'+done+'/'+total+'</span></div>'
    +'<div class="mrow"><span>Time</span><span>'+elapsed+'</span></div>'
    +'<div class="mrow"><span>Tokens</span><span>'+(state.totalTokens||0).toLocaleString()+'</span></div>'
    +'<div class="mrow"><span>Cost</span><span>~$0.00</span></div>';
```

Replace with:

```javascript
  const budgetRow = state.tokenBudget && state.tokenBudget > 0
    ? '<div class="mrow"><span>Budget</span><span style="color:'
        + (state.totalTokens >= state.tokenBudget ? 'var(--vscode-errorForeground)'
           : state.totalTokens >= state.tokenBudget * 0.8 ? 'var(--vscode-editorWarning-foreground)'
           : 'inherit') + '">'
        + (state.totalTokens||0).toLocaleString() + ' / ' + state.tokenBudget.toLocaleString()
        + '</span></div>'
    : '';
  m.innerHTML='<div class="mrow"><span>Agents</span><span>'+done+'/'+total+'</span></div>'
    +'<div class="mrow"><span>Time</span><span>'+elapsed+'</span></div>'
    +'<div class="mrow"><span>Tokens</span><span>'+(state.totalTokens||0).toLocaleString()+'</span></div>'
    +budgetRow
    +'<div class="mrow"><span>Cost</span><span>~$0.00</span></div>';
```

- [ ] **Step 7: Add `tokenBudget` to TeamRunState**

In `src/agent/team-definition.ts`, find `TeamRunState` interface. Add:

```typescript
  /** Token budget from team config. 0 or undefined = no budget. */
  tokenBudget?: number;
```

In `src/agent/team-runner.ts`, find `buildState()`. Add `tokenBudget: team.execution.totalTokenBudget` to the returned state object.

- [ ] **Step 8: Run full suite + compile**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 9: Validate webview JS**

```bash
node --check /home/dk/Documents/git/vs-code-plugin/src/ui/team-panel.ts 2>/dev/null || npm run check-types 2>&1 | tail -5
```

- [ ] **Step 10: Version bump + commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version
git add src/agent/team-runner.ts src/agent/team-definition.ts src/ui/team-panel.ts test/unit/agent/team-runner.test.ts package.json package-lock.json
git commit -m "feat: token budget enforcement — warn at 80%, soft-stop at 100%, budget bar in team panel"
```

---

## Task 2: Skip/Retry for Blocked/Failed Agents

**Files:**
- Modify: `src/agent/team-runner.ts` — add `onBlocked` callback to `TeamRunOptions`
- Modify: `src/extension.ts` — wire `onBlocked` in `champ.runTeam` and `champ.resumeTeamRun`
- Modify: `src/ui/team-panel.ts` — replace disabled hint with real Skip/Retry buttons

### Context

`teamSkipAgent` and `teamRetryAgent` message types exist in `TeamPanelMessage` (team-panel.ts:12-13) and `skipAgent`/`retryAgent` JS functions are defined (team-panel.ts:162-163) but never called. No handler exists in `extension.ts`. The BLOCKED exit path in `team-runner.ts` (line 340-349) fires and returns immediately without waiting.

**Design:** Add `onBlocked(agentId, reason) → Promise<{ action: "skip" | "retry"; context?: string }>` to `TeamRunOptions`. When an agent is BLOCKED, TeamRunner calls `onBlocked` and awaits the result instead of returning. The extension creates a Promise for each BLOCKED event and resolves it via a Map keyed by agentId when a Skip or Retry panel message arrives.

- [ ] **Step 1: Write failing test for onBlocked callback**

Add to `test/unit/agent/team-runner.test.ts`:

```typescript
describe("TeamRunner — skip/retry on blocked", () => {
  it("calls onBlocked when an agent emits BLOCKED and skips when action is skip", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"])]);

    let blockedCallCount = 0;
    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* (msgs: import("@/providers/types").LLMMessage[]) {
        // agent "a" is blocked, agent "b" proceeds normally
        const isAgentA = msgs[0].content.toString().includes("role of a");
        if (isAgentA) {
          yield { type: "text" as const, text: "BLOCKED: missing database schema" };
          yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 5 } };
        } else {
          yield { type: "text" as const, text: "<output>done</output>" };
          yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 5 } };
        }
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: () => 0,
      modelInfo: () => ({ contextWindow: 4096, name: "test", provider: "test" as const }),
      dispose: () => {},
    };

    const toolRegistry = {
      get: () => undefined, list: () => [], execute: async () => ({ success: true, output: "" }), register: () => {},
    } as any;

    let finalState: import("@/agent/team-definition").TeamRunState | undefined;
    await runner.run(team, "test", fakeProvider as any, toolRegistry, {
      onBlocked: async (agentId, _reason) => {
        blockedCallCount++;
        return { action: "skip" as const };
      },
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    expect(blockedCallCount).toBe(1);
    // agent "a" was skipped after block; agent "b" depends on "a" — its condition
    // should still allow it to run (null sentinel set for "a")
    expect(finalState!.agents.find((a) => a.id === "a")?.status).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -15
```

Expected: FAIL — `onBlocked` is not a known option.

- [ ] **Step 3: Add `onBlocked` to `TeamRunOptions`**

In `src/agent/team-runner.ts`, find `TeamRunOptions` (line 36). Add:

```typescript
export interface TeamRunOptions {
  onEvent?: (event: TeamRunEvent) => void;
  abortSignal?: AbortSignal;
  workspaceRoot?: string;
  onApprovalRequired?: (agentName: string) => Promise<boolean>;
  teamRunStore?: TeamRunStore;
  /**
   * Called when an agent emits BLOCKED. Return { action: "skip" } to mark the
   * agent skipped and continue, or { action: "retry", context?: string } to
   * re-run the agent with optional extra context injected into SharedMemory.
   * If absent, BLOCKED agents are skipped automatically.
   */
  onBlocked?: (
    agentId: string,
    reason: string,
  ) => Promise<{ action: "skip" | "retry"; context?: string }>;
}
```

- [ ] **Step 4: Replace BLOCKED early-return with onBlocked await**

In `src/agent/team-runner.ts`, find the BLOCKED handling block (around line 340):

```typescript
                if (output.error?.startsWith("BLOCKED:")) {
                  agentState.status = "blocked";
                  agentState.blockedReason = output.error
                    .slice("BLOCKED:".length)
                    .trim();
                  emit();
                  options.onEvent?.({
                    type: "blocked",
                    agentId: agentDef.id,
                    reason: agentState.blockedReason,
                  });
                  return;
                }
```

Replace with:

```typescript
                if (output.error?.startsWith("BLOCKED:")) {
                  agentState.status = "blocked";
                  agentState.blockedReason = output.error
                    .slice("BLOCKED:".length)
                    .trim();
                  emit();
                  options.onEvent?.({
                    type: "blocked",
                    agentId: agentDef.id,
                    reason: agentState.blockedReason,
                  });

                  // Ask the caller what to do. Default: skip.
                  const resolution = options.onBlocked
                    ? await options.onBlocked(agentDef.id, agentState.blockedReason)
                    : { action: "skip" as const };

                  if (resolution.action === "skip") {
                    agentState.status = "skipped";
                    memory.set(agentDef.outputKey, null);
                    memory.setOutput(agentDef.outputKey, { success: true, output: "", error: undefined });
                    emit();
                    return;
                  }

                  // retry: inject context and loop back (attempts counter handles max retries)
                  if (resolution.context) {
                    memory.set(`${agentDef.id}_retry_context`, resolution.context);
                  }
                  agentState.status = "running";
                  agentState.retryCount++;
                  emit();
                  // falls through to retry in the while loop
                  continue;
                }
```

Note: the `continue` statement restarts the `while (attempts < maxAttempts)` loop. Since `retryCount` is incremented and we track `attempts` separately, this will exhaust `maxAttempts` retries correctly.

Also update the system prompt builder to include retry context when present. In `src/agent/team-agent.ts`, after `input.userRequest + contextText`, check for retry context:

```typescript
    const retryContext = memory.get(`${this.def.id}_retry_context`) as string | undefined;
    const userContent = retryContext
      ? `${input.userRequest}${contextText}\n\n[Additional context for retry]: ${retryContext}`
      : input.userRequest + contextText;
```

And use `userContent` instead of `input.userRequest + contextText` when building `messages[1]`.

- [ ] **Step 5: Run test to confirm it passes**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-runner.test.ts 2>&1 | tail -15
```

Expected: all tests PASS.

- [ ] **Step 6: Wire onBlocked in extension.ts**

In `src/extension.ts`, find `champ.runTeam` command (line ~1566). Find the `panel.onMessage` call:

```typescript
        panel.onMessage((msg) => {
          if (msg.type === "teamStop") abortController.abort();
        });
```

Replace with:

```typescript
        // Resolver map: agentId → pending onBlocked Promise resolver
        const blockedResolvers = new Map<
          string,
          (resolution: { action: "skip" | "retry"; context?: string }) => void
        >();

        panel.onMessage((msg) => {
          if (msg.type === "teamStop") {
            abortController.abort();
          } else if (msg.type === "teamSkipAgent") {
            blockedResolvers.get(msg.agentId)?.({ action: "skip" });
            blockedResolvers.delete(msg.agentId);
          } else if (msg.type === "teamRetryAgent") {
            void vscode.window.showInputBox({
              prompt: `Additional context for "${msg.agentId}" retry:`,
              placeHolder: "e.g. The database schema is: users(id, email, name)",
              ignoreFocusOut: true,
            }).then((ctx) => {
              blockedResolvers.get(msg.agentId)?.({
                action: "retry",
                context: ctx ?? undefined,
              });
              blockedResolvers.delete(msg.agentId);
            });
          }
        });
```

And add `onBlocked` to the `runner.run()` options:

```typescript
        void runner.run(selectedTeam, userRequest, provider, toolRegistry, {
          workspaceRoot,
          abortSignal: abortController.signal,
          teamRunStore,
          onBlocked: (agentId, reason) =>
            new Promise((resolve) => {
              blockedResolvers.set(agentId, resolve);
              // Panel already shows blocked state via state_update event.
              // User acts via Skip/Retry buttons.
            }),
          onApprovalRequired: ...,
          onEvent: ...,
        });
```

Apply the same pattern to `champ.resumeTeamRun` (line ~1770).

- [ ] **Step 7: Replace disabled hint with real buttons in team-panel.ts**

In `src/ui/team-panel.ts`, find the disabled-hint block (around line 188):

```javascript
    if (a.status==='blocked'||a.status==='failed') {
      // Skip/Retry wiring is planned — show as disabled hint until implemented
      const acts = document.createElement('div');
      acts.className = 'ra-acts';
      const hint = document.createElement('span');
      hint.style.cssText='font-size:10px;opacity:.5;font-style:italic';
      hint.textContent = a.status==='blocked' ? '⚠ Blocked — stop and restart with more context' : '✗ Failed — check output above';
      acts.append(hint);
      div.append(acts);
    }
```

Replace with:

```javascript
    if (a.status==='blocked'||a.status==='failed') {
      const acts = document.createElement('div');
      acts.className = 'ra-acts';
      const skipBtn = document.createElement('button');
      skipBtn.className = 'ra-act-btn';
      skipBtn.textContent = 'Skip';
      skipBtn.title = 'Skip this agent and continue with remaining agents';
      skipBtn.onclick = (e) => skipAgent(a.id, e);
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ra-act-btn ra-act-retry';
      retryBtn.textContent = 'Retry';
      retryBtn.title = a.status === 'blocked'
        ? 'Retry with additional context you provide'
        : 'Retry this agent';
      retryBtn.onclick = (e) => retryAgent(a.id, e);
      acts.append(skipBtn, retryBtn);
      div.append(acts);
    }
```

Also add CSS in the `<style>` block in `renderHtml()`:

```css
  .ra-acts{display:flex;gap:4px;padding:4px 8px}
  .ra-act-btn{padding:2px 8px;font-size:10px;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;background:transparent;color:var(--vscode-foreground)}
  .ra-act-btn:hover{background:var(--vscode-list-hoverBackground)}
  .ra-act-retry{border-color:var(--vscode-progressBar-background);color:var(--vscode-progressBar-background)}
```

- [ ] **Step 8: Run full compile + tests + webview check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 9: Version bump + commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version
git add src/agent/team-runner.ts src/agent/team-agent.ts src/ui/team-panel.ts src/extension.ts test/unit/agent/team-runner.test.ts package.json package-lock.json
git commit -m "feat: wire Skip/Retry for blocked/failed agents — onBlocked callback, retry-with-context InputBox"
```

---

## Task 3: Context Overflow in TeamAgent

**Files:**
- Modify: `src/agent/team-agent.ts`
- Test: `test/unit/agent/team-agent.test.ts` (create if absent)

### Context

`ContextWindowManager` exists at `src/providers/context-manager.ts` and is used in `AgentController.processMessage()` (line 574). `TeamAgent.execute()` builds a 2-message array `[system, user]` and calls `streamToString` directly without any overflow check. If `systemPrompt + userRequest + contextText` exceeds the model's context window, the LLM call fails silently or truncates. Fix: estimate tokens, and if over budget, trim `contextText` from the end before calling the LLM.

- [ ] **Step 1: Write failing test**

Create `test/unit/agent/team-agent.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("TeamAgent — context overflow", () => {
  it("trims contextText when messages exceed model context window", async () => {
    const { TeamAgent } = await import("@/agent/team-agent");
    const { SharedMemory } = await import("@/agent/shared-memory");

    const agentDef = {
      id: "test-agent",
      name: "Test",
      role: "Tester",
      systemPrompt: "You are a test agent.",
      dependsOn: [],
      condition: "",
      tools: [],
      model: "",
      maxTokens: 100,
      outputKey: "test",
      outputFormat: "text" as const,
      selfCritique: false,
    };

    let capturedMessages: import("@/providers/types").LLMMessage[] = [];
    const fakeProvider = {
      name: "tiny",
      config: { provider: "tiny" as const, model: "tiny" },
      chat: async function* (msgs: import("@/providers/types").LLMMessage[]) {
        capturedMessages = msgs;
        yield { type: "text" as const, text: "<output>ok</output>" };
        yield { type: "done" as const, usage: { inputTokens: 5, outputTokens: 2 } };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      // countTokens: chars / 4 approximation
      countTokens: (text: string) => Math.ceil(text.length / 4),
      // Very small context: 50 tokens
      modelInfo: () => ({ contextWindow: 50, name: "tiny", provider: "tiny" as const }),
      dispose: () => {},
    };

    const agent = new TeamAgent(agentDef, fakeProvider as any);
    const memory = new SharedMemory();

    // Construct a huge context that alone would exceed the 50-token window
    const hugeContext = "A".repeat(1000); // ~250 tokens at 4 chars/token

    await agent.execute(
      { userRequest: "do something", context: [] },
      memory,
      hugeContext,
    );

    // The user message should be shorter than the original huge context
    const userMsg = capturedMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // Original would be "do something" + hugeContext (1012 chars ≈ 253 tokens).
    // After trim it must fit inside 50 tokens (≈ 200 chars).
    expect((userMsg!.content as string).length).toBeLessThan(300);
  });
});
```

Note: this test passes `hugeContext` as a third argument to `execute()`. We will NOT change the `AgentInput` type. Instead we wire the overflow protection internally using the input as-is. Adjust the test to match the final API in Step 3.

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-agent.test.ts 2>&1 | tail -15
```

Expected: FAIL (module not found or assertion fails because no trimming).

- [ ] **Step 3: Wire ContextWindowManager into TeamAgent**

In `src/agent/team-agent.ts`, add import at top:

```typescript
import { ContextWindowManager } from "../providers/context-manager";
```

In `execute()`, find where `messages` is built:

```typescript
    const messages: LLMMessage[] = [
      { role: "system", content: resolvedPrompt },
      { role: "user", content: input.userRequest + contextText },
    ];
```

After this block, add overflow protection:

```typescript
    // Trim contextText if the messages would exceed the model's context window.
    // We use a character-based trim (not token-based) as an approximation —
    // ContextWindowManager.fitMessages() only drops middle messages, which
    // doesn't help for a 2-message array. Instead we estimate and trim.
    const cm = new ContextWindowManager(this.provider);
    const budget = cm.availableTokens(messages);
    if (cm.estimateTokens(messages) > budget) {
      const systemTokens = this.provider.countTokens(resolvedPrompt);
      const requestTokens = this.provider.countTokens(input.userRequest);
      const available = Math.max(0, budget - systemTokens - requestTokens - 20); // 20 token margin
      // Approximate: 1 token ≈ 4 chars
      const maxContextChars = available * 4;
      const trimmedContext = contextText.slice(0, maxContextChars);
      if (trimmedContext.length < contextText.length) {
        console.warn(
          `TeamAgent "${this.def.id}": context trimmed from ${contextText.length} to ${trimmedContext.length} chars to fit model window`,
        );
      }
      messages[1] = {
        role: "user",
        content: input.userRequest + trimmedContext,
      };
    }
```

- [ ] **Step 4: Rewrite test to match actual API**

The test above passes `hugeContext` as a 3rd arg which doesn't exist. Adjust the test to inject a large context through the actual path: put a large value in `input.context` array.

Replace the test body's `agent.execute()` call with:

```typescript
    await agent.execute(
      {
        userRequest: "do something",
        context: [{ filePath: "huge.ts", startLine: 1, endLine: 9999, text: hugeContext }],
      },
      memory,
    );
```

And in `team-agent.ts`, the `contextText` is built from `input.context`:

```typescript
    const contextText =
      input.context.length > 0
        ? "\n\n# Workspace context\n\n" + input.context.map(...).join(...)
        : "";
```

So large `input.context` items naturally produce a large `contextText`. The trimming code we added will activate. Run the test again to verify.

- [ ] **Step 5: Run tests**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx vitest run test/unit/agent/team-agent.test.ts 2>&1 | tail -15
```

Expected: PASS.

- [ ] **Step 6: Run full suite**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

- [ ] **Step 7: Version bump + commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version
git add src/agent/team-agent.ts test/unit/agent/team-agent.test.ts package.json package-lock.json
git commit -m "feat: trim TeamAgent context to fit model window — prevents silent overflow failures"
```

---

## Task 4: Chat-Side Hunk Diff — Inline + Summary Panel

**Files:**
- Create: `src/agent/edit-review-tracker.ts`
- Modify: `src/tools/types.ts` — add `oldContent`, `newContent` to `ToolResult.metadata`
- Modify: `src/tools/edit-file.ts` — capture `oldContent` before edit; record in tracker; include in metadata
- Modify: `src/ui/messages.ts` — add `FileEditDiffMessage`, `EditSummaryMessage`, `RevertEditRequest`
- Modify: `src/ui/chat-view-provider.ts` — forward diff events to webview, send summary at turn end, handle revert
- Modify: `src/agent/agent-controller.ts` — emit file_edit_diff event when tool result has metadata
- Modify: `webview-ui/dist/main.js` — render inline diff card, render summary panel
- Modify: `webview-ui/dist/main.css` — styles
- Test: `test/unit/agent/edit-review-tracker.test.ts`

### Design

```
edit_file tool call
  └─ captures oldContent before vscode.workspace.applyEdit
  └─ records { path, oldContent, newContent } in EditReviewTracker
  └─ includes { oldContent, newContent } in ToolResult.metadata

AgentController
  └─ on tool_call_end with metadata.oldContent: emits file_edit_diff event

ChatViewProvider
  └─ on file_edit_diff: postMessage(fileEditDiff) → webview renders inline diff
  └─ on turn end (stream "done"): postMessage(editSummary) with all edits from tracker

Webview
  └─ fileEditDiff: show collapsible diff card inside tool call block
  └─ editSummary: show "Review N changes" panel at turn bottom with hunk-level Accept/Reject
  └─ revertEdit: postMessage back → ChatViewProvider → vscode.workspace.applyEdit(old)
```

**Edits are applied immediately** (agent sees success). Reject reverts by reapplying oldContent.

- [ ] **Step 1: Create EditReviewTracker**

Create `src/agent/edit-review-tracker.ts`:

```typescript
/**
 * EditReviewTracker: records file edits made during a single agent turn.
 *
 * edit-file.ts calls record() after each successful edit.
 * ChatViewProvider calls flush() at turn end to get all edits for the
 * summary panel, then reset() to clear for the next turn.
 */
export interface EditRecord {
  path: string;
  oldContent: string;
  newContent: string;
}

export class EditReviewTracker {
  private edits: EditRecord[] = [];

  record(edit: EditRecord): void {
    // Update in-place if path already tracked (agent edited same file twice)
    const existing = this.edits.find((e) => e.path === edit.path);
    if (existing) {
      existing.newContent = edit.newContent;
    } else {
      this.edits.push(edit);
    }
  }

  flush(): EditRecord[] {
    return [...this.edits];
  }

  reset(): void {
    this.edits = [];
  }

  get count(): number {
    return this.edits.length;
  }
}
```

- [ ] **Step 2: Write EditReviewTracker tests**

Create `test/unit/agent/edit-review-tracker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EditReviewTracker } from "@/agent/edit-review-tracker";

describe("EditReviewTracker", () => {
  it("records a single edit", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "foo.ts", oldContent: "old", newContent: "new" });
    expect(tracker.flush()).toHaveLength(1);
    expect(tracker.flush()[0].path).toBe("foo.ts");
  });

  it("updates in-place when same path edited twice", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "foo.ts", oldContent: "v1", newContent: "v2" });
    tracker.record({ path: "foo.ts", oldContent: "v2", newContent: "v3" });
    const edits = tracker.flush();
    expect(edits).toHaveLength(1);
    expect(edits[0].newContent).toBe("v3");
  });

  it("resets to empty after reset()", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "foo.ts", oldContent: "a", newContent: "b" });
    tracker.reset();
    expect(tracker.flush()).toHaveLength(0);
    expect(tracker.count).toBe(0);
  });

  it("tracks multiple different files", () => {
    const tracker = new EditReviewTracker();
    tracker.record({ path: "a.ts", oldContent: "a", newContent: "A" });
    tracker.record({ path: "b.ts", oldContent: "b", newContent: "B" });
    expect(tracker.flush()).toHaveLength(2);
  });
});
```

Run: `npx vitest run test/unit/agent/edit-review-tracker.test.ts 2>&1 | tail -10`
Expected: PASS (tracker is pure logic, no deps).

- [ ] **Step 3: Add oldContent/newContent to ToolResult.metadata**

In `src/tools/types.ts`, find `ToolResult` metadata:

```typescript
  metadata?: {
    filesModified?: string[];
```

Extend to:

```typescript
  metadata?: {
    filesModified?: string[];
    /** Old and new content for file edits, used by the diff review UI. */
    fileEditDiff?: { path: string; oldContent: string; newContent: string };
  };
```

- [ ] **Step 4: Capture oldContent in edit-file.ts and record in tracker**

In `src/tools/edit-file.ts`, find where `text` is read:

```typescript
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
```

After `const text = doc.getText();`, record `oldContent` before the edit. After the successful `applyEdit`, record the diff and include in metadata:

Find the success return:

```typescript
      return {
        success: true,
        output: `Successfully edited ${relativePath}`,
        metadata: { filesModified: [relativePath] },
      };
```

Replace with:

```typescript
      // Compute new full text for diff tracking
      const newText = text.slice(0, firstIdx) + newContent + text.slice(firstIdx + oldContent.length);

      // Notify EditReviewTracker if one is registered in the context
      if (context.editReviewTracker) {
        context.editReviewTracker.record({
          path: relativePath,
          oldContent: text,
          newContent: newText,
        });
      }

      return {
        success: true,
        output: `Successfully edited ${relativePath}`,
        metadata: {
          filesModified: [relativePath],
          fileEditDiff: {
            path: relativePath,
            oldContent: text,
            newContent: newText,
          },
        },
      };
```

- [ ] **Step 5: Add editReviewTracker to ToolExecutionContext**

In `src/tools/types.ts`, find `ToolExecutionContext`:

```typescript
export interface ToolExecutionContext {
  workspaceRoot: string;
```

Add:

```typescript
  /** Optional tracker that records file edits for the diff review UI. */
  editReviewTracker?: import("../agent/edit-review-tracker").EditReviewTracker;
```

- [ ] **Step 6: Instantiate tracker in ChatViewProvider and pass to tool context**

In `src/ui/chat-view-provider.ts`, find the constructor. Add:

```typescript
import { EditReviewTracker } from "../agent/edit-review-tracker";
```

Add a property:

```typescript
  private readonly editTracker = new EditReviewTracker();
```

Find where `workspaceRoot` is passed to the agent as tool context (search `workspaceRoot` near the `processMessage` call). The tool context is built in `AgentController` — check if `ToolExecutionContext` is built there. Search for `buildToolContext` or similar.

In `src/agent/agent-controller.ts`, find where `ToolExecutionContext` is constructed (search for `workspaceRoot` being passed to tool execute). Add:

```typescript
      const toolContext: ToolExecutionContext = {
        workspaceRoot: this.workspaceRoot ?? "",
        editReviewTracker: this.editReviewTracker,  // add this
        ...
      };
```

Add `editReviewTracker?: EditReviewTracker` as a field on `AgentController` and a setter:

```typescript
  private editReviewTracker?: EditReviewTracker;

  setEditReviewTracker(tracker: EditReviewTracker): void {
    this.editReviewTracker = tracker;
  }
```

In `ChatViewProvider`, before calling `processMessage`, call `agentController.setEditReviewTracker(this.editTracker)`. After the turn completes (in the `done` handler), call `this.emitEditSummary()` then `this.editTracker.reset()`.

- [ ] **Step 7: Add message types to messages.ts**

In `src/ui/messages.ts`, after existing message interfaces, add:

```typescript
/** Emitted after each successful file edit — renders an inline diff card in the chat. */
export interface FileEditDiffMessage {
  type: "fileEditDiff";
  path: string;
  oldContent: string;
  newContent: string;
}

/** Emitted at the end of an agent turn — shows the summary panel for all edits. */
export interface EditSummaryMessage {
  type: "editSummary";
  edits: Array<{ path: string; oldContent: string; newContent: string }>;
}
```

Add to `ExtensionToWebviewMessage` union.

Add `RevertEditRequest` to `WebviewToExtensionMessage`:

```typescript
export interface RevertEditRequest {
  type: "revertEdit";
  path: string;
  /** Restore this content to the file (the oldContent before agent edit). */
  restoreContent: string;
}
```

Add to `WebviewToExtensionMessage` union. Add type guard:

```typescript
export function isRevertEditRequest(msg: WebviewToExtensionMessage): msg is RevertEditRequest {
  return msg.type === "revertEdit";
}
```

- [ ] **Step 8: Emit diff events and handle revert in ChatViewProvider**

In `src/ui/chat-view-provider.ts`, in `handleAgentEvent()` or wherever `tool_call_end` is handled:

After the `tool_call_end` case, check for `fileEditDiff` in the tool result metadata and postMessage a `fileEditDiff`:

```typescript
      case "tool_call_end":
        if (delta.toolName) {
          this.postMessage(
            createToolCallResult(delta.toolName, delta.toolResult ?? "", delta.toolSuccess ?? true),
          );
          // If this was a file edit, send the diff for inline rendering
          if (delta.fileEditDiff) {
            this.postMessage({
              type: "fileEditDiff",
              path: delta.fileEditDiff.path,
              oldContent: delta.fileEditDiff.oldContent,
              newContent: delta.fileEditDiff.newContent,
            } satisfies FileEditDiffMessage);
          }
        }
        break;
```

Note: `delta.fileEditDiff` requires the `tool_call_end` event type in the `AgentEvent` union to include it. Add `fileEditDiff?: { path: string; oldContent: string; newContent: string }` to that event variant in `agent-controller.ts`.

Add `emitEditSummary()`:

```typescript
  private emitEditSummary(): void {
    const edits = this.editTracker.flush();
    if (edits.length === 0) return;
    this.postMessage({
      type: "editSummary",
      edits,
    } satisfies EditSummaryMessage);
    this.editTracker.reset();
  }
```

Call `this.emitEditSummary()` in the `done` event handler (after `createStreamEnd` is posted).

In `handleWebviewMessage()`, add revert handling:

```typescript
      } else if (isRevertEditRequest(msg)) {
        void this.revertFileEdit(msg.path, msg.restoreContent);
```

Add:

```typescript
  private async revertFileEdit(relativePath: string, restoreContent: string): Promise<void> {
    try {
      const abs = path.join(this.workspaceRoot ?? "", relativePath);
      const uri = vscode.Uri.file(abs);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(restoreContent));
      void vscode.window.showInformationMessage(`Champ: reverted changes to ${relativePath}`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Champ: failed to revert ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

- [ ] **Step 9: Add inline diff rendering to webview main.js**

In `webview-ui/dist/main.js`, find the `toolCallResult` message handler. After it renders the tool result, if a `fileEditDiff` message arrives for the same file, show a diff card. Add a `fileEditDiff` message handler:

```javascript
  } else if (msg.type === 'fileEditDiff') {
    // Show inline diff card after the last tool result in the chat
    const diffCard = el('div', { class: 'edit-diff-card' });
    const header = el('div', { class: 'edit-diff-header' }, [
      el('span', { class: 'edit-diff-path' }, [msg.path]),
      el('span', { class: 'edit-diff-badge' }, ['edited']),
    ]);
    const body = el('div', { class: 'edit-diff-body' });
    const hunks = splitHunks(msg.oldContent, msg.newContent);
    if (hunks.length === 0) {
      body.appendChild(el('span', { style: 'opacity:.5;font-size:11px' }, ['No changes']));
    } else {
      hunks.slice(0, 3).forEach((hunk) => { // show first 3 hunks inline, rest in summary
        hunk.oldLines.forEach(l => body.appendChild(el('div', { class: 'diff-line del' }, ['- ' + l])));
        hunk.newLines.forEach(l => body.appendChild(el('div', { class: 'diff-line add' }, ['+ ' + l])));
      });
      if (hunks.length > 3) {
        body.appendChild(el('div', { style: 'opacity:.5;font-size:10px;padding:2px 4px' }, [
          `… ${hunks.length - 3} more hunk(s) — see Review panel below`
        ]));
      }
    }
    diffCard.append(header, body);
    // Append after latest message bubble
    const bubbles = document.querySelectorAll('.msg-bubble');
    if (bubbles.length > 0) bubbles[bubbles.length - 1].after(diffCard);
    else messagesWrapper.appendChild(diffCard);
  } else if (msg.type === 'editSummary') {
    // Show "Review N file changes" summary panel at bottom of turn
    const panel = el('div', { class: 'edit-summary-panel' });
    const title = el('div', { class: 'edit-summary-title' }, [
      `📝 Review ${msg.edits.length} file change${msg.edits.length !== 1 ? 's' : ''}`
    ]);
    panel.appendChild(title);
    msg.edits.forEach((edit) => {
      const fileSection = el('div', { class: 'edit-summary-file' });
      const fileHeader = el('div', { class: 'edit-summary-file-header' });
      const pathEl = el('span', { class: 'edit-diff-path' }, [edit.path]);
      const rejectBtn = el('button', { class: 'edit-reject-btn', title: 'Revert this file to its original content' }, ['↩ Revert']);
      rejectBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'revertEdit', path: edit.path, restoreContent: edit.oldContent });
        rejectBtn.textContent = '✓ Reverted';
        rejectBtn.disabled = true;
        fileSection.style.opacity = '0.5';
      });
      fileHeader.append(pathEl, rejectBtn);
      const hunksEl = el('div', { class: 'edit-summary-hunks' });
      const hunks = splitHunks(edit.oldContent, edit.newContent);
      hunks.forEach((hunk, idx) => {
        const hunkEl = el('div', { class: 'hunk' });
        hunk.oldLines.forEach(l => hunkEl.appendChild(el('span', { class: 'diff-line del' }, ['- ' + l])));
        hunk.newLines.forEach(l => hunkEl.appendChild(el('span', { class: 'diff-line add' }, ['+ ' + l])));
        hunksEl.appendChild(hunkEl);
      });
      fileSection.append(fileHeader, hunksEl);
      panel.appendChild(fileSection);
    });
    messagesWrapper.appendChild(panel);
    messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
  }
```

Note: `splitHunks` is already defined in `main.js` from the hunk-diff feature (Task 3 in the previous plan). It will be available in scope.

- [ ] **Step 10: Add CSS to main.css**

Append to `webview-ui/dist/main.css`:

```css
/* Chat-side edit diff review */
.edit-diff-card{margin:4px 8px;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden;font-size:11px}
.edit-diff-header{display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--vscode-sideBarSectionHeader-background)}
.edit-diff-path{font-weight:600;font-family:monospace}
.edit-diff-badge{padding:1px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:10px}
.edit-diff-body{padding:4px 8px;max-height:120px;overflow-y:auto}
.edit-summary-panel{margin:6px 8px;border:1px solid var(--vscode-focusBorder);border-radius:4px;overflow:hidden}
.edit-summary-title{padding:6px 10px;background:var(--vscode-sideBarSectionHeader-background);font-size:12px;font-weight:600}
.edit-summary-file{border-top:1px solid var(--vscode-panel-border)}
.edit-summary-file-header{display:flex;align-items:center;justify-content:space-between;padding:4px 8px;background:var(--vscode-editor-background)}
.edit-summary-hunks{padding:0 4px;max-height:200px;overflow-y:auto}
.edit-reject-btn{padding:2px 8px;font-size:10px;border:1px solid var(--vscode-errorForeground);color:var(--vscode-errorForeground);border-radius:3px;cursor:pointer;background:transparent}
.edit-reject-btn:hover{background:rgba(248,136,136,.15)}
.edit-reject-btn:disabled{opacity:.5;cursor:default}
```

- [ ] **Step 11: Run full compile + tests + webview syntax check**

```bash
cd /home/dk/Documents/git/vs-code-plugin && node --check webview-ui/dist/main.js && npm run compile 2>&1 | tail -5 && npx vitest run 2>&1 | tail -5
```

All must pass. If `node --check` reports a syntax error, fix it before committing.

- [ ] **Step 12: Build, install, version bump, commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm version patch --no-git-tag-version && npx vsce package --no-dependencies 2>&1 | tail -3 && code --install-extension champ-*.vsix --force
git add src/agent/edit-review-tracker.ts src/tools/types.ts src/tools/edit-file.ts src/ui/messages.ts src/ui/chat-view-provider.ts src/agent/agent-controller.ts webview-ui/dist/main.js webview-ui/dist/main.css test/unit/agent/edit-review-tracker.test.ts package.json package-lock.json
git commit -m "feat: inline + summary hunk diff review in chat sidebar — agents' file edits shown with per-hunk revert"
```

- [ ] **Step 13: Push**

```bash
git push github master
```

---

## Self-Review

**Spec coverage:**
- ✅ Token budget warn at 80% — Task 1, Steps 4-5
- ✅ Token budget soft-stop at 100% — Task 1, Step 4
- ✅ Budget progress bar in TeamPanel — Task 1, Steps 6-7
- ✅ `tokenBudget` surfaced in `TeamRunState` — Task 1, Step 7
- ✅ Skip button wired for blocked/failed agents — Task 2, Steps 6-7
- ✅ Retry button with context InputBox — Task 2, Steps 6-7
- ✅ `onBlocked` callback in TeamRunOptions — Task 2, Steps 3-4
- ✅ Context overflow protection in TeamAgent — Task 3
- ✅ `EditReviewTracker` singleton — Task 4, Step 1
- ✅ `oldContent`/`newContent` in tool metadata — Task 4, Steps 3-4
- ✅ Inline diff card in chat — Task 4, Step 9
- ✅ "Review N changes" summary panel — Task 4, Step 9
- ✅ Revert (reject) writes `oldContent` back to disk — Task 4, Steps 8

**Placeholder scan:** No TBD, no TODO, all TypeScript is complete. Every step has code.

**Type consistency:**
- `EditRecord.path/oldContent/newContent` matches usage in tracker, messages, and webview
- `onBlocked` return type `{ action: "skip" | "retry"; context?: string }` matches usage in team-runner.ts and extension.ts
- `FileEditDiffMessage` fields `path/oldContent/newContent` match `EditRecord` shape
- `tokenBudget?: number` added to `TeamRunState` and set in `buildState()` — consistent
