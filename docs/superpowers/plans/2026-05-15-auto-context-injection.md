# Plan: Auto Context Injection (Active Editor File)

**Date**: 2026-05-15  
**Goal**: Automatically include the currently active editor file as context when the user's message contains no `@`-symbols, so the model always knows what the user is looking at without requiring explicit `@Files(path)` syntax.  
**Status**: Ready to execute

---

## Architecture

In `ChatViewProvider.resolveContextReferences()`, after parsing refs: if `refs.length === 0` AND `getEditorContext()` returns a `filePath`, synthesize a `{ type: "file", value: filePath, start: 0, end: 0 }` reference and push it to `enrichedRefs`. The resolver will read and inline the file content as it would for an explicit `@Files(path)`. When injection fires, emit a `postMessage({ type: "autoContextNotice", files: [filePath] })` so the webview can display a subtle banner. A VS Code setting `champ.autoContext.enabled` (default `true`) gates the feature.

### Current state (baselines from code reading)

- `src/ui/chat-view-provider.ts` lines 764-809: `resolveContextReferences(text)` — calls `this.contextResolver.parseReferences(text)`, returns early if `refs.length === 0` (line 768: `if (refs.length === 0) return text`). This is where the injection point lives.
- `src/agent/context-resolver.ts` lines 132-138: `ContextResolverDeps.getEditorContext?()` — returns `{ selection, filePath, language } | undefined`. Already wired via the `@Code` resolver; available to `ChatViewProvider` since it constructs `ContextResolver` with deps.
- `src/agent/context-resolver.ts` line 171-179: `parseReferences` returns `ContextReference[]` with `{ type: ReferenceType; value: string; start: number; end: number }`.
- `src/ui/messages.ts` lines 408-433: `WebviewToExtensionMessage` union (extension → webview messages are `ExtensionToWebviewMessage`).
- `webview-ui/dist/main.js` lines 1770-1771: `approvalRequest` case. Auto-context notice will be a new `case 'autoContextNotice'`.

### Tech Stack

TypeScript (extension host), vanilla JS (webview), VS Code configuration API.

---

## Tasks

### Task 1 — Add `AutoContextNoticeMessage` to `ExtensionToWebviewMessage`

**Files**: `src/ui/messages.ts`

**Step 1 — write failing test**

File: `src/ui/__tests__/auto-context-notice-type.test.ts`

```typescript
import type { AutoContextNoticeMessage, ExtensionToWebviewMessage } from "../messages";

describe("AutoContextNoticeMessage type", () => {
  it("is a valid ExtensionToWebviewMessage", () => {
    const msg: ExtensionToWebviewMessage = {
      type: "autoContextNotice",
      files: ["src/app.ts"],
    } satisfies AutoContextNoticeMessage;
    expect(msg.type).toBe("autoContextNotice");
  });

  it("files array is required", () => {
    const msg: AutoContextNoticeMessage = {
      type: "autoContextNotice",
      files: ["src/foo.ts", "src/bar.ts"],
    };
    expect(msg.files).toHaveLength(2);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/auto-context-notice-type.test.ts 2>&1 | tail -10`  
Expected: type errors / test failures (interface does not exist yet).

**Step 2 — implement**

In `src/ui/messages.ts`, locate the `ExtensionToWebviewMessage` union (search for `ExtensionToWebviewMessage`). Add the new interface and include it in the union.

Add the interface before the union:

```typescript
/**
 * Sent to the webview when the active editor file is automatically injected
 * as context because the user's message contained no @-references.
 */
export interface AutoContextNoticeMessage {
  type: "autoContextNotice";
  /** Absolute or workspace-relative paths of the auto-included files. */
  files: string[];
}
```

Add `AutoContextNoticeMessage` to `ExtensionToWebviewMessage`:

```typescript
export type ExtensionToWebviewMessage =
  // … existing members …
  | AutoContextNoticeMessage;
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/auto-context-notice-type.test.ts 2>&1 | tail -10`  
Expected: 2 tests pass.

**Step 4 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 5 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/messages.ts src/ui/__tests__/auto-context-notice-type.test.ts
git commit -m "feat: add AutoContextNoticeMessage to ExtensionToWebviewMessage"
```

---

### Task 2 — Add `champ.autoContext.enabled` VS Code setting

**File**: `package.json`

**Step 1 — write failing test**

No vitest needed; this is a package.json schema addition. Verify by compile-time check and manual inspection.

Check that the setting is absent:

```bash
grep -c "autoContext" /home/dk/Documents/git/vs-code-plugin/package.json
```
Expected: `0` (not yet present).

**Step 2 — implement**

In `package.json`, in `contributes.configuration.properties`, add:

```json
"champ.autoContext.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Automatically inject the active editor file as context when no @-references are present in the user's message."
}
```

**Step 3 — verify**

```bash
grep -c "autoContext" /home/dk/Documents/git/vs-code-plugin/package.json
```
Expected: `1`.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add package.json
git commit -m "feat: add champ.autoContext.enabled setting (default true)"
```

---

### Task 3 — Inject active file in `resolveContextReferences` when no refs present

**File**: `src/ui/chat-view-provider.ts`

**Step 1 — write failing test**

File: `src/ui/__tests__/auto-context-injection.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { ContextResolver } from "../../agent/context-resolver";

// We test the injection logic in isolation by constructing a ContextResolver
// with a mock getEditorContext and verifying that parseReferences + resolve
// produces file content when the message has no @-refs.

describe("auto-context injection logic", () => {
  it("injects active file reference when message has no @-symbols", async () => {
    const injectedFiles: string[] = [];

    const mockResolver = new ContextResolver({
      workspaceRoot: "/ws",
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: "/ws/src/active.ts",
        language: "typescript",
      }),
      fileReader: {
        async readFile(absPath) {
          if (absPath === "/ws/src/active.ts") return "const x = 42;";
          throw new Error("not found");
        },
        async readdir() { return []; },
      },
    });

    // Simulate the injection: if refs.length === 0, add a file ref for getEditorContext().filePath
    const refs = mockResolver.parseReferences("what does this do?");
    expect(refs).toHaveLength(0); // no @-refs in plain message

    // Simulate the injection step (what resolveContextReferences will do after this plan):
    const editorCtx = mockResolver["deps"].getEditorContext?.();
    if (editorCtx && refs.length === 0) {
      injectedFiles.push(editorCtx.filePath);
    }

    expect(injectedFiles).toEqual(["/ws/src/active.ts"]);
  });

  it("does NOT inject when @-refs already present", async () => {
    const injectedFiles: string[] = [];
    const mockResolver = new ContextResolver({
      workspaceRoot: "/ws",
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "selected code",
        filePath: "/ws/src/active.ts",
        language: "typescript",
      }),
    });

    const refs = mockResolver.parseReferences("explain @Code");
    // @Code produces a ref — injection should be skipped
    if (refs.length === 0) {
      injectedFiles.push("should not be here");
    }

    expect(injectedFiles).toHaveLength(0);
  });

  it("does NOT inject when getEditorContext is absent", () => {
    const injectedFiles: string[] = [];
    const mockResolver = new ContextResolver({
      workspaceRoot: "/ws",
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      // no getEditorContext
    });

    const refs = mockResolver.parseReferences("plain message");
    const editorCtx = mockResolver["deps"].getEditorContext?.();
    if (!editorCtx || refs.length > 0) {
      // correctly skipped
    } else {
      injectedFiles.push(editorCtx.filePath);
    }

    expect(injectedFiles).toHaveLength(0);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/auto-context-injection.test.ts 2>&1 | tail -10`  
Expected: tests pass (they test the logic pattern, not yet wired into `resolveContextReferences`).

**Step 2 — implement in `resolveContextReferences`**

First add `getEditorContext?()` to the `ChatContextResolver` interface in `src/ui/chat-view-provider.ts` (lines 68-80):

```typescript
export interface ChatContextResolver {
  parseReferences(text: string): Array<{
    type: string;
    value: string;
    start: number;
    end: number;
  }>;
  resolve(
    refs: Array<{ type: string; value: string; start: number; end: number }>,
  ): Promise<Array<{ type: string; label: string; content: string }>>;
  /** Optional: returns the active editor's context (file path, selection, language). */
  getEditorContext?(): { selection: string; filePath: string; language: string } | undefined;
}
```

The real `ContextResolver` already has `getEditorContext()` added in Task 3 step 2. Extending the interface here makes it accessible without a type cast.

In `src/ui/chat-view-provider.ts`, update `resolveContextReferences`. The current early-return at line 768:

```typescript
    const refs = this.contextResolver.parseReferences(text);
    if (refs.length === 0) return text;
```

Replace with:

```typescript
    const refs = this.contextResolver.parseReferences(text);

    // Auto-context injection: if the user wrote no @-references, include the
    // active editor file automatically so the model sees what the user is looking at.
    const autoContextEnabled = vscode.workspace
      .getConfiguration("champ")
      .get<boolean>("autoContext.enabled", true);

    if (refs.length === 0 && autoContextEnabled) {
      const editorCtx = this.contextResolver.getEditorContext?.();
      if (editorCtx?.filePath) {
        // Synthesize a file reference pointing at the active editor file.
        const injectedRef: import("../agent/context-resolver").ContextReference = {
          type: "file",
          value: editorCtx.filePath,
          start: 0,
          end: 0,
        };
        // Resolve the injected reference.
        let injectedResolved: Array<{ type: string; label: string; content: string }>;
        try {
          injectedResolved = await this.contextResolver.resolve([injectedRef]);
        } catch {
          return text;
        }
        if (injectedResolved.length > 0) {
          // Notify webview so it can show the "auto-included: filename.ts" label.
          const baseName = path.basename(editorCtx.filePath);
          this.postMessage({ type: "autoContextNotice", files: [baseName] });

          const sections = injectedResolved
            .map((r) => `--- ${r.label} ---\n${r.content}`)
            .join("\n\n");
          return `${text}\n\n# Referenced context\n\n${sections}`;
        }
      }
      return text;
    }

    if (refs.length === 0) return text;
```

Note: `path` may already be imported in `chat-view-provider.ts`. If not, add `import * as path from "path";` at the top.

Also expose `getEditorContext` on the `ContextResolver` instance. Check if it is currently a private dep or directly accessible. If `deps.getEditorContext` is private, add a public accessor to `ContextResolver`:

```typescript
// In src/agent/context-resolver.ts, inside the ContextResolver class:
getEditorContext(): { selection: string; filePath: string; language: string } | undefined {
  return this.deps.getEditorContext?.();
}
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/auto-context-injection.test.ts 2>&1 | tail -10`  
Expected: all 3 tests pass.

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/chat-view-provider.ts src/agent/context-resolver.ts src/ui/__tests__/auto-context-injection.test.ts
git commit -m "feat: auto-inject active editor file as context when no @-refs present"
```

---

### Task 4 — Handle `autoContextNotice` in webview and render inline label

**File**: `webview-ui/dist/main.js`

**Step 1 — verify syntax**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`

**Step 2 — implement**

In `webview-ui/dist/main.js`, inside the `window.addEventListener('message', ...)` handler, add a new case after the `approvalRequest` case:

```javascript
      case 'autoContextNotice': {
        if (!msg.files || msg.files.length === 0) break;
        const notice = el('div', { class: 'auto-context-notice' });
        const fileList = msg.files.join(', ');
        notice.appendChild(el('span', { class: 'auto-context-icon' }, ['📎']));
        notice.appendChild(el('span', { class: 'auto-context-text' }, [
          'Auto-included: ' + fileList
        ]));
        messagesContainer.append(notice);
        // Auto-dismiss after 4 seconds
        setTimeout(function() {
          notice.style.opacity = '0';
          notice.style.transition = 'opacity 0.5s';
          setTimeout(function() { notice.remove(); }, 500);
        }, 4000);
        break;
      }
```

**Step 3 — syntax check**

`node --check /home/dk/Documents/git/vs-code-plugin/webview-ui/dist/main.js && echo OK`  
Expected: `OK`.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add webview-ui/dist/main.js
git commit -m "feat: render auto-context notice banner in chat UI with 4s auto-dismiss"
```

---

### Task 5 — End-to-end integration test for auto-context pipeline

**File**: `src/ui/__tests__/auto-context-e2e.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { ContextResolver } from "../../agent/context-resolver";

describe("auto-context full pipeline", () => {
  it("resolve() returns file content when a synthetic file ref is injected", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: "/ws/src/main.ts",
        language: "typescript",
      }),
      fileReader: {
        async readFile(absPath) {
          if (absPath === "/ws/src/main.ts") return "export const MAIN = true;";
          throw new Error("not found: " + absPath);
        },
        async readdir() { return []; },
      },
    });

    // Simulate the injection
    const syntheticRef = {
      type: "file" as const,
      value: "/ws/src/main.ts",
      start: 0,
      end: 0,
    };

    const resolved = await resolver.resolve([syntheticRef]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toContain("export const MAIN = true;");
  });

  it("getEditorContext() accessor returns the configured context", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "selected",
        filePath: "/ws/active.ts",
        language: "typescript",
      }),
    });
    const ctx = resolver.getEditorContext();
    expect(ctx?.filePath).toBe("/ws/active.ts");
  });

  it("getEditorContext() returns undefined when not wired", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
    });
    expect(resolver.getEditorContext()).toBeUndefined();
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/ui/__tests__/auto-context-e2e.test.ts 2>&1 | tail -10`  
Expected: all 3 tests pass.

**Commit:**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/ui/__tests__/auto-context-e2e.test.ts
git commit -m "test: end-to-end coverage for auto-context injection pipeline"
```

---

## Completion checklist

- [ ] `AutoContextNoticeMessage` interface in `src/ui/messages.ts` and added to `ExtensionToWebviewMessage`
- [ ] `champ.autoContext.enabled` setting in `package.json` (default `true`)
- [ ] `ContextResolver.getEditorContext()` public accessor in `src/agent/context-resolver.ts`
- [ ] `resolveContextReferences()` injects active file ref when `refs.length === 0` and setting is enabled
- [ ] `postMessage({ type: "autoContextNotice", files: [baseName] })` fired on injection
- [ ] Webview `autoContextNotice` case renders a dismissing notice banner
- [ ] `node --check webview-ui/dist/main.js` passes
- [ ] `npx tsc --noEmit` 0 errors
- [ ] All 5 test files green
