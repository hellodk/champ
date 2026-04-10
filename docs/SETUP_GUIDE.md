# Champ Development Setup Guide

This guide covers everything needed to set up the Champ VS Code extension for local development, testing, and packaging.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Clone and Install](#clone-and-install)
3. [Project Structure](#project-structure)
4. [Local LLM Setup](#local-llm-setup)
5. [Running the Extension in Development](#running-the-extension-in-development)
6. [Running Tests](#running-tests)
7. [Understanding the Git Hooks](#understanding-the-git-hooks)
8. [Building and Packaging](#building-and-packaging)
9. [Configuration Reference](#configuration-reference)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required

| Tool | Version | Purpose |
|---|---|---|
| **Node.js** | 20.0+ | Runtime for the extension and build tools |
| **npm** | 10.0+ | Package management (ships with Node.js 20+) |
| **VS Code** | 1.93+ | Extension host for development and testing |
| **Git** | 2.40+ | Version control, git hooks |
| **TypeScript** | 5.5+ | Installed as dev dependency, no global install needed |

### Optional (for local LLM support)

| Tool | Version | Purpose |
|---|---|---|
| **Ollama** | 0.3+ | Local model serving (recommended for development) |
| **llama.cpp** | Latest | Direct GGUF model serving |
| **vLLM** | 0.5+ | High-throughput model serving (GPU required) |

### Verify Prerequisites

```bash
# Check Node.js version (must be 20+)
node --version

# Check npm version (must be 10+)
npm --version

# Check VS Code version (must be 1.93+)
code --version

# Check git version
git --version
```

---

## Clone and Install

```bash
# Clone the repository
git clone https://github.com/champ-oss/vs-code-plugin.git
cd vs-code-plugin

# Install dependencies (also installs husky git hooks via the "prepare" script)
npm install

# Verify the installation by running the type checker
npm run check-types

# Run the test suite to confirm everything works
npm test
```

After `npm install`, husky is automatically set up via the `prepare` script, which installs the git hooks in `.husky/`.

---

## Project Structure

```
vs-code-plugin/
  .claude/              # Claude Code settings
  .husky/               # Git hooks (pre-commit, post-commit)
  .vscode/              # VS Code workspace settings and launch configs
  docs/                 # Design documents (you are here)
  media/                # Extension icons and images
  scripts/              # Build and test scripts
    run-tests-and-report.js   # Post-commit test reporter
  src/                  # Extension source code (TypeScript)
    agent/              # Multi-agent orchestration
      agents/           # Individual agent implementations
    checkpoints/        # Checkpoint/rollback system
    completion/         # Inline autocomplete
    composer/           # Multi-file edit composer
    indexing/           # Codebase indexing and RAG
    mcp/                # Model Context Protocol client
    observability/      # Metrics and logging
    prompts/            # System prompt templates
    providers/          # LLM provider implementations
    rules/              # Rules engine
    safety/             # Secret redaction, sandbox, confidence scoring
    tools/              # Tool definitions and registry
    ui/                 # ChatViewProvider and webview bridge
    upload/             # File upload and parsing
    utils/              # Shared utilities
    extension.ts        # Extension entry point
  test/                 # Test files
    __mocks__/          # VS Code API mocks for unit testing
      vscode.ts         # Mock implementation of the vscode module
    unit/               # Unit tests (mirrors src/ structure)
    integration/        # Integration tests
    e2e/                # End-to-end tests (run in VS Code instance)
    setup.ts            # Global test setup
  test-reports/         # Generated test reports (gitignored)
  webview-ui/           # React webview UI
    src/
      components/       # React components
      hooks/            # Custom React hooks
      styles/           # CSS files
  package.json          # Extension manifest and npm config
  tsconfig.json         # TypeScript configuration
  esbuild.mjs           # Extension bundler configuration
  vitest.config.ts      # Unit test configuration
  vitest.integration.config.ts  # Integration test configuration
  GROUND_RULES.md       # Non-negotiable development rules (TDD, hooks)
```

---

## Local LLM Setup

Champ supports multiple local LLM backends. You only need one for development, but you can configure multiple.

### Ollama (Recommended)

Ollama is the easiest way to run local models. It handles model downloading and serving.

```bash
# Install Ollama
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS (via Homebrew)
brew install ollama

# Start the Ollama server
ollama serve

# Pull recommended models
# Main chat/agent model
ollama pull llama3.1

# Small autocomplete model
ollama pull qwen2.5-coder:1.5b

# Embedding model for indexing
ollama pull nomic-embed-text

# Verify Ollama is running
curl http://localhost:11434/api/tags
```

**VS Code Settings for Ollama:**

```json
{
  "champ.provider": "ollama",
  "champ.ollama.baseUrl": "http://localhost:11434",
  "champ.ollama.model": "llama3.1",
  "champ.autocomplete.model": "qwen2.5-coder:1.5b",
  "champ.indexing.embeddingProvider": "ollama"
}
```

### llama.cpp Server

For direct control over model serving with GGUF files.

```bash
# Clone and build llama.cpp
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
make -j$(nproc)

# For CUDA GPU support
make -j$(nproc) GGML_CUDA=1

# For Apple Silicon Metal support
make -j$(nproc) GGML_METAL=1

# Download a GGUF model (example: Llama 3.1 8B Q4)
# Place it in a models/ directory

# Start the server with OpenAI-compatible API
./llama-server \
  -m models/llama-3.1-8b-q4_k_m.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  -c 8192 \
  -ngl 99 \
  --threads $(nproc)

# Verify the server is running
curl http://localhost:8080/v1/models
```

**VS Code Settings for llama.cpp:**

```json
{
  "champ.provider": "llamacpp",
  "champ.llamacpp.baseUrl": "http://localhost:8080",
  "champ.llamacpp.model": "default"
}
```

### vLLM

For high-throughput inference with GPU support.

```bash
# Install vLLM (requires Python 3.9+ and CUDA)
pip install vllm

# Start the server
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.1-8B-Instruct \
  --host 0.0.0.0 \
  --port 8000

# Verify the server is running
curl http://localhost:8000/v1/models
```

**VS Code Settings for vLLM:**

```json
{
  "champ.provider": "vllm",
  "champ.vllm.baseUrl": "http://localhost:8000",
  "champ.vllm.model": "meta-llama/Llama-3.1-8B-Instruct"
}
```

### Cloud Providers (Optional)

For development with cloud LLMs:

```json
{
  "champ.provider": "claude",
  "champ.claude.apiKey": "sk-ant-...",
  "champ.claude.model": "claude-sonnet-4-20250514"
}
```

```json
{
  "champ.provider": "openai",
  "champ.openai.apiKey": "sk-...",
  "champ.openai.model": "gpt-4o"
}
```

```json
{
  "champ.provider": "gemini",
  "champ.gemini.apiKey": "AI...",
  "champ.gemini.model": "gemini-2.0-flash"
}
```

**Important**: Never commit API keys. Use VS Code's secret storage or environment variables.

---

## Running the Extension in Development

### Using VS Code Launch Configuration (Recommended)

The project includes a pre-configured launch configuration in `.vscode/launch.json`.

1. Open the project in VS Code: `code .`
2. Press `F5` (or `Run > Start Debugging`)
3. Select **"Run Extension"** from the launch configuration dropdown
4. A new VS Code window opens with the extension loaded (the "Extension Development Host")
5. Open the Champ sidebar by clicking the Champ icon in the activity bar

The launch configuration automatically:
- Compiles the TypeScript code (`npm run compile`)
- Starts the extension in a new VS Code instance
- Attaches the debugger for breakpoints

### Watch Mode (for iterative development)

Open three terminal tabs:

```bash
# Terminal 1: Watch extension TypeScript
npm run watch:extension

# Terminal 2: Watch webview React code
npm run watch:webview

# Terminal 3: Watch type checking
npm run watch:types
```

Or run all watchers together:

```bash
npm run watch
```

Then press `F5` to launch the extension. After code changes, press `Ctrl+Shift+F5` to reload the Extension Development Host.

### Manual Compilation

```bash
# Compile extension
npm run compile

# Compile webview
npm run compile:webview

# Compile both for production
npm run package
```

---

## Running Tests

### Unit Tests

Unit tests run with vitest, mocking the `vscode` module via `test/__mocks__/vscode.ts`.

```bash
# Run all unit tests
npm run test:unit

# Run with verbose output
npx vitest run --config vitest.config.ts --reporter=verbose

# Run a specific test file
npx vitest run test/unit/providers/claude.test.ts

# Run tests matching a pattern
npx vitest run --config vitest.config.ts -t "should stream"

# Run in watch mode (re-runs on file changes)
npx vitest --config vitest.config.ts
```

### Integration Tests

Integration tests verify module interactions. They may require external services (e.g., Ollama).

```bash
# Run all integration tests
npm run test:integration

# Run with extended timeout (30s per test)
npx vitest run --config vitest.integration.config.ts

# Run a specific integration test
npx vitest run test/integration/providers/ollama-live.test.ts
```

Integration tests that require external services (Ollama, llama.cpp) should check for availability and skip gracefully:

```typescript
import { describe, it, beforeAll } from 'vitest';

describe('Ollama Live', () => {
  let available = false;

  beforeAll(async () => {
    try {
      const res = await fetch('http://localhost:11434/api/tags');
      available = res.ok;
    } catch {
      available = false;
    }
  });

  it('should list models', async ({ skip }) => {
    if (!available) skip('Ollama not running');
    // ... test logic
  });
});
```

### End-to-End Tests

E2E tests run inside a real VS Code instance using `@vscode/test-electron`.

```bash
# Run E2E tests
npm run test:e2e

# This compiles the extension and launches a VS Code instance
# The test framework controls the VS Code window programmatically
```

### Running All Tests

```bash
# Run unit + integration tests (used by pre-commit and post-commit hooks)
npm test

# Generate a full test report (same as post-commit hook)
node scripts/run-tests-and-report.js
```

### Test Coverage

```bash
# Generate coverage report
npx vitest run --config vitest.config.ts --coverage

# Coverage report is output to:
#   - Terminal (text)
#   - coverage/index.html (HTML)
#   - coverage/coverage-final.json (JSON)
```

---

## Understanding the Git Hooks

The project uses **husky** to enforce quality gates on every commit.

### Pre-Commit Hook

Runs **before** the commit is finalized. If any step fails, the commit is aborted.

```bash
# .husky/pre-commit
npx lint-staged      # ESLint --fix + Prettier on staged .ts/.tsx files
npm run check-types   # TypeScript type checking (tsc --noEmit)
```

**lint-staged** configuration (in `package.json`):

```json
{
  "lint-staged": {
    "*.{ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ]
  }
}
```

### Post-Commit Hook

Runs **after** the commit succeeds. Generates a test report.

```bash
# .husky/post-commit
node scripts/run-tests-and-report.js
```

The `run-tests-and-report.js` script:

1. Reads the current branch name and commit hash
2. Runs `vitest run --reporter=json`
3. Parses the JSON output into the report format
4. Saves the report to `test-reports/<branch>_<commit>_<timestamp>.json`
5. Prints a summary to stdout
6. Exits with non-zero if tests failed

### Test Report Files

Reports are stored locally in `test-reports/` (gitignored). Naming convention:

```
test-reports/<branch-name>_<commit-short-hash>_<timestamp>.json
```

Example:

```
test-reports/feature-providers_a1b2c3d_2026-04-05T22-30-00.json
```

Each report contains test counts (total, passed, failed, skipped), duration, and failure details. See `GROUND_RULES.md` for the full report schema.

---

## Building and Packaging

### Build for Development

```bash
# Compile TypeScript to dist/extension.js (unminified, with sourcemaps)
npm run compile
```

### Build for Production

```bash
# Compile with minification, no sourcemaps
npm run package
```

### Package as .vsix

To create a distributable `.vsix` file for manual installation or marketplace publishing:

```bash
# Install vsce (VS Code Extension CLI) globally
npm install -g @vscode/vsce

# Package the extension
vsce package

# This produces: champ-0.1.0.vsix
```

### Install .vsix Locally

```bash
# Install in VS Code
code --install-extension champ-0.1.0.vsix

# Or via the VS Code UI:
# Extensions sidebar > "..." menu > "Install from VSIX..."
```

### Publish to Marketplace

```bash
# Login to your publisher account
vsce login champ-oss

# Publish
vsce publish

# Or publish a specific version
vsce publish 0.1.0
```

---

## Configuration Reference

All settings are prefixed with `champ.` and configured in VS Code Settings (JSON).

### Provider Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `champ.provider` | string | `"claude"` | Active LLM provider |
| `champ.claude.apiKey` | string | | Anthropic API key |
| `champ.claude.model` | string | `"claude-sonnet-4-20250514"` | Claude model |
| `champ.openai.apiKey` | string | | OpenAI API key |
| `champ.openai.model` | string | `"gpt-4o"` | OpenAI model |
| `champ.gemini.apiKey` | string | | Google Gemini API key |
| `champ.gemini.model` | string | `"gemini-2.0-flash"` | Gemini model |
| `champ.ollama.baseUrl` | string | `"http://localhost:11434"` | Ollama server URL |
| `champ.ollama.model` | string | `"llama3.1"` | Ollama model |
| `champ.llamacpp.baseUrl` | string | `"http://localhost:8080"` | llama.cpp server URL |
| `champ.llamacpp.model` | string | `"default"` | llama.cpp model |
| `champ.vllm.baseUrl` | string | `"http://localhost:8000"` | vLLM server URL |
| `champ.vllm.model` | string | | vLLM model |
| `champ.openaiCompatible.baseUrl` | string | | OpenAI-compatible base URL |
| `champ.openaiCompatible.model` | string | | OpenAI-compatible model |
| `champ.openaiCompatible.apiKey` | string | | OpenAI-compatible API key |

### Feature Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `champ.yoloMode` | boolean | `false` | Skip approval for tool calls |
| `champ.autoFix.enabled` | boolean | `true` | Auto-fix lint/type errors after code gen |
| `champ.autoFix.maxIterations` | number | `3` | Max auto-fix retry iterations |
| `champ.indexing.enabled` | boolean | `true` | Enable workspace indexing |
| `champ.indexing.embeddingProvider` | string | `"ollama"` | Embedding provider for indexing |
| `champ.autocomplete.enabled` | boolean | `true` | Enable inline autocomplete |
| `champ.autocomplete.debounceMs` | number | `300` | Autocomplete debounce delay |
| `champ.autocomplete.model` | string | `"qwen2.5-coder:1.5b"` | Model for autocomplete |
| `champ.userRules` | string | `""` | Global rules for all projects |
| `champ.mcp.servers` | array | `[]` | MCP server configurations |

### Keyboard Shortcuts

| Shortcut | Command | Description |
|---|---|---|
| `Ctrl+Shift+L` / `Cmd+Shift+L` | `champ.newChat` | Start a new chat |
| `Ctrl+Shift+M` / `Cmd+Shift+M` | `champ.toggleMode` | Toggle between modes |

---

## Troubleshooting

### Extension does not activate

1. Check the VS Code version: `code --version` (must be 1.93+)
2. Check the developer console: `Help > Toggle Developer Tools > Console`
3. Look for errors in the Output panel: `View > Output > Champ`

### Ollama connection refused

1. Verify Ollama is running: `curl http://localhost:11434/api/tags`
2. If running in Docker/WSL, check that localhost resolves correctly
3. Try the explicit IP: set `champ.ollama.baseUrl` to `http://127.0.0.1:11434`

### Type check errors after pulling

```bash
# Clean and reinstall
rm -rf node_modules dist
npm install
npm run check-types
```

### Tests fail with "Cannot find module 'vscode'"

The `vscode` module is mocked in `test/__mocks__/vscode.ts` and aliased in `vitest.config.ts`. Verify the alias is present:

```typescript
// vitest.config.ts
resolve: {
  alias: {
    vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
  },
},
```

### Pre-commit hook blocks commit

The pre-commit hook runs lint and type checking. If it blocks:

```bash
# See what lint errors exist
npm run lint

# Auto-fix lint issues
npx eslint src/ test/ --ext .ts,.tsx --fix

# Check types
npm run check-types
```

Fix the issues and try committing again. Do not bypass hooks with `--no-verify` unless absolutely necessary.

### Post-commit test report shows failures

Check the generated report in `test-reports/`. The file name includes the branch and commit:

```bash
ls -lt test-reports/ | head -5
```

Read the latest report to see which tests failed and why.

### Webview is blank

1. Verify the webview was compiled: `ls webview-ui/dist/`
2. Recompile: `npm run compile:webview`
3. Reload the Extension Development Host: `Ctrl+Shift+F5`

### Out of memory during indexing

For large workspaces, indexing may consume significant memory. Mitigations:

1. Increase Node.js heap size: Add `"NODE_OPTIONS": "--max-old-space-size=4096"` to the launch configuration
2. Reduce indexing scope: Add patterns to `.gitignore` (indexed files respect gitignore)
3. Disable indexing temporarily: Set `champ.indexing.enabled` to `false`
