# PLAN: Skills and project rules in the headless CLI

**Status:** ready to implement — decisions locked 2026-11-15.
**Scope:** `src/cli.ts`, `src/cli/**`, tests, docs.
**Explicitly not in scope:** any behaviour change in the VS Code extension.
**Related:** `docs/PLAN_SKILLS.md` (extension-side design), `docs/INSTALLATION_AND_USAGE.md` (user guide).

This document is written to be handed to an implementing agent. Read §1 and §2 first, then
implement §5 in order (A → B → C → D), tests before implementation in every increment.
§6 is the behavioural contract, §7 the commands, §8 the commits, §9 the guardrails.

**Do not re-litigate §1.** Those are decisions, with the rejected alternative recorded so the
implementer does not "improve" them by accident.

---

## 1. Locked decisions

### 1.1 Answers to the three open questions

| Question | Decision | Why |
|---|---|---|
| How does the CLI learn `currentFile`? | **`--file <path>` only. No heuristic.** | Rules with `glob` and `{{currentFile}}` must be deterministic. A heuristic that guesses a path out of prose can silently attach the *wrong* rules — worse than the user typing one flag. `--file` is also trivially testable and works for both one-shot and REPL. |
| Enforce `allowedTools`? | **Yes, in the CLI only** (scope-and-restore on the tool registry the CLI owns). | Two reasons. (a) A 4B model on a 16 GB box benefits measurably from a shorter tool schema: fewer tokens per iteration and fewer wrong tool picks. (b) Skill authors already write `allowedTools`; leaving it dead means a skill that declares "read only" still gets `edit_file`. Enforcement is ~30 lines and fully unit-testable with the existing `ToolRegistry.unregister/register` API. A skill that declares only tools the CLI lacks gets **zero** tools (and a warning) — never the full set, which is the dangerous direction. |
| Add terminal/git tool parity now? | **No.** Follow-up issue only (§12). | `run_terminal_cmd` is arbitrary code execution driven by a local model; that is a security decision bigger than this feature. `/commit` is documented as degraded in the CLI. A narrow read-only `git_status`/`git_diff` follow-up is proposed instead. |

Known consequence of the second decision: `/review` may be more restricted in the terminal than
in chat, because the extension never enforced `allowedTools`. Only ever *narrower*, never wider —
the safe direction. Recorded as a follow-up in §12.

### 1.2 Implementation decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | New module `src/cli/skills.ts` owns loading + invocation resolution; `src/cli.ts` only wires it. | Inlining in `src/cli.ts` (~750 lines already) — untestable without spawning a process. |
| D2 | New module `src/cli/rules.ts` owns rule loading + prompt assembly. | Calling `RulesEngine` directly from the REPL loop. |
| D3 | Load order `built-in → workspace → user`; precedence via `SOURCE_RANK`. | Sorting by directory order (the registry already ranks sources; order is irrelevant to the result). |
| D4 | Disk reads use Node `fs`, never `vscode.workspace.fs`. | Importing `vscode` — the CLI entry is bundled without `--external:vscode`. |
| D5 | One invalid skill/rule file → stderr warning, continue. | Aborting startup on a typo. |
| D6 | Empty template body → skip + warning. | Registering it; `SkillLoader` does not validate the body, so it would send an empty user message. |
| D7 | `trigger` stays ignored; lookup is by `metadata.name`. | Honouring `trigger` in the CLI only, which would make `/xp` work in the terminal but not in chat. |
| D8 | `allowedTools` enforced, save/restore in `finally`. | Hard-failing when the intersection is empty. A skill that declares only `run_terminal_cmd` must not get write tools. |
| D9 | Skill `mode` applies to that turn only, restored in `finally`. | Leaving it applied — `/explain` would silently make the rest of the session read-only. |
| D10 | Rules content recomputed at turn start. | Computing once at boot — `auto-attached` rules depend on the file. |
| D11 | Expansion happens **before** `runTurn`, so the session log stores the expanded prompt. | Logging `/review` only — resumed history must match what the model actually saw. |
| D12 | One `resolveInvocation()` shared by one-shot and REPL. | REPL-only slash commands — surprising asymmetry, two code paths to test. |
| D13 | `--no-skills` kill switch. | Nothing — needed for hermetic tests and for escaping a broken workspace skill dir. |

---

## 2. Verified baseline (facts, with evidence)

Everything below was checked in the working tree at `a477c05`. Line numbers may drift; the
symbol names will not.

| Fact | Evidence |
|---|---|
| The CLI import graph contains **zero** skill/rules modules | 39-file walk from `src/cli.ts`; 0 hits under `src/skills/`, `src/rules/` |
| Skills are wired only in the extension | `src/extension.ts:918-966`, `src/ui/chat-view-provider.ts:1185-1214` |
| `.champ/rules` loads only at extension activation | `src/extension.ts:3401-3417` |
| `userRules` reaches the agent only via the extension | `src/extension.ts:3410-3412` → `AgentController.setProjectRules` |
| The CLI reads exactly one config file | `configPath()` `src/cli.ts:100` (`~/.champ/config.yaml` or `CHAMP_CONFIG`), `resolveLayered` at `:121` — workspace YAML is never read |
| REPL has 6 commands, no skill path | `src/cli.ts:462-508`; unknown → `unknown command …` |
| Per-turn mode switching is effective | `systemPromptBuilder.invalidateCache()` at `src/agent/agent-controller.ts:520` runs at the start of **every** `processMessage`; `filterToolsByMode` at `:528` is per-message |
| `ask`/`plan` restrict to read-only tools | `READ_ONLY_TOOLS` `src/agent/agent-controller.ts:101-108` (`read_file`, `list_directory`, `grep_search`, `file_search`, `codebase_search`, `web_search`) |
| `allowedTools` is parsed and never enforced | parsed `src/skills/skill-loader.ts:111-120`; zero consumers in `src/` |
| `trigger` is parsed and never consulted | `SkillRegistry.get` matches `metadata.name` (`src/skills/skill-registry.ts:47`); `matchPrefix` matches names only |
| The controller's tool registry is immutable after construction | `private readonly toolRegistry` `src/agent/agent-controller.ts:165-168`; no setter |
| The registry itself can be mutated | `ToolRegistry.register` / `unregister` / `getAll` — `src/tools/registry.ts:67-85` |
| CLI registers 7 fs tools | `src/tools/headless/fs-tools.ts:715-723` |
| CLI has no terminal, git, MCP, or codebase tools | 22 tools registered in the extension; 7 in `createHeadlessToolRegistry()` |
| Built-in `commit` declares only `run_terminal_cmd` | `src/skills/built-in.ts:126` |
| Built-in `fix` declares `run_terminal_cmd` among others | `src/skills/built-in.ts:175` |
| `SkillLoader.parseFile(text, source, filePath?)` is strict and throws | `src/skills/skill-loader.ts:72-131` |
| `VariableResolver.resolve(template, context)` — unknown placeholders left intact | `src/skills/variable-resolver.ts:47-60` |
| `SkillContext` fields | `workspaceRoot`, `date` (required); `selection`, `currentFile`, `language`, `userInput`, `cursorLine`, `branch` (optional) |
| `AgentMode` = `agent \| ask \| manual \| plan \| composer` | `src/agent/agent-controller.ts:96` |
| `RuleContext.mode` is a plain `string`, not `AgentMode` | `src/rules/rules-engine.ts:39-44` |
| `RulesEngine` API to use | `loadRulesFromDirectory`, `setUserRules`, `getActiveRules` (`:122`, `:103`, `:187`) |
| Test harness helpers | `test/helpers/cli-harness.ts`: `buildCli`, `frames`, `makeWorkspace`, `removeWorkspace`, `runCli`, `startMockOpenAI`, `writeChampConfig` |
| `USAGE` is asserted in a unit test | `test/unit/cli/args.test.ts:43-47` — adding lines is safe, removing them is not |

Two facts that shape the design:

1. **`/commit` and `/fix` cannot fully work headless.** Their templates assume `run_terminal_cmd`
   (git diff, LSP); `/commit` is also `mode: ask`, so even with the tool present it would be
   filtered out. This plan documents the degradation instead of shipping silently broken skills.
2. **There is no editor.** `{{selection}}`, `{{cursorLine}}` resolve to `""` in a terminal.
   `--file` gives `{{currentFile}}` and `{{language}}` real values; the rest is warned about.

---

## 3. Target user-visible behaviour

```bash
# REPL
champ
champ> /skills                        # list skills + where each came from
champ> /review src/auth/token.ts      # expand template, run one turn
champ> /explain                       # mode: ask for this turn only, then restore

# One-shot — same slash syntax, no REPL
champ -y "/review src/auth/token.ts"

# Script-friendly alias, identical semantics
champ -y --skill review "src/auth/token.ts"

# No model needed
champ --list-skills

# Escape hatch
champ --no-skills -y "just answer the question"

# Rules are automatic, no flag required
#   <cwd>/.champ/rules/*.md      (committed, team)
#   userRules: from ~/.champ/config.yaml (personal)
```

Precedence for same-named skills: **workspace > user > built-in**.
Reserved meta commands always win: a skill named `help` must never shadow `/help`.

Exit codes are unchanged: `0` success, `1` agent/provider error, `2` usage/config error.

---

## 4. Architecture

```
main()                                  src/cli.ts
 ├─ parseCliArgs                       src/cli/args.ts       (new flags)
 ├─ --list-skills → print & exit 0     src/cli/skills.ts     (no provider needed)
 ├─ buildConfig / provider / controller
 ├─ loadCliRules({ workspaceRoot, userRules })  src/cli/rules.ts
 ├─ loadCliSkills({ workspaceRoot, skipDisk })   src/cli/skills.ts
 ├─ REPL:  meta commands → /skills → resolveInvocation → runSkillTurn
 └─ one-shot:  resolveInvocation(task) → runSkillTurn
                     │
                     └─ applyAllowedTools(toolRegistry, skill.allowedTools)   src/cli/tool-scope.ts
                        controller.setMode(skill.mode ?? current)
                        controller.setProjectRules(rulesPrompt(engine, {mode, currentFile}))
                        runTurn(...)
                        finally: scope.restore(); setMode(previous); setProjectRules(previousPrompt)
```

Why `runSkillTurn` is a wrapper and not a change to `runTurn`: `runTurn` is the streaming/summary
surface (`src/cli.ts:242-320`) and is already covered by tests. Skill scoping is orthogonal;
keeping it outside means zero risk to the existing turn path.

`dist/cli.js` is an esbuild bundle of everything reachable from `src/cli.ts`. All new imports are
**static**, so the new modules are bundled automatically. No `package.json`, `.npmignore`, or
`.vscodeignore` change is required.

---

## 5. Increments

House rule for every increment: **acceptance criteria → failing test → implementation → suite
green → commit.** Do not batch increments into one commit.

### Increment A — project + user rules reach the CLI

**Goal:** a `.champ/rules/*.md` file and `userRules:` change what the CLI sends to the model.

**New file: `src/cli/rules.ts`**

```ts
import { RulesEngine } from "../rules/rules-engine";

export interface CliRulesOptions {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** `userRules` from the effective config file, if any. */
  userRules?: string;
}

export async function loadCliRules(opts: CliRulesOptions): Promise<RulesEngine>;

/** Always + user rules + glob-matched rules for the given file. */
export function rulesPrompt(
  engine: RulesEngine,
  ctx: { mode: string; currentFile?: string },
): string;
```

Behaviour:

1. `new RulesEngine(workspaceRoot)`.
2. `await engine.loadRulesFromDirectory(path.join(workspaceRoot, ".champ", "rules"))` — this is
   already ENOENT-safe (`src/rules/rules-engine.ts:122-130`) and already guards path traversal.
3. If `userRules?.trim()` → `engine.setUserRules(userRules)`.
4. Do **not** rethrow; a malformed directory result is not fatal. If `loadRulesFromDirectory`
   throws a non-ENOENT error, log `[champ] rules: <message>` to stderr and continue with an empty
   project-rule set.
5. `rulesPrompt` = `engine.getActiveRules({ mode, currentFile }).map(r => r.content).join("\n\n")`.
   Empty result → `""`.

**Wiring in `src/cli.ts`**

- After the controller is constructed (`:593-598`), before session restore:
  `const rulesEngine = await loadCliRules({ workspaceRoot: workspace, userRules: config.userRules })`.
- Before **every** `runTurn`, call
  `controller.setProjectRules(rulesPrompt(rulesEngine, { mode: controller.getMode(), currentFile }))`.
  Do this for plain turns too, not just skill turns — otherwise a REPL `/explain` (mode `ask`)
  followed by a plain turn would keep the wrong rule set.
- `currentFile` comes from `--file`, normalized by `buildSkillContext` (§C) and reused.

**`--file <path>`** (parsed in increment C, used here): if the path resolves inside the workspace,
pass `path.relative(workspace, file)` to `getActiveRules` — globs are matched against
workspace-relative paths (`src/rules/rules-engine.ts:224-228`). Outside the workspace, pass the
path as given and add a note.

**Tests first — `test/unit/cli/rules.test.ts`** (temp dirs via `fs.mkdtemp`)

- `loadCliRules` → returns an engine with no rules when `.champ/rules` is missing
- `loadCliRules` → loads an `always` rule
- `loadCliRules` → appends `userRules` even with no rules directory
- `loadCliRules` → skips one malformed rule file and keeps the valid ones
- `rulesPrompt` → includes a glob rule only when `currentFile` matches
- `rulesPrompt` → excludes `agent-requested` rules
- `rulesPrompt` → joins two rules with exactly one blank line
- `rulesPrompt` → returns `""` when nothing is active

**Acceptance criteria**

- AC-A1: `always` rule text appears in the outbound request's system message (proved in
  increment D's integration test).
- AC-A2: an `auto-attached` rule activates only when `--file` matches its `glob`.
- AC-A3: behaviour is byte-identical to today when `.champ/rules` is absent and `userRules` is unset.

---

### Increment B — skill loading

**Goal:** 8 built-ins + workspace + user skills are available in the CLI, with documented
precedence, and a broken file never kills the process.

**New file: `src/cli/skills.ts`** (loading half; dispatch lands in increment C)

```ts
import type { Skill } from "../skills/types";
import type { AgentMode } from "../agent/agent-controller";
import { SkillRegistry } from "../skills/skill-registry";

export interface CliSkillsOptions {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Injected in tests; defaults to os.homedir(). */
  homeDir?: string;
  /** `--no-skills`: register built-ins only. */
  skipDisk?: boolean;
  /** Overrides the workspace skills dir (tests). */
  workspaceSkillsDir?: string;
}

export interface LoadedCliSkills {
  registry: SkillRegistry;
  /** Human-readable problems, one per skipped file/collision. */
  problems: string[];
}

/**
 * Meta commands that always win over a same-named skill.
 * Bare names, no leading slash: "help", "exit", "quit", "q",
 * "session", "sessions", "checkpoint", "compact", "skills".
 */
export const RESERVED_COMMANDS: ReadonlySet<string>;

export function loadCliSkills(opts: CliSkillsOptions): LoadedCliSkills;
```

Behaviour:

1. Register built-ins from `BUILT_IN_SKILL_TEXTS`: `SkillLoader.parseFile(text, "built-in")`.
   A throw here is a programming error, but still catch → `problems`.
2. Unless `skipDisk`, load, in this order: `<workspaceRoot>/.champ/skills` (source `"workspace"`),
   then `<homeDir>/.champ/skills` (source `"user"`). Order is cosmetic; `SkillRegistry.register`
   enforces `built-in < user < workspace` (`src/skills/skill-registry.ts:14-18`).
3. Per directory: `readdirSync`; `ENOENT` → skip silently; other errors → one `problems` entry.
   Only `.md` files, regular files only.
4. Per file: `readFileSync(utf8)` → strip a leading UTF-8 BOM → `SkillLoader.parseFile(text, source, filePath)`.
5. If `skill.template.trim() === ""` → skip, `problems.push("${filePath}: empty skill body")`.
6. If `metadata.name` (or its `/name` form) collides with `RESERVED_COMMANDS` → register anyway but
   `problems.push("skill '<name>' is shadowed by the built-in /<name> command")`. Rationale: the file
   may be intentional for the extension; the CLI just never dispatches it.
7. Any parse error → `problems.push("${filePath}: ${message}")`, continue.
8. Never throw for disk problems.

**Wiring in `src/cli.ts`**

- `const skills = loadCliSkills({ workspaceRoot: workspace, skipDisk: flags.noSkills })`
- Print each problem once, before the first turn: `[champ] skill ignored: <problem>` (nothing when
  the list is empty — a clean run must stay quiet).
- Store on the shared options object passed to `runRepl` (extend `SessionOptions` at `:222`).

**Tests first — `test/unit/cli/skills.test.ts`**

- `loadCliSkills` → registers the eight built-ins by name
- `loadCliSkills` → workspace skill overrides a built-in of the same name
- `loadCliSkills` → user overrides built-in, workspace overrides user (three files, one name)
- `loadCliSkills` → reports invalid YAML in `problems` without throwing
- `loadCliSkills` → reports a missing `description` in `problems`
- `loadCliSkills` → skips an empty body and reports it
- `loadCliSkills` → ignores non-markdown files
- `loadCliSkills` → reports a reserved-name collision (`help.md`)
- `loadCliSkills` → strips a UTF-8 BOM before parsing
- `loadCliSkills` with `skipDisk` → built-ins only
- `loadCliSkills` → never reads the real `~` (assert by passing `homeDir`; no test may touch the
  developer's home directory)

**Acceptance criteria**

- AC-B1: the 8 built-ins are always available.
- AC-B2: workspace > user > built-in for the same name, proved by three same-named files.
- AC-B3: an invalid file produces one warning line and the process still runs.

---

### Increment C — dispatch, tool scoping, and new flags

**Goal:** `/<skill> args` works in one-shot and REPL, `--skill`/`--list-skills`/`--file`/
`--no-skills` exist, and `allowedTools`/`mode` are scoped to the turn.

#### C.1 `src/cli/skills.ts` — dispatch half

```ts
export type InvocationResolution =
  | { kind: "skill"; invocation: ResolvedInvocation }
  | { kind: "reserved" }                       // /help, /exit, …
  | { kind: "unknown"; name: string; suggestions: string[] }
  | { kind: "none" };                          // no leading slash

export interface ResolvedInvocation {
  skill: Skill;
  /** Template with {{variables}} substituted. */
  prompt: string;
  /** Everything after the skill name. */
  userInput: string;
  mode?: AgentMode;
  /** Non-fatal notes for stderr (never sent to the model). */
  notes: string[];
}

export function resolveInvocation(
  registry: SkillRegistry,
  text: string,
  context: SkillContext,
): InvocationResolution;

export function buildSkillContext(
  workspaceRoot: string,
  userInput: string,
  opts?: { file?: string },
): { context: SkillContext; notes: string[] };

export function formatSkillList(registry: SkillRegistry): string;
```

Rules:

1. Matching regex must be **exactly** the extension's, so behaviour cannot drift:
   `/^\/([A-Za-z][\w-]*)\s*(.*)$/s` (`src/ui/chat-view-provider.ts:1193`).
2. No match → `{ kind: "none" }`.
3. Bare captured name in `RESERVED_COMMANDS` → `{ kind: "reserved" }`, **before** any registry
   lookup, so a skill named `help` can never shadow `/help`.
4. `registry.get(name)` miss → `{ kind: "unknown" }` with up to 3 suggestions: first
   `registry.matchPrefix(name)`, then case-insensitive substring matches on the name. Never more
   than 3, deduplicated.
5. Hit → substitute with `VariableResolver.resolve(skill.template, context)`.
6. `mode` = `skill.metadata.mode` (already validated against `VALID_MODES` by the loader).
7. `notes` (all optional, at most 2 lines):
   - editor-only placeholders that resolve empty: scan `skill.template` for `{{selection}}`,
     `{{currentFile}}`, `{{cursorLine}}`, `{{language}}`; for each whose context value is empty, add
     a note. Single message form:
     `[skills] /doc: {{selection}} is empty — the CLI has no editor. Pass the code as arguments.`
     If `currentFile` or `language` is implicated, append `or use --file <path>.`
   - `--file` outside the workspace: `[skills] --file is outside the workspace; glob rules will not match it.`
8. `formatSkillList` output (stable order: name ascending, then source):

```
[champ] skills (workspace > user > built-in)
  /commit     ask    built-in   Generate a Conventional Commits message from staged changes
  /acme-docs  agent  workspace  House docs conventions
```

Pad the name and mode columns to the widest entry. Sort by name ascending. Show
`skill.metadata.mode ?? "agent"`. Print the source verbatim (`built-in`, `user`, `workspace`) so an
override is visible. If the registry is empty (impossible in practice — built-ins always load)
print `[champ] no skills registered`.

`buildSkillContext`:

- `workspaceRoot`: the resolved `--cwd`.
- `date`: `new Date().toISOString().slice(0, 10)` (matches `src/extension.ts:4785`).
- `userInput`: passed in.
- If `opts.file`: `currentFile` = workspace-relative when inside the workspace, else as given;
  `language` = `languageForFile(file)`.
- `selection` and `cursorLine`: **omitted** (resolve to `""`).
- `branch`: omitted in v1 (spawning git per turn is not worth it; `{{branch}}` resolves empty).

`languageForFile` — a small static map, no file IO, no dependency:
`.ts→typescript`, `.tsx→typescriptreact`, `.js→javascript`, `.jsx→javascriptreact`,
`.py→python`, `.go→go`, `.rs→rust`, `.java→java`, `.rb→ruby`, `.cs→csharp`, `.php→php`,
`.md→markdown`, `.json→json`, `.yaml/.yml→yaml`, `.sh→bash`, `.c→c`, `.h→c`,
`.cpp/.cc/.hpp→cpp`, `.css→css`, `.html→html`, `.sql→sql`. Unknown → `undefined`.
Keep this list in the doc and the code identical; do not add heuristics.

#### C.2 `src/cli/tool-scope.ts` — enforce `allowedTools`

```ts
import type { ToolRegistry } from "../tools/registry";

export interface AppliedToolScope {
  /** Re-register every tool that was present before filtering. Idempotent. */
  restore(): void;
  /** Declared tools this CLI does not have. */
  missing: string[];
}

export function applyAllowedTools(
  registry: ToolRegistry,
  allowedTools?: readonly string[],
): AppliedToolScope;
```

Algorithm:

1. `allowedTools` undefined or empty → `{ restore: () => {}, missing: [] }` (no-op).
2. `saved = registry.getAll()`; `available = new Set(saved.map(t => t.name))`.
3. `missing = allowedTools.filter(n => !available.has(n))`.
4. `wanted = new Set(allowedTools.filter(n => available.has(n)))`.
5. `saved.filter(t => !wanted.has(t.name)).forEach(t => registry.unregister(t.name))`.
6. `restore()` re-registers every `saved` tool (safe to call twice).

Expected outcomes to encode as tests:

| Skill | `allowedTools` | Available in CLI | Tools for the turn |
|---|---|---|---|
| `explain` | read_file, grep_search, file_search | all 3 | 3 (all read-only) |
| `fix` | read_file, grep_search, edit_file, run_terminal_cmd | 3 of 4 | 3, `missing = ["run_terminal_cmd"]` |
| `commit` | run_terminal_cmd | none | **0**, `missing = ["run_terminal_cmd"]` |
| custom | `["read_file"]` | yes | 1 |

A zero-tool turn is correct and intentional (see §1.1). The caller must always print the `missing`
warning, in one of exactly two forms:

```
# some declared tools exist in the CLI
[skills] /fix: declared tools not available in the CLI: run_terminal_cmd (ignored).
# none do
[skills] /commit: declared tools not available in the CLI: run_terminal_cmd — the turn runs with no tools.
```

#### C.3 `src/cli/args.ts` — flags

`CliFlags` gains:

```ts
skill?: string;      // --skill <name>
file?: string;       // --file <path>
listSkills: boolean; // --list-skills
noSkills: boolean;   // --no-skills
```

`VALUE_FLAGS` gains `"--skill": "skill"`, `"--file": "file"`.
Boolean parsing gains `--list-skills` and `--no-skills`.
The `switch (valueKey)` in `parseCliArgs` (`:192-219`) needs `case "skill"` and `case "file"`.

Validation, all returning `error(...)` → exit code 2:

- `--skill` must match `/^[A-Za-z][\w-]*$/` → `--skill must be a skill name like "review", got "…"`.
- `--skill` + `--repl` → `--skill cannot be combined with --repl (use /<skill> inside the REPL)`.
- `--skill` + a positional that starts with `/` → `give the skill either with --skill or /<name>, not both`.
- `--list-skills` + `--repl` → `cannot combine --list-skills with --repl`.
- `--list-skills` + a task → `cannot combine --list-skills with a task` (mirror the `--sessions` rule at `:222-232`).

Mode resolution (`:236-260`), in order:

1. `--list-skills` → return `{ kind: "list-skills", cwd: flags.cwd }`. New `CliParseResult` variant,
   same shape as `sessions`.
2. `--skill` present and not `--repl` → `mode = "oneshot"`, `task = positionals.join(" ")`
   (possibly `""`), and **never** fall through to `stdin` mode — `champ --skill review` on piped
   stdin must not block waiting for input.
3. Otherwise unchanged.

`USAGE` (`src/cli/args.ts:58-89`) gains, under the flags block:

```
  --skill <name>          Run a skill (same as /<name>) in one-shot mode
  --file <path>           The file skills and glob rules should assume
  --list-skills           Print available skills and exit
  --no-skills             Ignore workspace/user skill directories
```

and under commands:

```
  /skills                 List available skills
  /<skill> [args]         Run a skill (e.g. /review src/a.ts)
```

#### C.4 `src/cli.ts` — wiring

1. Hoist the registry so it is addressable:
   `const toolRegistry = createHeadlessToolRegistry();` then pass it to `AgentController`.
2. `--list-skills` early exit goes **immediately after** the `sessions` exit (`:554-558`) and
   **before** `readStdin()` — otherwise it blocks on piped input. Print
   `formatSkillList(loadCliSkills({...}).registry)` to stdout, return `EXIT_OK`; warnings to stderr.
   It must work with an unreachable model endpoint (no provider is constructed).
3. Compute the invocation for one-shot:
   - `flags.skill` → synthesize `"/" + flags.skill + (task ? " " + task : "")` then
     `resolveInvocation(...)`.
   - else `resolveInvocation(registry, task, context)`.
   - `kind: "skill"` → run `runSkillTurn`; `kind: "unknown"` → `fail(...)` with the suggestion line
     (exit 2, no model call); `kind: "none"` → today's behaviour exactly.
   - `task === ""` and `flags.skill` → allowed; `{{userInput}}` resolves to `""`.
     `task === ""` without `--skill` keeps today's `fail("no task given and nothing on stdin")`.
4. `runSkillTurn(controller, toolRegistry, rulesEngine, skills, invocation, ctx, opts)`:
   ```
   const scope = applyAllowedTools(toolRegistry, invocation.skill.metadata.allowedTools)
   warnMissing(scope.missing, invocation.skill.metadata.name)
   const previousMode = controller.getMode()
   try {
     if (invocation.mode) controller.setMode(invocation.mode)
     controller.setProjectRules(rulesPrompt(rulesEngine, { mode: controller.getMode(), currentFile }))
     return await runTurn(controller, invocation.prompt, opts)
   } finally {
     scope.restore()
     controller.setMode(previousMode)
     controller.setProjectRules(rulesPrompt(rulesEngine, { mode: previousMode, currentFile }))
   }
   ```
   Restore order is fixed so the tests are deterministic. `finally` matters: Ctrl-C or a provider
   error mid-turn must not leave the session in `ask` mode or with missing tools.
5. REPL dispatch inside the existing `if (trimmed.startsWith("/"))` block (`:462`). **Trap:**
   today's `switch` has a `default:` that prints `unknown command` and `continue`s, so appending
   code *after* the switch is unreachable. Either add `case "/skills":` to the switch and do skill
   dispatch in the `default:` branch, or restructure the switch into sequential `if` checks. Order:
   1. `/exit|/quit|/q`
   2. today's meta cases (`/help`, `/session`, `/sessions`, `/checkpoint`, `/compact`)
   3. `case "/skills"` → `process.stderr.write(formatSkillList(registry) + "\n")` (stderr, like the
      other meta output; stdout stays reserved for model text)
   4. `default` → `resolveInvocation`: `skill` runs a turn; `unknown` prints
      `[champ] unknown command /nope — /help for the list` plus
      `[champ] did you mean: /review, /refactor` when suggestions exist; `reserved` and `none` fall
      through to the existing unknown-command message (defensive — the meta cases already handled
      the reserved ones).
   5. Print `notes` from `buildSkillContext` **and** `invocation.notes` to stderr, merged, before
      the turn starts.
6. `SessionOptions` gains `registry: SkillRegistry`, `rules: RulesEngine`, `toolRegistry: ToolRegistry`,
   `file?: string` (all required except `file`), so `runRepl` needs no globals.
7. Expansion happens before `runTurn`, so the session log records the expanded prompt (D11). This
   is intentional: resumed history must match what the model saw.

**Tests first — `test/unit/cli/skill-dispatch.test.ts`**

- `resolveInvocation` → expands `{{userInput}}`
- `resolveInvocation` → leaves an unknown `{{nope}}` placeholder intact
- `resolveInvocation` → always populates `workspaceRoot` and `date`
- `resolveInvocation` → populates `currentFile` and `language` from `--file`
- `resolveInvocation` → resolves `selection` and `cursorLine` to `""`
- `resolveInvocation` → returns `none` for text without a leading slash
- `resolveInvocation` → returns `reserved` for `/help` even when a skill named `help` is registered
- `resolveInvocation` → returns `unknown` with ≤3 deduplicated suggestions for a near miss
- `resolveInvocation` → returns the body unchanged when the template has no placeholders
- `resolveInvocation` → adds an editor-only note for `/doc` with no `--file`
- `resolveInvocation` → adds no editor-only note when `--file` supplies `currentFile`
- `resolveInvocation` → keeps newlines in multi-line `userInput`
- `buildSkillContext` → derives `language` from the extension, `undefined` when unknown
- `buildSkillContext` → makes `currentFile` workspace-relative
- `buildSkillContext` → notes a `--file` outside the workspace
- `formatSkillList` → includes name, mode, source, description
- `formatSkillList` → shows `workspace` for an override

**Tests first — `test/unit/cli/tool-scope.test.ts`** (registry built from `headlessFsTools`, all with
`requiresApproval: false`)

- `applyAllowedTools` → unregisters tools not in the allow list
- `applyAllowedTools` → `restore()` puts every original tool back
- `applyAllowedTools` → `restore()` is idempotent
- `applyAllowedTools` → reports declared-but-absent tools in `missing`
- `applyAllowedTools` → filters to zero when nothing declared is available
- `applyAllowedTools` → no-op when `allowedTools` is `undefined` or `[]`

**Tests first — `test/unit/cli/args.test.ts` (extend the existing file)**

- parses `--skill review`, `--skill=review`
- rejects an invalid skill name
- rejects `--skill` with `--repl`
- rejects `--skill` with a leading-slash positional
- `--skill` with no positional → `oneshot` with `task === ""`, even when `stdinIsTTY` is false
- parses `--file src/a.ts`, `--file=src/a.ts`
- `--list-skills` → `{ kind: "list-skills" }` and no provider work
- rejects `--list-skills` with `--repl` or with a task
- `--no-skills` sets the flag
- `USAGE` contains all four new flags and the two new command lines

**Acceptance criteria**

- AC-C1: `/review src/a.ts` in the REPL sends the expanded template and nothing else.
- AC-C2: `/explain` runs in `ask` mode and the **next** plain turn can still call `edit_file`.
- AC-C3: a skill declaring `allowedTools: [read_file]` cannot call `edit_file` during its turn,
  and `edit_file` is back afterwards.
- AC-C4: `champ --list-skills` exits `0` with no reachable model.
- AC-C5: an unknown `/nope` never reaches the model and lists suggestions.
- AC-C6: `--no-skills` makes a workspace-only skill unknown.

---

### Increment D — end-to-end proof and docs

**Tests first — `test/integration/cli-skills.integration.test.ts`**

Reuse the `scenario()` helper pattern from `test/integration/cli.integration.test.ts:30-52`
(`makeWorkspace`, `startMockOpenAI`, `writeChampConfig`, `runCli`).

- runs a workspace skill via `/name` in one-shot mode; assert the mock sees the expanded body
- workspace skill overrides the built-in of the same name (assert the body text)
- `/skills` in a scripted REPL lists names + sources and issues **zero** requests
- `.champ/rules/always.md` → the system message in the captured request contains the rule text
- `.champ/rules/scoped.md` with `glob: src/**` → activates with `--file src/a.ts`, not with
  `--file README.md`
- `--no-skills` → `/acme` fails with exit `2` and **no** provider request
- `champ --list-skills` with an unreachable endpoint → exit `0`, built-in names printed
- REPL: `/explain` then `edit_file` → the second turn's request still advertises `edit_file`
  (proves mode restore)
- REPL: a skill with `allowedTools: [read_file]` then `/skills` → no state corruption

**Extend `test/e2e/cli-packaging.test.ts`** (the packaged bundle must contain the skills modules;
a dynamically-walked file list would be invisible to esbuild):

- after `buildCli()`, `node dist/cli.js --list-skills --cwd <tmp>` exits `0` and prints
  `explain`, `review`, `commit`
- `--list-skills --no-skills` still prints the 8 built-ins

**Docs**

- `docs/INSTALLATION_AND_USAGE.md`: new "Skills and project rules" section covering
  - directory layout: `<workspace>/.champ/skills/*.md`, `~/.champ/skills/*.md`,
    `<workspace>/.champ/rules/*.md`, `userRules:` in `~/.champ/config.yaml`
  - a 10-line frontmatter example and the `{{variables}}` table, marking which are empty in a terminal
  - `/skills`, `/<skill>`, `--skill`, `--file`, `--no-skills`, `--list-skills`
  - the `/commit` and `/fix` limitations, stated plainly
  - no hostnames, no absolute paths, no root, no `sudo`
- `docs/PLAN_SKILLS.md`: append a short "Phase E — CLI integration" section pointing here and
  recording D5–D8, so the design doc stops implying skills are extension-only.

**Acceptance criteria**

- AC-D1: the packaged bundle exposes skills (e2e).
- AC-D2: rules reach the model through the CLI (integration).
- AC-D3: a beginner can follow the new guide section without editing source or using root.

---

## 6. Behavioural contract (edge cases)

| Input | Expected |
|---|---|
| `.champ/skills/` absent | built-ins only, silent |
| `.champ/rules/` absent | no rules, silent |
| skill file with UTF-8 BOM | BOM stripped, parses normally |
| invalid YAML | one `[champ] skill ignored: <path>: <msg>`, process continues |
| missing `name` / `description` | same |
| empty body | skipped + reported |
| name with `/`, space, or `.` | loader rejects (strict) → reported |
| skill named `help` | registered, reported as shadowed, `/help` still prints usage |
| `/review` with no args | works, `{{userInput}}` → `""` |
| `/review` with multi-line args | newlines preserved in `{{userInput}}` |
| `/skills extra` | args ignored, still lists |
| unknown `/nope` | exit 2 in one-shot, stderr message + suggestions in REPL, no request |
| `--skill` + `/name` positional | usage error, exit 2 |
| `--skill` with no task | runs with empty `{{userInput}}`, never reads stdin |
| `--list-skills` + task | usage error, exit 2 |
| `--list-skills` + `--repl` | usage error, exit 2 |
| `--list-skills` + piped stdin | exits immediately, does not read stdin |
| `--file` missing on disk | not an error (context is text, not IO); `language` still derived |
| `--file` outside workspace | passed through + note |
| `--file` in workspace | workspace-relative `currentFile`, globs match |
| skill declares only absent tools | zero tools for the turn + warning |
| 200 skill files | O(n) sync reads, no watcher; acceptable |
| Ctrl-C mid skill turn | mode and tools restored in `finally` |
| `--no-skills` + workspace skill | unknown command; built-ins unaffected |

---

## 7. Verification commands

```bash
# types (must pass; the build script runs it too)
pnpm run check-types

# unit — fast loop while developing
pnpm run test:unit -- test/unit/cli

# integration (builds dist/cli.js itself via the harness)
pnpm run test:integration -- test/integration/cli-skills.integration.test.ts

# e2e packaging
pnpm run test:e2e -- test/e2e/cli-packaging.test.ts

# full build of the CLI bundle
node esbuild.mjs

# manual smoke test with a mock-free local endpoint
node dist/cli.js --list-skills --cwd /tmp
node dist/cli.js --no-skills -y "reply with OK"
```

Known pre-existing failures, unrelated to this work — do not "fix" them here:

- `test/integration/tools/git-tool.integration.test.ts` (7 failures,
  `gitUtils.parseGitHubUrl is not a function`).

The pre-commit hook runs the full unit suite (~1938 tests) and is slow. Budget for it; do not use
`--no-verify`.

To prove a new test fails before the fix, swap the implementation file back with
`git show <sha>:<path> > <path>` — never `git stash`.

---

## 8. Issue and commits

**Issue title:** `CLI: skills and project rules`

**Issue body (copy as-is, adjust numbers only if needed):**

```
The headless CLI cannot use skills or .champ/rules. Verified: zero skill/rules modules are
reachable from src/cli.ts; /review prints "unknown command"; .champ/rules loads only at
extension activation (src/extension.ts:3401).

Acceptance criteria

- [ ] AC1  .champ/rules/*.md and userRules from the effective config are injected into every
              CLI turn; auto-attached rules follow --file.
- [ ] AC2  Built-in, user (~/.champ/skills) and workspace (<cwd>/.champ/skills) skills load with
              precedence workspace > user > built-in; an invalid file warns and never aborts.
- [ ] AC3  /<skill> works in the REPL and in one-shot runs; --skill, --file, --list-skills and
              --no-skills exist; skill mode and allowedTools apply to that turn only and are
              restored afterwards.
- [ ] AC4  The packaged bundle exposes skills (e2e) and the beginner guide documents the feature.

Tests required
- test/unit/cli/rules.test.ts
- test/unit/cli/skills.test.ts
- test/unit/cli/skill-dispatch.test.ts
- test/unit/cli/tool-scope.test.ts
- test/unit/cli/args.test.ts (extend)
- test/integration/cli-skills.integration.test.ts
- test/e2e/cli-packaging.test.ts (extend)

Design: docs/PLAN_CLI_SKILLS_AND_RULES.md
```

**Commits** (one per increment, tests included, referencing the issue):

1. `feat(cli): load and inject .champ/rules (#141 AC1)`
2. `feat(cli): load built-in, user and workspace skills (#141 AC2)`
3. `feat(cli): dispatch skills in REPL and one-shot runs (#141 AC3)`
4. `test(cli): prove skills survive packaging; docs: CLI skills and rules (#141 AC4)`

---

## 9. Guardrails for the implementer

- **Do not touch** `src/extension.ts`, `src/ui/chat-view-provider.ts`, `src/skills/*`,
  `src/rules/*`, or the built-in skill texts. Use them; do not modify them. Extension behaviour
  must be provably unchanged (no changes at all to those files).
- **No `vscode` import anywhere under `src/cli/**`.** The CLI bundle is built without
  `--external:vscode`; one import breaks the build at runtime, not at compile time.
- **No dynamic import of skill directories.** Static imports only, or esbuild will drop the module
  and the e2e test will catch it late.
- **Do not change `runTurn`.** Skill scoping wraps it.
- **`restore()` in `finally`, never after the `try`.** Ctrl-C is a normal path here.
- **The REPL `switch` has a swallowing `default`.** Add `case "/skills"` inside it and dispatch
  skills from `default`, or restructure to sequential checks. Code appended after the `switch` will
  never run.
- **Streams are not interchangeable.** `--list-skills` (a query, like `--sessions`) writes to
  stdout; `/skills` (REPL meta output) writes to stderr; model text is the only thing on stdout
  during a turn.
- Do not add a file watcher, autocomplete, or smart routing. Out of scope (§11).
- Do not make stdout noisier: model text on stdout, everything else on stderr (existing contract).
- Keep the new modules pure enough to unit-test without a process: `resolveInvocation` and
  `applyAllowedTools` take all their inputs as arguments. Home directory is injectable.
- If a fact in §2 disagrees with the code you see, **the code wins** — update §2 in the same
  commit and note the drift in the commit body.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Mode restore missed on an error path | later turns silently lose write tools | `finally` + explicit test "edit_file still advertised after /explain" |
| Tool restore missed | same, but for a whole tool set | `finally` + idempotent `restore()` + unit test |
| Workspace skill silently shadows a built-in | surprise | `/skills` shows the source; precedence is documented; no startup noise (matching chat) |
| Editor-oriented templates produce hollow prompts | user blames the 4B model | `--file`, plus a one-line note naming the empty placeholders |
| `/commit`, `/fix` underperform | perceived bug | documented in the guide + a `missing`-tool warning at invocation |
| esbuild misses the new modules | skills absent from the installed CLI | static imports + e2e `--list-skills` assertion |
| Tests read the developer's real `~/.champ` | flaky, machine-dependent | `homeDir` injection; no test may call `os.homedir()` |
| Expanding prompts bloats the session log | larger logs | accepted: history fidelity beats log size; existing compaction handles context |
| Very long skill templates get truncated by the context manager | partial instructions | document "keep skill files focused"; no code change (existing fitting behaviour) |

---

## 11. Out of scope

- `allowedTools` enforcement in the extension (follow-up, §12).
- Live reload / file watching in the REPL.
- A sticky "active skill" for a session — each invocation is exactly one turn, matching chat.
- Readline autocomplete for `/` commands.
- Terminal, git, MCP, browser, or `codebase_search` tools in the headless registry.
- Smart routing on the CLI path.
- `{{branch}}` support.
- Any change to `docs/reviews/**`.

---

## 12. Follow-up issues (file them, do not implement here)

1. **Read-only git tools for the headless CLI.** Register a headless wrapper exposing only
   `git_status` and `git_diff` (the extension's `git` tool at `src/tools/git-tool.ts:22` has no
   `vscode` import, so the exec layer is reusable; gate the action set). Then update the `commit`
   built-in to declare those instead of `run_terminal_cmd` — which also gives the extension a
   non-terminal path. This is what makes `/commit` genuinely useful in a terminal.
2. **Enforce `allowedTools` in the extension.** The CLI will enforce it; chat will not. Same
   save/restore helper, applied in `ChatViewProvider.expandSkill`'s call path. Decide there whether
   to share `src/cli/tool-scope.ts` (move it to `src/tools/tool-scope.ts` if so).
3. **`/fix` in the CLI.** Needs a headless diagnostic source (LSP is extension-only). Until then,
   document `/fix` as extension-only and let the `missing`-tool warning say why.
4. **`{{branch}}` for skills.** Cache `git rev-parse --abbrev-ref HEAD` once per process if it turns
   out to matter.

---

## 13. Definition of done

- [ ] `pnpm run check-types` passes.
- [ ] All seven test files/suites above are green; the only failures in the repo are the
      pre-existing `git-tool.integration` ones.
- [ ] `node esbuild.mjs && node dist/cli.js --list-skills --cwd /tmp` prints the 8 built-ins.
- [ ] `--no-skills` and `--skill` behave as specified, including the no-stdin-blocking rule.
- [ ] `/explain` leaves the following turn in `agent` mode (test proves it).
- [ ] A skill with `allowedTools: [read_file]` cannot write, and can write again next turn.
- [ ] `.champ/rules/always.md` content is visible in the captured request body.
- [ ] Docs updated, beginner-usable, generic, no root, PATH guidance intact.
- [ ] No file outside `src/cli*`, `test/**`, `docs/**` changed.
- [ ] Four commits, each referencing the issue, tests in the same commit as the code.
