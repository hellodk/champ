# Core Interfaces & System Prompts Reference

Summary of public module contracts and prompt templates. Exhaustive TypeScript definitions live in the linked `src/` files.

## Index

1. [LLM Providers & Endpoint Registry](#llm-providers--endpoint-registry)
2. [Tools & Agent Loop](#tools--agent-loop)
3. [Skills, Rules, Checkpoints & Safety](#skills-rules-checkpoints--safety)
4. [Webview Protocol](#webview-protocol)
5. [System Prompts](#system-prompts)

---

## LLM Providers & Endpoint Registry

- **`LLMProvider` (`src/providers/types.ts`)**: `name`, `config: LLMProviderConfig`, `chat(messages, options?)`, `complete(prompt, options?)`, `supportsToolUse()`, `supportsStreaming()`, `countTokens(text)`, `modelInfo()`, `dispose()`.
- **`StreamDelta`**: `{ type: "text" | "tool_call" | "usage" | "done" | "error", ... }` (tool deltas carry `id`, `name`, `arguments`, `index`).
- **`EndpointRepository` & `EndpointRegistry` (`src/config/provider-model.ts`, `provider-repository.ts`, `endpoint-registry.ts`)**: manages `Endpoint` (`id`, `name`, `provider: ProviderKind`, `baseUrl`, `credential: CredentialRef`, `enabled`, `isDefault`, `supportsTools`, `contextWindow`, `models[]`), `ProvidersDocument` (`version: 1`, `endpoints`, `assignments`, `routingMode`), atomic locked R/W, `discover(id)`, `test(id)`, `resolveAssignment(task)`.
- **`CredentialStore` (`src/config/credential-store.ts`)**: `ChainCredentialStore`, `EnvCredentialStore`, `VsCodeSecretCredentialStore` (`get`, `set`, `delete`, `unavailableReason`).
- **`ProviderFactory` (`src/providers/factory.ts`)**: `createFromChampConfig(config, secrets)` and `createFromEndpoint(endpoint, { model, secretProvider, contextWindow? })`.
- **`SmartRouter` (`src/providers/smart-router.ts`)**: `registerProvider`, `discover()`, `select(taskType: "coding" | "chat" | "completion" | "embedding")`, `setMode`, `setTaskModel`, `setRoutingRules`.

---

## Tools & Agent Loop

- **`Tool` & `ToolRegistry` (`src/tools/types.ts`, `src/tools/registry.ts`)**: `name`, `description`, `parameters` (JSON Schema), `requiresApproval`, `execute(args, context)`, `getPreview?(args)`, `register`, `unregister`, `execute`.
- **`AgentController` (`src/agent/agent-controller.ts`)**: `processMessage(userMessage, options)`, `setMode(mode: "agent" | "ask" | "manual" | "plan" | "composer")`, `setProvider`, `setProjectRules`, `setRepoMapProvider`, `setMemoryBank`, `getHistory`, `setHistory`, `reset`.
- **`MultiAgentRunner` & `AgentOrchestrator` (`src/agent/multi-agent-runner.ts`, `orchestrator.ts`)**: `DAGNode` (`name`, `condition?(memory)`, `next?(output, memory)`), `SharedMemory` (`getOutput`, `set`, pub/sub channels).
- **`TeamRunner` (`src/agent/team-runner.ts`)**: runs YAML DAG definitions, `resumeFromCheckpoint`, token budgets, `BLOCKED`/`SPAWN` protocols.

---

## Skills, Rules, Checkpoints & Safety

- **Skills (`src/skills/types.ts`, `skill-loader.ts`, `skill-registry.ts`, `variable-resolver.ts`)**: `SkillFrontmatter` (`name`, `description`, `trigger?`, `mode?`, `allowedTools?`), `SkillLoader.parseFile`, `SkillRegistry` (workspace > user > built-in), `VariableResolver.resolve(template, context)`.
- **Rules (`src/rules/rules-engine.ts`)**: `always`, `auto-attached` (glob match), `agent-requested`; `loadRulesFromDirectory`, `setUserRules`, `getActiveRules`.
- **Checkpoints (`src/checkpoints/checkpoint-manager.ts`)**: `create(label, files)`, `restore(id)`, `list()`, `prune`.
- **Safety (`src/safety/`)**: `CommandSandbox`, `SecretScanner`, `PiiScanner`, `PromptGuard`, `AuditLog`.
- **Sessions (`src/session/session-log.ts`)**: `SessionLog.create`, `SessionLog.open`, `append`, `markCheckpoint`, `compact`, `replay`.

---

## Webview Protocol

Discriminated unions in `src/ui/messages.ts` handled by `ChatViewProvider` (`src/ui/chat-view-provider.ts`) and tested in `test/e2e/webview-protocol.test.ts`:
- Chat/turn messages (`sendMessage`, `cancelRequest`, `streamDelta`, `toolApprovalRequest/Response`, `setMode`, `setModel`)
- Session/history/memory (`sessionList`, `switchSession`, `newSession`, `deleteSession`, `renameSession`, `memoryBadge`, `memoryList`, `memoryPin`, `memoryDelete`, `memoryAdd`)
- Onboarding, diffs, MCP, and workflows (`firstRunWelcome`, `attachFile`, `diffHunkAction`, `mcpStatus`, `teamPause`, `teamResume`, `rerunTeam`)

---

## System Prompts

Assembled cleanly in `src/prompts/system-prompt.ts`, `src/agent/system-prompt-builder.ts`, and `src/providers/prompt-based-tools.ts`:

1. **Base System Prompt**: environment context (`os`, `workspaceName`, workspace root, active file/branch), tool capabilities, verify-before-claim and anti-fabrication directives.
2. **Rules Injection**: Global `userRules` → Project `.champ/rules/*.md` (`always` + glob-matched `auto-attached`).
3. **Mode Append**:
   - `agent`: autonomous tool execution; inspect before edit; iterate on errors.
   - `ask`: read-only tools only; explain without modifying files.
   - `manual`: propose actions and wait for explicit approval at each step.
   - `plan`: read-only research outputting numbered implementation steps.
   - `composer`: multi-file `<relative-file-path>` structured diffs for review.
4. **Prompt-Based Tool Calling Template** (when `supportsToolUse() === false`): injects tool schemas plus `<tool_call><name>...</name><arguments>{...}</arguments></tool_call>` instructions and parses `<tool_result>` blocks cleanly alongside `hasFabricatedNarration()` detection.
5. **Per-Agent Prompts** (`planner`, `context`, `code`, `reviewer`, `validator`, and custom `.champ/agents/*.md`): focused single-responsibility templates reading/writing typed keys in `SharedMemory`.
