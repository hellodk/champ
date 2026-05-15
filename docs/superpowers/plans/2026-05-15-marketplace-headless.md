# Plan: Team Marketplace + Headless CLI Runner

**Date**: 2026-05-15  
**Goal**: (1) Add a community team marketplace (`champ.browseTeams` fetches a JSON manifest and lets the user download team YAML files). (2) Add a headless CLI runner (`scripts/run-team.ts`) for CI/cron use that runs a named team without VS Code.  
**Status**: Ready to execute

---

## Architecture

### Marketplace

`src/marketplace/team-marketplace-client.ts` fetches a JSON manifest from a configurable URL (default: `https://raw.githubusercontent.com/hellodk/champ/master/marketplace/manifest.json`). Manifest shape: `Array<MarketplaceEntry>`. `champ.browseTeams` command: QuickPick → download selected team YAML to `.champ/teams/<name>.yaml` in the workspace.

### Headless runner

`scripts/run-team.ts` is a standalone Node.js script with no VS Code imports. It accepts `--team`, `--task`, `--provider`, `--workspace` CLI flags, loads a team YAML via `TeamLoader`, constructs the provider, runs `TeamRunner.run()`, streams output to stdout/stderr, exits 0 on success or 1 on failure.

### Current state (baselines from code reading)

- `src/agent/team-loader.ts` lines 43-55: `TeamLoader` constructor takes `workspaceRoot`, `loadAll()` reads from `.champ/teams/*.yaml`.
- `src/agent/team-runner.ts` lines 509-525: `TeamRunner.run(team, userRequest, provider, toolRegistry, options)` — `options.onEvent` receives `TeamRunEvent`. `agent_stream` event has `{ type, agentId, chunk }`.
- `src/providers/ollama.ts` lines 62-71: `OllamaProvider(config: LLMProviderConfig)` — `config.baseUrl` defaults to `http://localhost:11434`.
- `src/providers/claude.ts` lines 30-41: `ClaudeProvider(config: LLMProviderConfig)` — lazy client init; throws if `apiKey` missing at first call.
- `LLMProviderConfig` must include `provider`, `model`, and optionally `baseUrl`, `apiKey`.

### Tech Stack

TypeScript (extension host + standalone Node), `js-yaml`, `node:fetch` (Node 18+), `vscode.window.showQuickPick`, `vscode.window.withProgress`.

---

## Tasks

### Task 1 — Create `TeamMarketplaceClient`

**File**: `src/marketplace/team-marketplace-client.ts`

**Step 1 — write failing test**

File: `src/marketplace/__tests__/team-marketplace-client.test.ts`

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { TeamMarketplaceClient, type MarketplaceEntry } from "../team-marketplace-client";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

const SAMPLE_MANIFEST: MarketplaceEntry[] = [
  {
    name: "devops",
    description: "DevOps team: plan, review, deploy",
    author: "hellodk",
    url: "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/teams/devops.yaml",
    tags: ["devops", "ci"],
  },
  {
    name: "fullstack",
    description: "Fullstack team",
    author: "hellodk",
    url: "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/teams/fullstack.yaml",
    tags: ["frontend", "backend"],
  },
];

describe("TeamMarketplaceClient.fetchManifest", () => {
  it("returns parsed manifest on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_MANIFEST,
    });

    const client = new TeamMarketplaceClient();
    const entries = await client.fetchManifest();
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("devops");
    expect(entries[1].tags).toContain("backend");
  });

  it("returns empty array on network error (graceful fallback)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"));

    const client = new TeamMarketplaceClient();
    const entries = await client.fetchManifest();
    expect(entries).toEqual([]);
  });

  it("returns empty array when fetch returns non-ok status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });

    const client = new TeamMarketplaceClient();
    const entries = await client.fetchManifest();
    expect(entries).toEqual([]);
  });

  it("uses a custom manifest URL when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const client = new TeamMarketplaceClient("https://example.com/manifest.json");
    await client.fetchManifest();
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/manifest.json");
  });
});

describe("TeamMarketplaceClient.downloadTeam", () => {
  it("fetches the entry URL and saves to destDir/<name>.yaml", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-test-"));
    const yamlContent = "name: devops\nagents: []\n";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => yamlContent,
    });

    const client = new TeamMarketplaceClient();
    const entry: MarketplaceEntry = {
      name: "devops",
      description: "DevOps team",
      author: "hellodk",
      url: "https://example.com/devops.yaml",
      tags: [],
    };

    const savedPath = await client.downloadTeam(entry, tmpDir);
    expect(savedPath).toBe(path.join(tmpDir, "devops.yaml"));

    const written = await fs.readFile(savedPath, "utf8");
    expect(written).toBe(yamlContent);

    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws when the download request fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });

    const client = new TeamMarketplaceClient();
    await expect(
      client.downloadTeam(
        { name: "x", description: "", author: "", url: "https://example.com/x.yaml", tags: [] },
        "/tmp",
      ),
    ).rejects.toThrow(/403/);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/marketplace/__tests__/team-marketplace-client.test.ts 2>&1 | tail -15`  
Expected: failures (module doesn't exist).

**Step 2 — create directory and implement**

```bash
mkdir -p /home/dk/Documents/git/vs-code-plugin/src/marketplace
```

File: `src/marketplace/team-marketplace-client.ts`

```typescript
/**
 * TeamMarketplaceClient: fetches and downloads community team definitions.
 *
 * The manifest is a JSON array of MarketplaceEntry objects hosted at a
 * configurable URL. On network errors the client degrades gracefully by
 * returning an empty array so the command remains responsive.
 */
import * as path from "path";
import * as fs from "fs/promises";

export interface MarketplaceEntry {
  name: string;
  description: string;
  author: string;
  url: string;
  tags: string[];
}

const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/manifest.json";

export class TeamMarketplaceClient {
  constructor(private readonly manifestUrl: string = DEFAULT_MANIFEST_URL) {}

  /**
   * Fetch the community manifest. Returns an empty array on any network
   * or parse error so the calling command can show a graceful message.
   */
  async fetchManifest(): Promise<MarketplaceEntry[]> {
    try {
      const res = await fetch(this.manifestUrl);
      if (!res.ok) return [];
      const data = (await res.json()) as MarketplaceEntry[];
      if (!Array.isArray(data)) return [];
      return data;
    } catch {
      return [];
    }
  }

  /**
   * Download the YAML for a single marketplace entry and save it to
   * `path.join(destDir, entry.name + ".yaml")`. Returns the saved path.
   * Throws if the HTTP request fails.
   */
  async downloadTeam(entry: MarketplaceEntry, destDir: string): Promise<string> {
    const res = await fetch(entry.url);
    if (!res.ok) {
      throw new Error(
        `Failed to download team "${entry.name}": ${res.status} ${res.statusText}`,
      );
    }
    const content = await res.text();
    await fs.mkdir(destDir, { recursive: true });
    const filePath = path.join(destDir, `${entry.name}.yaml`);
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }
}
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/marketplace/__tests__/team-marketplace-client.test.ts 2>&1 | tail -15`  
Expected: all 6 tests pass.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/marketplace/team-marketplace-client.ts src/marketplace/__tests__/team-marketplace-client.test.ts
git commit -m "feat: add TeamMarketplaceClient with fetchManifest and downloadTeam"
```

---

### Task 2 — Create `marketplace/manifest.json` with sample entries

**File**: `marketplace/manifest.json` (repo root)

**Step 1 — verify directory**

```bash
ls /home/dk/Documents/git/vs-code-plugin/marketplace 2>/dev/null || echo "absent"
```

**Step 2 — create**

```bash
mkdir -p /home/dk/Documents/git/vs-code-plugin/marketplace
```

File: `marketplace/manifest.json`

```json
[
  {
    "name": "devops",
    "description": "DevOps team: planner designs the pipeline, reviewer audits config, deployer runs the commands.",
    "author": "hellodk",
    "url": "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/teams/devops.yaml",
    "tags": ["devops", "ci", "deploy", "infrastructure"]
  },
  {
    "name": "fullstack",
    "description": "Full-stack team: frontend specialist builds UI components, backend specialist handles APIs and data.",
    "author": "hellodk",
    "url": "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/teams/fullstack.yaml",
    "tags": ["frontend", "backend", "fullstack", "web"]
  },
  {
    "name": "code-review",
    "description": "Code review team: security auditor, performance reviewer, and style checker collaborate on PRs.",
    "author": "hellodk",
    "url": "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/teams/code-review.yaml",
    "tags": ["review", "quality", "security", "performance"]
  },
  {
    "name": "incident-response",
    "description": "Incident response team: triage agent diagnoses the issue, fix agent applies the patch, verifier confirms resolution.",
    "author": "hellodk",
    "url": "https://raw.githubusercontent.com/hellodk/champ/master/marketplace/teams/incident-response.yaml",
    "tags": ["incident", "ops", "debugging", "monitoring"]
  }
]
```

**Step 3 — write test**

File: `src/marketplace/__tests__/manifest-json.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("marketplace/manifest.json", () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "../../../marketplace/manifest.json"), "utf8"),
  ) as Array<{ name: string; description: string; author: string; url: string; tags: string[] }>;

  it("is a non-empty array", () => {
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest.length).toBeGreaterThan(0);
  });

  it("every entry has required fields", () => {
    for (const entry of manifest) {
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.author).toBeTruthy();
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });

  it("contains at least the devops and fullstack entries", () => {
    const names = manifest.map((e) => e.name);
    expect(names).toContain("devops");
    expect(names).toContain("fullstack");
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/marketplace/__tests__/manifest-json.test.ts 2>&1 | tail -10`  
Expected: all 3 tests pass.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add marketplace/manifest.json src/marketplace/__tests__/manifest-json.test.ts
git commit -m "feat: add marketplace/manifest.json with 4 sample community team entries"
```

---

### Task 3 — Register `champ.browseTeams` command

**Files**: `src/extension.ts`, `package.json`

**Step 1 — add to `package.json`**

In `package.json`, in `contributes.commands`, add:

```json
{
  "command": "champ.browseTeams",
  "title": "Champ: Browse Team Marketplace"
}
```

**Step 2 — write failing test**

```bash
grep -c "browseTeams" /home/dk/Documents/git/vs-code-plugin/src/extension.ts
```
Expected: `0` (not registered yet).

**Step 3 — implement in `extension.ts`**

Import `TeamMarketplaceClient` at the top of `extension.ts`:

```typescript
import { TeamMarketplaceClient } from "./marketplace/team-marketplace-client";
```

Register the command in the `activate` function (place near other team commands):

```typescript
vscode.commands.registerCommand("champ.browseTeams", async () => {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Champ: No workspace folder open.");
    return;
  }

  const client = new TeamMarketplaceClient();

  // Fetch manifest with progress indicator
  let entries: import("./marketplace/team-marketplace-client").MarketplaceEntry[] = [];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Fetching team marketplace...",
      cancellable: false,
    },
    async () => {
      entries = await client.fetchManifest();
    },
  );

  if (entries.length === 0) {
    vscode.window.showWarningMessage(
      "Champ: Marketplace manifest is empty or unreachable. Check your internet connection.",
    );
    return;
  }

  const picks = entries.map((e) => ({
    label: e.name,
    description: e.tags.join(", "),
    detail: `${e.description}  (by ${e.author})`,
    entry: e,
  }));

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: "Select a team to download",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) return;

  const destDir = path.join(workspaceRoot, ".champ", "teams");
  try {
    const savedPath = await client.downloadTeam(selected.entry, destDir);
    vscode.window.showInformationMessage(
      `Champ: Downloaded team "${selected.entry.name}" to ${savedPath}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Champ: Failed to download team — ${msg}`);
  }
}),
```

Note: `path` is imported at the top of `extension.ts` as `import * as path from "path"`. Verify before adding a duplicate import.

**Step 4 — verify registration**

```bash
grep -c "browseTeams" /home/dk/Documents/git/vs-code-plugin/src/extension.ts
```
Expected: `>= 1`.

**Step 5 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

**Step 6 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/extension.ts package.json
git commit -m "feat: register champ.browseTeams command — QuickPick marketplace with download"
```

---

### Task 4 — Add `scripts/run-team.ts` headless runner

**File**: `scripts/run-team.ts`

**Step 1 — write failing test**

File: `scripts/__tests__/run-team-args.test.ts`

```typescript
// Tests for argument parsing logic used by run-team.ts.
// We test the parsing helper in isolation without importing the full script.
import { describe, it, expect } from "vitest";

function parseArgs(argv: string[]): {
  team?: string;
  task?: string;
  provider: string;
  workspace: string;
} {
  const args = argv;
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  return {
    team: get("--team"),
    task: get("--task"),
    provider: get("--provider") ?? "ollama",
    workspace: get("--workspace") ?? process.cwd(),
  };
}

describe("run-team argument parsing", () => {
  it("parses --team and --task", () => {
    const r = parseArgs(["--team", "devops", "--task", "deploy the app"]);
    expect(r.team).toBe("devops");
    expect(r.task).toBe("deploy the app");
  });

  it("defaults provider to ollama", () => {
    const r = parseArgs(["--team", "devops", "--task", "x"]);
    expect(r.provider).toBe("ollama");
  });

  it("parses --provider claude", () => {
    const r = parseArgs(["--team", "devops", "--task", "x", "--provider", "claude"]);
    expect(r.provider).toBe("claude");
  });

  it("returns undefined for missing team", () => {
    const r = parseArgs(["--task", "x"]);
    expect(r.team).toBeUndefined();
  });

  it("parses --workspace", () => {
    const r = parseArgs(["--team", "t", "--task", "x", "--workspace", "/home/user/project"]);
    expect(r.workspace).toBe("/home/user/project");
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run scripts/__tests__/run-team-args.test.ts 2>&1 | tail -10`  
Expected: all 5 tests pass (they test a pure function, no imports needed).

**Step 2 — create directory and implement**

```bash
mkdir -p /home/dk/Documents/git/vs-code-plugin/scripts
```

File: `scripts/run-team.ts`

```typescript
/**
 * scripts/run-team.ts — headless team runner for CI/cron.
 *
 * Usage:
 *   node dist/scripts/run-team.js \
 *     --team <name> \
 *     --task "<task description>" \
 *     [--provider ollama|claude] \
 *     [--workspace <path>]
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  — required when --provider claude
 *   OLLAMA_BASE_URL    — Ollama base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL       — Ollama model name (default: llama3.1)
 *
 * Exit codes:
 *   0 — team run completed successfully
 *   1 — team not found, provider error, or run failed/paused
 */
import * as path from "path";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const teamArg = get("--team");
  const taskArg = get("--task");
  const providerArg = get("--provider") ?? "ollama";
  const workspaceArg = get("--workspace") ?? process.cwd();

  if (!teamArg || !taskArg) {
    console.error(
      "Usage: node run-team.js --team <name> --task <text> [--provider ollama|claude] [--workspace <path>]",
    );
    process.exit(1);
  }

  // Dynamic imports avoid loading VS Code APIs at module load time.
  const { TeamLoader } = await import("../src/agent/team-loader.js");
  const { TeamRunner } = await import("../src/agent/team-runner.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");

  const loader = new TeamLoader(workspaceArg);
  const teams = await loader.loadAll();
  const team = teams.find((t) => t.name === teamArg);

  if (!team) {
    console.error(
      `Team "${teamArg}" not found in ${path.join(workspaceArg, ".champ", "teams")}`,
    );
    process.exit(1);
  }

  // Construct the provider based on --provider flag.
  let provider;
  if (providerArg === "claude") {
    const { ClaudeProvider } = await import("../src/providers/claude.js");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY environment variable is required for the claude provider");
      process.exit(1);
    }
    provider = new ClaudeProvider({
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      apiKey,
    });
  } else {
    const { OllamaProvider } = await import("../src/providers/ollama.js");
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const model = process.env.OLLAMA_MODEL ?? "llama3.1";
    provider = new OllamaProvider({ provider: "ollama", model, baseUrl });
  }

  const toolRegistry = new ToolRegistry();
  const runner = new TeamRunner();

  console.log(`\nRunning team "${team.name}" on task: ${taskArg}\n`);

  const state = await runner.run(team, taskArg, provider, toolRegistry, {
    workspaceRoot: workspaceArg,
    onEvent: (e) => {
      if (e.type === "agent_stream") {
        process.stdout.write(e.chunk);
      } else if (e.type === "state_update") {
        const running = e.state.agents.find((a) => a.status === "running");
        if (running) {
          process.stderr.write(`\n[${running.name}] running...\n`);
        }
      } else if (e.type === "budget_warning") {
        process.stderr.write(
          `\n[warn] Token budget: ${e.usedTokens}/${e.budgetTokens} used\n`,
        );
      } else if (e.type === "blocked") {
        process.stderr.write(`\n[blocked] Agent "${e.agentId}": ${e.reason}\n`);
      } else if (e.type === "error") {
        process.stderr.write(`\n[error] ${e.message}\n`);
      } else if (e.type === "complete") {
        process.stderr.write(`\n[complete] Status: ${e.state.status}\n`);
      }
    },
  });

  console.log(`\nFinal status: ${state.status}`);

  if (state.status === "failed" || state.status === "paused") {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

**Step 3 — run test**

`cd /home/dk/Documents/git/vs-code-plugin && npx vitest run scripts/__tests__/run-team-args.test.ts 2>&1 | tail -10`  
Expected: all 5 tests pass.

**Step 4 — compile check**

`cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error`  
Expected: 0.

Note: `module: Node16` in `tsconfig.json` means `.js` extensions in import statements are required even though source files are `.ts`. TypeScript resolves `.js` → `.ts` at compile time. The compiled output goes to `dist/` (per `outDir: "dist"`), so the headless runner runs as `node dist/scripts/run-team.js`. Verify `scripts/` is included in tsconfig `include` or add it explicitly: check `tsconfig.json` `include` array and add `"scripts/**"` if absent.

```bash
grep -n "include\|scripts" /home/dk/Documents/git/vs-code-plugin/tsconfig.json
```

Current `tsconfig.json` has `"include": ["src/**/*.ts"]` — `scripts/` is NOT included. Add it:

```json
"include": ["src/**/*.ts", "scripts/**/*.ts"]
```

This is required for `tsc` to type-check and compile the headless runner. Without it, `node dist/scripts/run-team.js` will fail with "Cannot find module".

**Step 5 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add scripts/run-team.ts scripts/__tests__/run-team-args.test.ts
git commit -m "feat: add scripts/run-team.ts headless team runner for CI/cron"
```

---

### Task 4b — Add `scripts/` to tsconfig.json include

**File**: `tsconfig.json`

**Step 1** — Current state:

```bash
grep "include" /home/dk/Documents/git/vs-code-plugin/tsconfig.json
```
Expected: `"include": ["src/**/*.ts"]`

**Step 2** — Change `include` to:

```json
"include": ["src/**/*.ts", "scripts/**/*.ts"]
```

**Step 3** — Verify compile:

```bash
cd /home/dk/Documents/git/vs-code-plugin && npx tsc --noEmit 2>&1 | grep -c error
```
Expected: 0.

**Step 4** — Commit:

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add tsconfig.json
git commit -m "chore: add scripts/ to tsconfig include for headless runner compilation"
```

---

### Task 5 — Exclude `scripts/run-team.ts` from the `.vsix` package

**File**: `.vscodeignore`

**Step 1 — check current state**

```bash
grep -n "scripts" /home/dk/Documents/git/vs-code-plugin/.vscodeignore
```

**Step 2 — implement**

In `.vscodeignore`, add:

```
scripts/
```

If a `scripts/` line already exists, verify it covers `.ts` files. If only `*.ts` in the project root is excluded, add an explicit `scripts/**` entry.

**Step 3 — verify**

```bash
grep "scripts" /home/dk/Documents/git/vs-code-plugin/.vscodeignore
```
Expected: line present.

**Step 4 — commit**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add .vscodeignore
git commit -m "chore: exclude scripts/ directory from .vsix package"
```

---

### Task 6 — End-to-end test for `TeamMarketplaceClient`

**File**: `src/marketplace/__tests__/team-marketplace-e2e.test.ts`

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { TeamMarketplaceClient } from "../team-marketplace-client";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => vi.clearAllMocks());

describe("TeamMarketplaceClient end-to-end", () => {
  it("full flow: fetchManifest → showQuickPick selection → downloadTeam → file exists", async () => {
    const manifest = [
      {
        name: "ci-bot",
        description: "CI automation bot",
        author: "test",
        url: "https://example.com/ci-bot.yaml",
        tags: ["ci"],
      },
    ];

    // First call: fetchManifest
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => manifest });
    // Second call: downloadTeam
    const yamlContent = "name: ci-bot\nagents: []\n";
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => yamlContent });

    const client = new TeamMarketplaceClient();
    const entries = await client.fetchManifest();
    expect(entries).toHaveLength(1);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "champ-e2e-"));
    const savedPath = await client.downloadTeam(entries[0], tmpDir);

    const content = await fs.readFile(savedPath, "utf8");
    expect(content).toBe(yamlContent);
    expect(path.basename(savedPath)).toBe("ci-bot.yaml");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("returns [] and does not throw on completely failed network", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const client = new TeamMarketplaceClient();
    const entries = await client.fetchManifest();
    expect(entries).toEqual([]);
  });
});
```

Run: `cd /home/dk/Documents/git/vs-code-plugin && npx vitest run src/marketplace/__tests__/team-marketplace-e2e.test.ts 2>&1 | tail -10`  
Expected: 2 tests pass.

**Commit:**

```bash
cd /home/dk/Documents/git/vs-code-plugin
git add src/marketplace/__tests__/team-marketplace-e2e.test.ts
git commit -m "test: end-to-end tests for TeamMarketplaceClient fetch + download pipeline"
```

---

## Completion checklist

- [ ] `src/marketplace/team-marketplace-client.ts` with `MarketplaceEntry` interface, `fetchManifest()`, `downloadTeam()`
- [ ] `marketplace/manifest.json` with 4 sample entries (devops, fullstack, code-review, incident-response)
- [ ] `champ.browseTeams` in `package.json` contributes.commands
- [ ] `champ.browseTeams` command registered in `extension.ts` with QuickPick + download + progress indicator
- [ ] `scripts/run-team.ts` standalone headless runner (no VS Code imports at load time)
- [ ] `scripts/` in `.vscodeignore`
- [ ] `npx tsc --noEmit` 0 errors
- [ ] All test files green (marketplace-client, manifest-json, run-team-args, marketplace-e2e)
