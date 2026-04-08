# PLAN: Skills system

Status: **design** — not yet implemented. Targets v0.2.

## Why

A "skill" is a named, reusable prompt template you can invoke from chat with `/<skill-name>`. Modeled after Claude's Skill system and Continue.dev's slash commands. The same idea exists in Cline (templated prompts), Aider (slash commands), and Cursor (custom modes).

Why this matters:
- **Reduces friction.** "Explain this function" is a thing you do 50× a day. A `/explain` skill makes it one keystroke.
- **Encodes team conventions.** A `/commit` skill that follows your team's commit message style. A `/security-review` skill that runs through your security checklist. A `/api-doc` skill that generates JSDoc in your house format.
- **Shareable.** Skills committed to `.aidev/skills/` ride along with the repo so every team member has the same workflow.
- **Extensible.** Users can write their own skills without touching the extension code — just drop a markdown file in `.aidev/skills/`.

## Goals

- Skills as **markdown files with YAML frontmatter** — easy to read, write, version, share
- Triggered via `/<name>` in the chat input
- Built-in skills shipped with the extension cover the 80% case
- User-defined skills loaded from `.aidev/skills/*.md` and `~/.aidev/skills/*.md`
- Variable substitution: `{{selection}}`, `{{currentFile}}`, `{{language}}`, etc.
- Optional per-skill tool restrictions and mode override

## File format

Skills are markdown files with YAML frontmatter. The body is the prompt template — the LLM sees it after variable substitution.

```markdown
---
name: explain
description: Explain the current code selection in plain English
trigger: /explain
mode: ask                              # optional — overrides current mode
allowedTools: [read_file, grep_search] # optional — restricts the tool list
---

You are explaining code to a junior developer who is unfamiliar with this
codebase. Please explain what the following code does, focusing on:

1. Its purpose and what problem it solves
2. Any non-obvious patterns, idioms, or tricks
3. Potential edge cases or bugs to watch for
4. How it fits into the larger system (use grep_search to check usages)

## Code to explain

File: {{currentFile}}
Language: {{language}}

```{{language}}
{{selection}}
```
```

## Variable substitution

Available placeholders, populated by the chat view before sending the
prompt to the LLM:

| Variable | Resolved to |
|----------|-------------|
| `{{selection}}` | Current editor selection (or empty string) |
| `{{currentFile}}` | Relative path of the active editor's file |
| `{{language}}` | Language ID of the active editor (e.g. `typescript`) |
| `{{workspaceRoot}}` | Workspace folder absolute path |
| `{{userInput}}` | Anything the user typed after the slash command name |
| `{{cursorLine}}` | 1-indexed line number where the cursor is |
| `{{date}}` | Today's date in YYYY-MM-DD |
| `{{branch}}` | Current git branch (best-effort, empty if not a git repo) |

Substitution is purely textual — no template engine, no conditionals.
Anything more complex belongs in a tool, not a skill template.

## Built-in skills (v0.2)

Shipped with the extension under `src/skills/built-in/`:

| Slash command | What it does |
|---------------|--------------|
| `/explain` | Explains the current selection in plain English |
| `/test` | Generates tests for the current file |
| `/refactor` | Refactors the selection — user provides the goal as `{{userInput}}` |
| `/review` | Code review of the selection (correctness, style, edge cases) |
| `/commit` | Generates a Conventional Commits message from staged git diff |
| `/doc` | Generates JSDoc / docstrings for the current symbol |
| `/fix` | Fixes the diagnostic at the current cursor position |
| `/optimize` | Suggests performance optimizations for the selection |

These are markdown files inside the extension bundle, loaded at activation alongside user-defined skills. Users can override a built-in by dropping a same-named file in `.aidev/skills/`.

## Architecture

```
src/skills/
├── types.ts                 // Skill, SkillFrontmatter, parsed shapes
├── skill-loader.ts          // parse-and-validate one .md file
├── skill-registry.ts        // central registry, list/get/match-prefix
├── variable-resolver.ts     // {{variable}} substitution
├── built-in/
│   ├── explain.md
│   ├── test.md
│   ├── refactor.md
│   ├── review.md
│   ├── commit.md
│   ├── doc.md
│   ├── fix.md
│   └── optimize.md
└── built-in-loader.ts       // bundle built-in .md files into the extension
```

### `src/skills/types.ts`
```typescript
export interface SkillFrontmatter {
  name: string;
  description: string;
  trigger?: string;          // defaults to /<name>
  mode?: AgentMode;          // optional override
  allowedTools?: string[];   // optional tool restriction
}

export interface Skill {
  metadata: SkillFrontmatter;
  template: string;          // markdown body, with {{variables}}
  source: 'built-in' | 'user' | 'workspace';
  filePath?: string;         // for user/workspace skills
}
```

### `src/skills/skill-loader.ts`
```typescript
export class SkillLoader {
  /** Parse a single .md file into a Skill, or throw on validation error. */
  static parseFile(text: string, source: Skill['source'], filePath?: string): Skill;

  /** Parse YAML frontmatter from a markdown file. */
  static parseFrontmatter(text: string): { meta: unknown; body: string };
}
```

### `src/skills/skill-registry.ts`
```typescript
export class SkillRegistry {
  register(skill: Skill): void;
  unregister(name: string): void;
  get(name: string): Skill | undefined;
  list(): Skill[];

  /** For autocomplete: return skills whose name starts with `prefix`. */
  matchPrefix(prefix: string): Skill[];

  /** Load every .md file from a directory. */
  async loadFromDirectory(dir: string, source: Skill['source']): Promise<number>;
}
```

### `src/skills/variable-resolver.ts`
```typescript
export interface SkillContext {
  selection?: string;
  currentFile?: string;
  language?: string;
  workspaceRoot: string;
  userInput?: string;
  cursorLine?: number;
  date: string;
  branch?: string;
}

export class VariableResolver {
  static resolve(template: string, context: SkillContext): string;
}
```

### Integration with the chat input

The webview parses the user's text on submit. If it starts with `/<word>`, the chat view:

1. Sends a `webview → extension` message: `{ type: 'invokeSkill', name, userInput }`
2. The extension looks up the skill in `SkillRegistry`
3. Builds a `SkillContext` from the active editor + workspace + git
4. Resolves the template via `VariableResolver`
5. Sends the resolved text into the agent loop just like any other user message

### Autocomplete

When the user types `/` in the chat input, the webview asks the extension for matching skills via a new message type. The extension returns a list of `{ name, description }` and the webview renders a dropdown.

## Test plan (TDD-first)

### `test/unit/skills/skill-loader.test.ts`
- parses valid frontmatter + body
- requires `name` and `description`
- rejects missing frontmatter
- rejects malformed YAML
- preserves the markdown body unchanged
- accepts optional fields (trigger, mode, allowedTools)

### `test/unit/skills/skill-registry.test.ts`
- register / get / list
- duplicate names overwrite (with optional warning)
- matchPrefix returns sorted results
- loadFromDirectory parses every .md file in a folder
- corrupted files are skipped, not crash

### `test/unit/skills/variable-resolver.test.ts`
- substitutes single variable
- substitutes multiple variables in one template
- leaves unknown {{variables}} as literal text (so user notices)
- handles missing context fields (returns empty string for that variable)
- escapes nothing — variables are inserted verbatim

### `test/unit/skills/integration.test.ts`
- end-to-end: load `/explain` from disk, resolve with mock context, get expected prompt

## Phasing

### Phase A — core (1 day)
- Skill type, loader, registry, variable resolver
- All unit tests
- 8 built-in skills as markdown files

### Phase B — chat integration (½ day)
- ChatViewProvider intercepts `/<name>` user messages
- Resolves the skill into the actual prompt before sending to the agent
- Built-in skills load on activation

### Phase C — user/workspace skills (½ day)
- `loadFromDirectory` for `<workspace>/.aidev/skills/` and `~/.aidev/skills/`
- File watcher to reload on save

### Phase D — autocomplete (½ day)
- Webview slash-command autocomplete dropdown
- Highlight skill descriptions
- Tab completes the name; Enter sends with current input

Total: ~2.5 days.

## Built-in skill content sketches

`src/skills/built-in/explain.md`:
```markdown
---
name: explain
description: Explain the current code selection in plain English
mode: ask
allowedTools: [read_file, grep_search]
---

You are explaining code to a junior developer. Please explain what the
following code does, focusing on:
1. Purpose and what problem it solves
2. Any non-obvious patterns or idioms
3. Edge cases or bugs to watch for
4. How it fits into the larger system

File: {{currentFile}}

```{{language}}
{{selection}}
```
```

`src/skills/built-in/test.md`:
```markdown
---
name: test
description: Generate unit tests for the current file
---

Generate unit tests for the file below. Use the test framework already
in use in this project (look at existing tests with grep_search). Cover
happy paths, error cases, and edge conditions. Place the new test file
adjacent to the source file with the `.test.ts` suffix.

File: {{currentFile}}
```

`src/skills/built-in/commit.md`:
```markdown
---
name: commit
description: Generate a Conventional Commits message from staged changes
mode: ask
allowedTools: [run_terminal_cmd]
---

Run `git diff --cached` and generate a Conventional Commits message
that summarizes the staged changes. Format:

  <type>(<scope>): <short summary>

  <body explaining what and why>

Valid types: feat, fix, docs, style, refactor, test, chore.

After generating the message, suggest the exact command to commit
(e.g., `git commit -m "..."`).
```

## Open questions

1. **Skill discovery in the UI**: should there be a "Skills" panel, or only autocomplete? **Recommendation**: only autocomplete in v0.2; a panel can come later.

2. **Skill arguments**: should we support multiple positional arguments like `/refactor extract-function add-error-handling`? **Recommendation**: no — `{{userInput}}` captures everything after the name and the user can write structured requests in plain English.

3. **Skill chaining**: can a skill invoke another skill? **Recommendation**: not in v0.2. If users want chaining they can write a more complex single skill.

4. **Override precedence**: if a built-in `/explain` and a user `/explain` both exist, which wins? **Recommendation**: workspace > user > built-in. User can always override, team can override personal.

## Success criteria

- 8 built-in skills working out of the box
- A user can drop a custom `.md` file in `.aidev/skills/` and use it immediately
- Slash command autocomplete works in the chat input
- All variable placeholders resolve correctly
- Test count grows by ≥20 (loader + registry + resolver + integration)
- No regressions in the existing 364 tests
