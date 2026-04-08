/**
 * Built-in skills shipped with the AIDev extension.
 *
 * Each skill is a markdown file (with YAML frontmatter) inlined as a
 * TypeScript constant. We inline rather than reading from disk so the
 * skills are guaranteed to ship with the extension bundle and don't
 * require an additional file resolution step at activation.
 *
 * To add a new built-in skill: append a new constant below and add it
 * to BUILT_IN_SKILL_TEXTS. The SkillLoader parses each one at startup
 * and the SkillRegistry holds them.
 *
 * Users can override any built-in by dropping a same-named .md file in
 * .aidev/skills/ (workspace) or ~/.aidev/skills/ (personal).
 */

const EXPLAIN = `---
name: explain
description: Explain the current code selection in plain English
mode: ask
allowedTools: [read_file, grep_search, file_search]
---

You are explaining code to a developer who is unfamiliar with this codebase. Please explain what the following code does, focusing on:

1. **Purpose** — what problem does it solve?
2. **Non-obvious patterns** — any idioms, tricks, or library-specific behavior worth flagging
3. **Edge cases** — any boundary conditions or potential bugs to watch for
4. **Context** — how does it fit into the larger system? Use grep_search to check where it's called from

Be concise. Skip the obvious.

## Code

File: \`{{currentFile}}\`
Language: \`{{language}}\`

\`\`\`{{language}}
{{selection}}
\`\`\`

{{userInput}}
`;

const TEST = `---
name: test
description: Generate unit tests for the current file
allowedTools: [read_file, grep_search, file_search, edit_file, create_file]
---

Generate unit tests for the file below.

Steps:
1. Read the file with read_file to see its full contents.
2. Check existing tests in the project (use file_search and grep_search) to learn the test framework and conventions in use — DO NOT assume jest or vitest, look at what the project actually uses.
3. Identify every exported function, class, or symbol that needs coverage.
4. Write tests covering: happy path, error cases, edge conditions (empty, null, boundary values).
5. Place the test file adjacent to the source file using the project's existing naming convention (e.g. \`foo.test.ts\` or \`__tests__/foo.test.ts\`).

## Target

File: \`{{currentFile}}\`

{{userInput}}
`;

const REFACTOR = `---
name: refactor
description: Refactor the selected code (user provides the goal)
allowedTools: [read_file, grep_search, edit_file]
---

Refactor the selected code.

The user's refactoring goal: {{userInput}}

Steps:
1. Read the surrounding context with read_file before making any changes.
2. Use grep_search to find every caller of the symbol(s) being refactored — the refactor must not break them.
3. Apply the change with edit_file.
4. After editing, read the file back to verify the change is correct and the surrounding code still makes sense.
5. If callers need updating, update them too in the same conversation.

## Selection

File: \`{{currentFile}}\` (line {{cursorLine}})

\`\`\`{{language}}
{{selection}}
\`\`\`
`;

const REVIEW = `---
name: review
description: Code review the current selection
mode: ask
allowedTools: [read_file, grep_search, file_search]
---

Review the code below as if you were a senior engineer reviewing a pull request. Focus on:

1. **Correctness** — does it actually do what it's supposed to do? Any logic errors?
2. **Edge cases** — empty inputs, null/undefined, boundary values, concurrency, error paths
3. **Style and idioms** — does it match the project's existing patterns? Use grep_search to compare with similar code elsewhere in the codebase.
4. **Security** — injection, XSS, auth bypass, secret leakage, unsafe deserialization
5. **Performance** — obvious O(n²) loops, unnecessary allocations, missing pagination
6. **Maintainability** — naming, function size, abstraction level, comments where they help

Format the response as a checklist with severity tags (🔴 blocker, 🟡 should-fix, 🟢 nit). Be specific — point at line numbers and suggest concrete fixes.

## Code

File: \`{{currentFile}}\`

\`\`\`{{language}}
{{selection}}
\`\`\`

{{userInput}}
`;

const COMMIT = `---
name: commit
description: Generate a Conventional Commits message from staged changes
mode: ask
allowedTools: [run_terminal_cmd]
---

Generate a Conventional Commits message from the currently staged git changes.

Steps:
1. Run \`git diff --cached --stat\` first to see which files changed.
2. Run \`git diff --cached\` to see the actual diff (cap output if huge).
3. Identify the dominant change type (feat / fix / docs / style / refactor / test / chore / build / ci).
4. Identify the scope from the affected files (e.g. \`auth\`, \`api\`, \`docs\`).
5. Write a concise summary line: \`<type>(<scope>): <imperative summary>\`
6. Write a body explaining *why* the change was made (not what — the diff already shows that).
7. Output the exact \`git commit -m "..."\` command the user can copy.

If nothing is staged, suggest running \`git add\` first.

Branch: \`{{branch}}\`
Date: \`{{date}}\`

{{userInput}}
`;

const DOC = `---
name: doc
description: Generate JSDoc / docstrings for the current symbol
allowedTools: [read_file, edit_file]
---

Add documentation comments to the code below.

Style requirements:
1. Use the documentation format that matches the file's language (JSDoc for TS/JS, docstrings for Python, doc comments for Rust/Go).
2. Match the existing documentation style in the file — use read_file to check what's already there.
3. Document every exported symbol: parameters, return value, throws, side effects, and a 1-2 sentence summary.
4. Skip the obvious. \`function add(a: number, b: number)\` doesn't need "Adds two numbers" — the name says it. Comment the *why*.
5. Apply the changes with edit_file. Don't dump the documentation as a code block in the chat — actually edit the file.

## Target

File: \`{{currentFile}}\`

\`\`\`{{language}}
{{selection}}
\`\`\`
`;

const FIX = `---
name: fix
description: Fix the LSP diagnostic at the current cursor position
allowedTools: [read_file, grep_search, edit_file, run_terminal_cmd]
---

There is a problem at line {{cursorLine}} of \`{{currentFile}}\`. Fix it.

Steps:
1. Read the file to see the current state with read_file.
2. Identify the actual error from the surrounding context — pay attention to any types, imports, and adjacent usages.
3. Use grep_search if you need to understand how the affected symbol is used elsewhere.
4. Apply the minimal fix with edit_file. Do NOT change unrelated code.
5. After editing, briefly explain what was wrong and what your fix addresses.

If the problem isn't clear from the file, ask the user for the specific error message before guessing.

## Context

\`\`\`{{language}}
{{selection}}
\`\`\`

{{userInput}}
`;

const OPTIMIZE = `---
name: optimize
description: Suggest performance optimizations for the selection
mode: ask
allowedTools: [read_file, grep_search]
---

Analyze the code below for performance optimization opportunities.

Look for:
1. **Algorithmic improvements** — O(n²) loops that can be O(n), unnecessary nested iteration, missing memoization
2. **Data structure choices** — using arrays where Maps/Sets would be faster, using objects where typed arrays would be smaller
3. **Allocation pressure** — avoidable object creation in hot paths, unnecessary string concatenation
4. **I/O patterns** — sequential awaits that could parallelize with Promise.all, missing batching
5. **Library-specific footguns** — common slow patterns in the libraries actually in use (check imports first)

Format the response as a numbered list of suggestions, each with:
- The line range it affects
- The current cost vs improved cost (asymptotic if relevant)
- The exact change needed (code snippet)
- An estimate of how much the optimization actually matters in practice

Be honest: if the code is already fast enough for its purpose, say so and skip the micro-optimizations.

## Code

File: \`{{currentFile}}\`

\`\`\`{{language}}
{{selection}}
\`\`\`

{{userInput}}
`;

/**
 * The full list of built-in skills, indexed by name. The bootstrap
 * code in extension.ts iterates this and registers each one with the
 * SkillRegistry at activation time.
 */
export const BUILT_IN_SKILL_TEXTS: ReadonlyArray<{
  name: string;
  text: string;
}> = [
  { name: "explain", text: EXPLAIN },
  { name: "test", text: TEST },
  { name: "refactor", text: REFACTOR },
  { name: "review", text: REVIEW },
  { name: "commit", text: COMMIT },
  { name: "doc", text: DOC },
  { name: "fix", text: FIX },
  { name: "optimize", text: OPTIMIZE },
];
