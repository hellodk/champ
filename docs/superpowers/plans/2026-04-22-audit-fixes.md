# Champ Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 23 issues identified in the April 2026 external audit of the Champ VS Code plugin.

**Architecture:** Changes spread across 7 files; no new files needed. The Ollama 404 bug (error message + SmartRouter model mismatch) is already fixed on the current branch. This plan covers the remaining 21 issues grouped by file.

**Tech Stack:** TypeScript, VS Code Extension API, esbuild, vitest

---

## File Map

| File | Issues fixed |
|------|-------------|
| `package.json` | B1 B2 B3 B4 B5 B6 |
| `src/config/config-loader.ts` | C1 C2 C3(schema) C4 C5 C6 |
| `src/providers/smart-router.ts` | D3 D4 + task-model overrides for C1 |
| `src/providers/openai-compatible.ts` | D2 |
| `src/config/sample-configs.ts` | E5 |
| `src/ui/chat-view-provider.ts` | E6 |
| `src/extension.ts` | C3(wire) D1 E1(partial) F1 F2 F3 + routing wiring |

---

### Task 1: package.json — Settings Cleanup (B1–B6)

**Files:**
- Modify: `package.json` (contributes.configuration.properties)

- [ ] **Step 1: Remove dead API key plain-text settings**

Remove the three `champ.*.apiKey` entries that expose secrets as plain settings (they're never read — the code uses SecretStorage). Remove: `champ.claude.apiKey`, `champ.openai.apiKey`, `champ.gemini.apiKey`.

- [ ] **Step 2: Fix llamacpp baseUrl default — must include /v1**

Change `"champ.llamacpp.baseUrl"` default from `"http://localhost:8080"` to `"http://localhost:8080/v1"` (matches what `ProviderFactory.createLlamaCpp()` falls back to).

- [ ] **Step 3: Add missing vllm.apiKey setting**

Add after the existing `champ.vllm.model` entry:
```json
"champ.vllm.apiKey": {
  "type": "string",
  "markdownDescription": "vLLM API key (if your server requires authentication). Store via **Champ: Set API Key** command."
},
```

- [ ] **Step 4: Fix embeddingProvider enum to match validator**

Change `champ.indexing.embeddingProvider` enum from `["ollama", "openai"]` — it already matches. Verify the description is consistent:
```json
"champ.indexing.embeddingProvider": {
  "type": "string",
  "default": "ollama",
  "enum": ["ollama", "openai"],
  "markdownDescription": "Provider for codebase embedding (semantic search). Only `ollama` and `openai` support embeddings."
},
```

- [ ] **Step 5: Update ollama.model default to match YAML generator**

Change `champ.ollama.model` default from `"llama3.1"` to `"qwen2.5-coder:7b-instruct"`.

- [ ] **Step 6: Add markdownDescription to key settings**

Add `markdownDescription` to the settings that currently have bare `description` strings or none at all. Key ones:
- `champ.provider`: `"Active LLM provider. Edit **.champ/config.yaml** for full control."`
- `champ.ollama.baseUrl`: `"Ollama server base URL. Default is local; set to a remote address if running Ollama on another machine."`
- `champ.llamacpp.baseUrl`: `"llama.cpp server base URL **including /v1** (e.g. http://localhost:8080/v1)."`

- [ ] **Step 7: Verify types compile**

```bash
cd /home/dk/Documents/git/vs-code-plugin && npm run check-types
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json
git commit -m "fix: settings cleanup — remove dead API key fields, fix defaults, add descriptions"
```

---

### Task 2: ConfigLoader — Routing, Validation Fixes (C1–C6)

**Files:**
- Modify: `src/config/config-loader.ts`

- [ ] **Step 1: Add RoutingConfig interface and routing to ChampConfig**

After the `MCPConfig` interface (~line 85), add:

```typescript
export interface RoutingConfig {
  mode?: "smart" | "manual";
  /** Force a specific model ID for coding tasks (null = auto). */
  coding?: string | null;
  chat?: string | null;
  completion?: string | null;
  embedding?: string | null;
}
```

Add `routing?: RoutingConfig;` to `ChampConfig`.

- [ ] **Step 2: Parse routing: in ConfigLoader.validate()**

Add after the `mcp` block (~line 406), before the final `return result;`:

```typescript
// routing
if ("routing" in raw) {
  const rt = raw.routing;
  if (typeof rt !== "object" || rt === null || Array.isArray(rt)) {
    throw new Error("`routing` must be an object");
  }
  const r = rt as Record<string, unknown>;
  const out: RoutingConfig = {};
  if ("mode" in r) {
    if (r.mode !== "smart" && r.mode !== "manual") {
      throw new Error('routing.mode must be "smart" or "manual"');
    }
    out.mode = r.mode as "smart" | "manual";
  }
  for (const key of ["coding", "chat", "completion", "embedding"] as const) {
    if (key in r) {
      if (r[key] !== null && typeof r[key] !== "string") {
        throw new Error(`routing.${key} must be a string or null`);
      }
      out[key] = r[key] as string | null | undefined;
    }
  }
  result.routing = out;
}
```

- [ ] **Step 3: Add routing to merge() and withDefaults()**

In `merge()`, add after the `mcp` block:
```typescript
if (override.routing) {
  result.routing = { ...result.routing, ...override.routing };
}
```

`withDefaults()` needs no change (routing has sensible undefined defaults).

- [ ] **Step 4: Add minimum validation for maxIterations (C2)**

In the `autoFix` block parsing (around line 289), after setting `fix.maxIterations`:
```typescript
if ("maxIterations" in f) {
  if (typeof f.maxIterations !== "number" || f.maxIterations < 1) {
    throw new Error("agent.autoFix.maxIterations must be a number >= 1");
  }
  fix.maxIterations = f.maxIterations;
}
```

- [ ] **Step 5: Narrow embeddingProvider to embedding-capable providers (C4)**

Change the validation in the `indexing` block:
```typescript
const EMBEDDING_PROVIDERS = ["ollama", "openai"] as const;

if ("embeddingProvider" in i) {
  if (
    typeof i.embeddingProvider !== "string" ||
    !(EMBEDDING_PROVIDERS as readonly string[]).includes(i.embeddingProvider)
  ) {
    throw new Error(
      `indexing.embeddingProvider must be one of: ${EMBEDDING_PROVIDERS.join(", ")}`,
    );
  }
  out.embeddingProvider = i.embeddingProvider as ProviderName;
}
```

- [ ] **Step 6: Fix activeProviderConfig() to not throw on missing entry (C5)**

Change the function to return the name + empty config rather than throwing:
```typescript
static activeProviderConfig(config: ChampConfig): {
  name: ProviderName;
  baseUrl?: string;
  model?: string;
} {
  const name = config.provider;
  if (!name) {
    throw new Error("No active provider — set `provider:` in your config");
  }
  const entry = config.providers?.[name] ?? {};
  return { name, baseUrl: entry.baseUrl, model: entry.model };
}
```

- [ ] **Step 7: Verify types compile**

```bash
npm run check-types
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/config/config-loader.ts
git commit -m "feat: add routing config, fix maxIterations validation, narrow embeddingProvider"
```

---

### Task 3: SmartRouter — Timeout + Change Detection + Task Overrides (D3, D4, C1 wiring)

**Files:**
- Modify: `src/providers/smart-router.ts`

- [ ] **Step 1: Increase discovery timeout to 5s**

Change `const DISCOVERY_TIMEOUT_MS = 3000;` to `const DISCOVERY_TIMEOUT_MS = 5000;`.

- [ ] **Step 2: Only fire onChange when model list actually changes**

Add a `private lastModelsSig = "";` field. In `discover()`, after `this.models = allModels; this.discovered = true;`:

```typescript
const sig = allModels.map((m) => `${m.providerName}:${m.id}`).sort().join("|");
if (sig !== this.lastModelsSig) {
  this.lastModelsSig = sig;
  this.emit();
}
```

Remove the unconditional `this.emit()` that's currently there.

- [ ] **Step 3: Add per-task model overrides for routing config**

Add a `private taskOverrides = new Map<TaskType, string | null>();` field.

Add method:
```typescript
setTaskModel(task: TaskType, modelId: string | null): void {
  this.taskOverrides.set(task, modelId);
}
```

In `select()`, before the manual-mode check, add:
```typescript
const taskOverride = this.taskOverrides.get(taskType);
if (taskOverride !== undefined) {
  if (taskOverride === null) {
    // null means "auto for this task" — skip override
  } else {
    const model = this.models.find((m) => m.id === taskOverride);
    if (model) {
      const entry = this.providerMap.get(model.providerName);
      if (entry) {
        return { model, provider: entry.provider, reason: `routing.${taskType} override` };
      }
    }
  }
}
```

- [ ] **Step 4: Verify types compile**

```bash
npm run check-types
```

- [ ] **Step 5: Commit**

```bash
git add src/providers/smart-router.ts
git commit -m "fix: SmartRouter — 5s timeout, deduplicated onChange, per-task model overrides"
```

---

### Task 4: OpenAICompatibleProvider — withModel (D2)

**Files:**
- Modify: `src/providers/openai-compatible.ts`

- [ ] **Step 1: Add withModel after dispose()**

```typescript
withModel(modelId: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    { ...this.config, model: modelId },
    this.name,
  );
}
```

This covers LlamaCppProvider and VLLMProvider which both extend OpenAICompatibleProvider.

- [ ] **Step 2: Verify types compile**

```bash
npm run check-types
```

- [ ] **Step 3: Commit**

```bash
git add src/providers/openai-compatible.ts
git commit -m "feat: add withModel to OpenAICompatibleProvider (covers llamacpp + vllm)"
```

---

### Task 5: sample-configs — Onboarding Prerequisites (E5)

**Files:**
- Modify: `src/config/sample-configs.ts`

- [ ] **Step 1: Update Ollama onboarding description**

Change the `ollama-basic` description from:
```
"Privacy-first, no API key needed. Uses Ollama at localhost with qwen2.5-coder."
```
to:
```
"Privacy-first, no API key needed. Requires Ollama running locally — install from ollama.com, then run: ollama pull qwen2.5-coder:7b-instruct"
```

- [ ] **Step 2: Update llama.cpp description**

Change the `llamacpp` description to:
```
"Direct llama.cpp server connection. Requires llama-server running with: llama-server -m model.gguf --port 8080"
```

- [ ] **Step 3: Update vLLM description**

Change the `vllm-basic` description to:
```
"High-throughput local inference with vLLM. Requires: pip install vllm && vllm serve meta-llama/Llama-3.1-8B"
```

- [ ] **Step 4: Update Claude description**

Change to:
```
"Anthropic Claude via API. Requires an API key — run 'Champ: Set API Key' after setup."
```

- [ ] **Step 5: Commit**

```bash
git add src/config/sample-configs.ts
git commit -m "fix: onboarding — add prerequisite instructions to all template descriptions"
```

---

### Task 6: ChatViewProvider — Settings Gear Opens YAML (E6)

**Files:**
- Modify: `src/ui/chat-view-provider.ts`

- [ ] **Step 1: Change openSettingsRequest handler to open YAML config**

In `handleWebviewMessage`, find the `isOpenSettingsRequest` branch (around line 336):

Change:
```typescript
} else if (isOpenSettingsRequest(msg)) {
  void vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "champ",
  );
```
To:
```typescript
} else if (isOpenSettingsRequest(msg)) {
  // Try YAML config first; fall back to VS Code settings if no workspace.
  void vscode.commands.executeCommand("champ.generateConfig");
```

- [ ] **Step 2: Verify types compile**

```bash
npm run check-types
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/chat-view-provider.ts
git commit -m "fix: settings gear opens .champ/config.yaml instead of VS Code settings"
```

---

### Task 7: extension.ts — Large Refactor (C3 D1 E1 F1 F2 F3 + routing wiring)

**Files:**
- Modify: `src/extension.ts`

This is the biggest task. Changes are grouped into steps.

- [ ] **Step 1: Fix F3 — remove `as never` casts in createStubProvider**

In `createStubProvider`, the two generator functions use `yield { ... } as never`. Remove the casts:

```typescript
async *chat(): AsyncIterable<StreamDelta> {
  yield {
    type: "error" as const,
    error: "No LLM provider is configured. Click the Champ status bar item or run 'Champ: Settings' to choose a provider.",
  };
  yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } };
},
async *complete(): AsyncIterable<StreamDelta> {
  yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } };
},
```

Add `StreamDelta` to the import from `./providers/types` if not already there (check existing imports).

- [ ] **Step 2: Fix F2 — move inlineProviderRef before agentManager creation**

Move:
```typescript
const inlineProviderRef: { current: LLMProvider } = { current: stubProvider };
```
from its current position (~line 440) to immediately after `const stubProvider = createStubProvider("not-configured");` (~line 100), before the `agentManager` creation.

- [ ] **Step 3: Fix F1 — remove autoDetectModels()**

Delete the entire `autoDetectModels()` function (~lines 1299-1395).

Remove the `autoDetectModels()` call in `chatViewProvider.onWebviewReady`:
```typescript
// Remove this block:
if (cachedYamlConfig) {
  void autoDetectModels(cachedYamlConfig, provider, staticModels);
} else if ...
```

SmartRouter's `onChange` already handles model broadcasting — the duplicate is no longer needed.

- [ ] **Step 4: Fix D1 — register cloud providers with SmartRouter**

In the `loadProvider` function, in the SmartRouter registration block, add cloud providers even without `baseUrl`:

```typescript
// After the local providers loop, add cloud providers so they
// appear in the model picker even though they don't have a baseUrl.
const CLOUD_PROVIDERS = ["claude", "openai", "gemini"] as const;
for (const pName of CLOUD_PROVIDERS) {
  const pConf = yamlConfig?.providers?.[pName];
  if (!pConf || discoveredProviders?.has?.(pName)) continue;
  if (pName === newProvider.name) continue; // Already registered above
  try {
    const cloudProvider = await factory.createFromChampConfig(
      { ...yamlConfig!, provider: pName },
      context.secrets,
    );
    // Use a sentinel base URL so SmartRouter knows it's a cloud provider.
    // The provider's listModels() will be called; if no API key, it returns [].
    smartRouter.registerProvider(pName, cloudProvider, pName, undefined);
  } catch {
    // No API key or config — skip silently.
  }
}
```

Note: `SmartRouter.fetchModels()` already handles providers with no `baseUrl` — it returns early with `if (!baseUrl) return results;`. So cloud providers without baseUrl return no discovered models, but they're in the registry for status display purposes.

Actually, the SmartRouter's `fetchModels` returns early for empty `baseUrl`. For cloud providers we want them to show as configured (not offline) when an API key exists. The best approach: override `SmartRouter.onChange` behavior in extension.ts to include cloud providers from the config in the available list even if they have no discovered models.

Looking at the current `smartRouter.onChange` handler in extension.ts (~line 120), it already handles offline providers:
```typescript
if (cachedYamlConfig?.providers) {
  for (const [pName, pConf] of Object.entries(cachedYamlConfig.providers)) {
    if (!pConf || discoveredProviders.has(pName)) continue;
    available.push({
      providerName: pName,
      modelName: pConf.model ?? "default",
      label: `[offline] ${pConf.model ?? "default"} (${pName})`,
    });
  }
}
```

Cloud providers (claude, openai, gemini) appear as `[offline]` because they're not in `discoveredProviders`. The fix: cloud providers with a configured API key should not be marked `[offline]`. Change the label logic:

```typescript
// In smartRouter.onChange:
if (cachedYamlConfig?.providers) {
  for (const [pName, pConf] of Object.entries(cachedYamlConfig.providers)) {
    if (!pConf || discoveredProviders.has(pName)) continue;
    const isCloud = ["claude", "openai", "gemini"].includes(pName);
    available.push({
      providerName: pName,
      modelName: pConf.model ?? "default",
      label: isCloud
        ? `${pConf.model ?? "default"} (${pName})`
        : `[offline] ${pConf.model ?? "default"} (${pName})`,
    });
  }
}
```

- [ ] **Step 5: Wire routing config to SmartRouter (C1)**

In `loadProvider`, after creating the SmartRouter and before `void smartRouter.discover()`, add:

```typescript
// Apply routing config from YAML
if (yamlConfig?.routing) {
  const { mode, coding, chat, completion, embedding } = yamlConfig.routing;
  if (mode) smartRouter.setMode(mode);
  if (coding !== undefined) smartRouter.setTaskModel("coding", coding ?? null);
  if (chat !== undefined) smartRouter.setTaskModel("chat", chat ?? null);
  if (completion !== undefined) smartRouter.setTaskModel("completion", completion ?? null);
  if (embedding !== undefined) smartRouter.setTaskModel("embedding", embedding ?? null);
}
```

- [ ] **Step 6: Wire autocomplete.model from YAML to inline provider (C3)**

After `inlineProvider.setProvider(newProvider);` in `loadProvider`, add:

```typescript
// If autocomplete uses a different provider/model, create a dedicated
// inline provider for it.
if (yamlConfig?.autocomplete?.provider && yamlConfig.autocomplete.provider !== newProvider.name) {
  try {
    const acProvider = await factory.createFromChampConfig(
      { ...yamlConfig, provider: yamlConfig.autocomplete.provider },
      context.secrets,
    );
    const acModel = yamlConfig.autocomplete.model;
    const finalAcProvider = acModel && acProvider.withModel
      ? acProvider.withModel(acModel)
      : acModel
      ? (() => { // For providers without withModel, create fresh config
          const acConf = yamlConfig.providers?.[yamlConfig.autocomplete!.provider!];
          return factory.createFromChampConfig(
            { ...yamlConfig, provider: yamlConfig.autocomplete!.provider!, providers: { ...yamlConfig.providers, [yamlConfig.autocomplete!.provider!]: { ...acConf, model: acModel } } },
            context.secrets,
          );
        })()
      : Promise.resolve(acProvider);
    inlineProvider.setProvider(await finalAcProvider);
  } catch {
    // Autocomplete provider unavailable — fall back to main provider.
  }
} else if (yamlConfig?.autocomplete?.model && yamlConfig.autocomplete.model !== newProvider.config.model) {
  // Same provider, different model
  const acProvider = newProvider.withModel?.(yamlConfig.autocomplete.model);
  if (acProvider) inlineProvider.setProvider(acProvider);
}
```

- [ ] **Step 7: Fix E1 partial — setActiveModel also writes providers.{name}.model**

In the `champ.setActiveModel` command handler, after finding `match` from SmartRouter, also update the model in the YAML:

```typescript
if (match) {
  smartRouter.setManualModel(match.id);
  console.log(`Champ: manual model selection → ${match.id} (${providerName})`);
}
// ... existing YAML provider: line rewrite ...
// After writing the provider: line, also update providers.{providerName}.model:
const modelToWrite = match?.id ?? null;
if (modelToWrite) {
  const withModel = setProviderModelInYaml(updated, providerName, modelToWrite);
  if (withModel !== updated) {
    await vscode.workspace.fs.writeFile(yamlUri, new TextEncoder().encode(withModel));
    return; // file watcher fires loadProvider()
  }
}
await vscode.workspace.fs.writeFile(yamlUri, new TextEncoder().encode(updated));
```

Add the helper function at the bottom of the file:

```typescript
/**
 * Rewrite the model: line under a specific provider section in YAML.
 * Preserves comments and all other content. Returns text unchanged if
 * the provider section or model line is not found.
 */
function setProviderModelInYaml(
  yamlText: string,
  providerName: string,
  modelId: string,
): string {
  const lines = yamlText.split("\n");
  let inProvider = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Provider section header: "  providerName:" at 2-space indent
    if (/^\s{2}/.test(line) && line.trimStart().startsWith(`${providerName}:`)) {
      inProvider = true;
      continue;
    }
    if (inProvider) {
      // Stop at next top-level key or another 2-space provider
      if (line.length > 0 && !/^\s/.test(line)) break;
      if (/^\s{2}[^\s]/.test(line)) break;
      // Rewrite the model: line (any indentation ≥ 4)
      if (/^\s{4,}model:\s*/.test(line)) {
        lines[i] = line.replace(/^(\s+model:\s*).*$/, `$1${modelId}`);
        break;
      }
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 8: Verify types compile**

```bash
npm run check-types
```
Expected: no errors.

- [ ] **Step 9: Run tests**

```bash
npm test 2>&1 | tail -30
```
Expected: all tests pass (or same as before — no regressions).

- [ ] **Step 10: Commit**

```bash
git add src/extension.ts
git commit -m "fix: extension — cloud providers in picker, routing wiring, autocomplete model, model writes to YAML, remove duplicate detection"
```

---

## Self-Review

**Spec coverage:**
- B1 ✓ (Task 1 Step 1), B2 ✓ (Task 1 Step 2), B3 ✓ (Task 1 Step 3), B4 ✓ (Task 1 Step 4), B5 ✓ (Task 1 Step 5), B6 ✓ (Task 1 Step 6)
- C1 ✓ (Task 2 Steps 1-3, Task 3 Step 3, Task 7 Step 5), C2 ✓ (Task 2 Step 4), C3 ✓ (Task 7 Step 6), C4 ✓ (Task 2 Step 5), C5 ✓ (Task 2 Step 6), C6 ✓ (Task 5 Steps 1-5)
- D1 ✓ (Task 7 Step 4), D2 ✓ (Task 4), D3 ✓ (Task 3 Step 1), D4 ✓ (Task 3 Step 2)
- E1 partial ✓ (Task 7 Step 7), E5 ✓ (Task 5), E6 ✓ (Task 6)
- F1 ✓ (Task 7 Step 3), F2 ✓ (Task 7 Step 2), F3 ✓ (Task 7 Step 1)

**Not addressable without webview source:** E2, E3, E7

**Placeholders scan:** None found — all steps have concrete code.
