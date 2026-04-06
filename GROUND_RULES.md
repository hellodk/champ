# Ground Rules

These rules are non-negotiable and apply to all contributors throughout the entire project lifecycle.

---

## Rule 1: Test-Driven Development (TDD)

All code MUST follow the TDD cycle: **Red -> Green -> Refactor**.

### Process
1. **Write a failing test first** that defines the expected behavior
2. **Write the minimum code** to make the test pass
3. **Refactor** while keeping all tests green
4. Repeat

### Requirements
- No production code is written without a corresponding test written FIRST
- Every pull request must include tests that were written before the implementation
- Test coverage must not decrease on any PR
- Tests must be:
  - **Unit tests** for individual modules (providers, tools, agents, utilities)
  - **Integration tests** for module interactions (agent loop + tools, provider + context manager)
  - **E2E tests** for user-facing workflows (chat interaction, file editing, terminal execution)

### Test Framework
- **vitest** for unit and integration tests
- **@vscode/test-electron** for E2E tests running inside a real VS Code instance

### Naming Convention
- Test files mirror source files: `src/tools/read-file.ts` -> `test/unit/tools/read-file.test.ts`
- Describe blocks match the module/class name
- Test names follow: `should <expected behavior> when <condition>`

---

## Rule 2: Automated Test Validation via Git Hooks

After every commit, the full test suite MUST run automatically via git hooks to validate both existing and new functionality.

### Git Hook Setup

**Pre-commit hook** (runs before commit is finalized):
- Lint check (`eslint`)
- Type check (`tsc --noEmit`)
- Unit tests for changed files only (fast feedback)

**Post-commit hook** (runs after commit succeeds):
- Full test suite (unit + integration)
- Generates a test report

### Test Report Naming Convention

Reports are named using the branch name and commit ID:

```
test-reports/<branch-name>_<commit-short-hash>_<timestamp>.json
```

**Examples:**
```
test-reports/feature-chat-ui_a1b2c3d_2026-04-05T22-30-00.json
test-reports/fix-provider-streaming_e4f5g6h_2026-04-05T23-15-00.json
test-reports/main_i7j8k9l_2026-04-06T01-00-00.json
```

### Report Contents

Each report is a JSON file containing:
```json
{
  "branch": "feature-chat-ui",
  "commitId": "a1b2c3d4e5f6",
  "commitMessage": "feat: add streaming text display",
  "timestamp": "2026-04-05T22:30:00Z",
  "duration_ms": 12345,
  "summary": {
    "total": 150,
    "passed": 148,
    "failed": 1,
    "skipped": 1
  },
  "suites": {
    "unit": { "total": 100, "passed": 99, "failed": 1, "skipped": 0 },
    "integration": { "total": 40, "passed": 39, "failed": 0, "skipped": 1 },
    "e2e": { "total": 10, "passed": 10, "failed": 0, "skipped": 0 }
  },
  "failures": [
    {
      "suite": "unit",
      "test": "ClaudeProvider > should handle streaming abort",
      "file": "test/unit/providers/claude.test.ts",
      "error": "Expected abort signal to terminate stream"
    }
  ]
}
```

### Implementation

The git hooks are managed via **husky** + a custom test runner script:

```bash
# .husky/pre-commit
npx lint-staged
npm run check-types

# .husky/post-commit
node scripts/run-tests-and-report.js
```

The `scripts/run-tests-and-report.js` script:
1. Reads the current branch name (`git rev-parse --abbrev-ref HEAD`)
2. Reads the commit hash (`git rev-parse --short HEAD`)
3. Runs `vitest run --reporter=json`
4. Transforms output into the report format above
5. Saves to `test-reports/<branch>_<commit>_<timestamp>.json`
6. Prints a summary to stdout
7. Exits with non-zero if any test failed (blocking the workflow)

### Report Storage
- `test-reports/` directory is gitignored (reports stay local)
- Reports accumulate locally for trend analysis
- A cleanup script prunes reports older than 30 days

---

## Enforcement

- These rules are enforced by tooling, not by trust
- Husky git hooks are installed automatically via `npm install` (prepare script)
- CI/CD (GitHub Actions) runs the same test suite as a safety net
- PRs cannot merge without all checks passing
