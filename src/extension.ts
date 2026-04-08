/**
 * AIDev extension entry point.
 *
 * Activation philosophy: never crash. Even if the configured LLM
 * provider fails to load (missing API key, unreachable server, bad
 * config), the chat view, commands, and status bar are always
 * registered so the user has a working UI to fix the problem from.
 *
 * Provider failures are reported via:
 *   - the chat panel itself (red error bubble)
 *   - the status bar item (shows "AIDev: error" with hover details)
 *   - a one-time toast on activation
 */
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { ProviderRegistry } from "./providers/registry";
import { ProviderFactory } from "./providers/factory";
import { ToolRegistry } from "./tools/registry";
import { readFileTool } from "./tools/read-file";
import { editFileTool } from "./tools/edit-file";
import { createFileTool } from "./tools/create-file";
import { deleteFileTool } from "./tools/delete-file";
import { listDirectoryTool } from "./tools/list-directory";
import { runTerminalTool } from "./tools/run-terminal";
import { grepSearchTool } from "./tools/grep-search";
import { fileSearchTool } from "./tools/file-search";
import { AgentController, type AgentMode } from "./agent/agent-controller";
import { ChatViewProvider } from "./ui/chat-view-provider";
import { AidevInlineCompletionProvider } from "./completion/inline-provider";
import { MetricsCollector } from "./observability/metrics-collector";
import { ChunkingService } from "./indexing/chunking-service";
import { RepoMapBuilder } from "./indexing/repo-map-builder";
import { ContextResolver } from "./agent/context-resolver";
import { ConfigLoader, type AidevConfig } from "./config/config-loader";
import { SkillRegistry } from "./skills/skill-registry";
import { SkillLoader } from "./skills/skill-loader";
import { VariableResolver } from "./skills/variable-resolver";
import { BUILT_IN_SKILL_TEXTS } from "./skills/built-in";
import type { LLMProvider } from "./providers/types";

/**
 * Module-level singletons. Held so the deactivate() hook can dispose
 * them cleanly.
 */
let providerRegistry: ProviderRegistry | undefined;
let chatViewProvider: ChatViewProvider | undefined;
let metrics: MetricsCollector | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("AIDev extension activating...");

  // ---- Singletons that don't depend on the provider ------------------
  providerRegistry = new ProviderRegistry();
  metrics = new MetricsCollector();
  const factory = new ProviderFactory();

  // ---- Tool registry --------------------------------------------------
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(createFileTool);
  toolRegistry.register(deleteFileTool);
  toolRegistry.register(listDirectoryTool);
  toolRegistry.register(runTerminalTool);
  toolRegistry.register(grepSearchTool);
  toolRegistry.register(fileSearchTool);

  // ---- Status bar item -----------------------------------------------
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "aidev.openSettings";
  statusBarItem.text = "$(loading~spin) AIDev";
  statusBarItem.tooltip = "AIDev — click to open settings";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ---- Agent controller (created with a placeholder provider) --------
  // We use a stub provider until the real one loads. This way the chat
  // view, commands, and inline completion can register before any
  // network/SDK errors happen.
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const stubProvider = createStubProvider("not-configured");
  const agentController = new AgentController(
    stubProvider,
    toolRegistry,
    workspaceRoot,
  );

  agentController.onStreamDelta((delta) => {
    if (delta.type === "done" && delta.usage) {
      metrics?.recordRequest({
        requestLatency: 0,
        totalLatency: 0,
        inputTokens: delta.usage.inputTokens,
        outputTokens: delta.usage.outputTokens,
      });
    } else if (delta.type === "error" && delta.error) {
      metrics?.recordFailure(delta.error);
    }
  });

  // ---- Indexing services for grounding -------------------------------
  // Repo map: built lazily on first chat turn from the workspace's
  // top-level files. The cached result is invalidated when the user
  // starts a new chat. See docs/HALLUCINATION_MITIGATION.md.
  const chunkingService = new ChunkingService();
  const repoMapBuilder = new RepoMapBuilder(chunkingService);
  agentController.setRepoMapProvider({
    async getRepoMap(): Promise<string> {
      try {
        const uris = await vscode.workspace.findFiles(
          "**/*.{ts,tsx,js,jsx,mjs,cjs}",
          "**/{node_modules,dist,out,.git,test-reports}/**",
          200,
        );
        const files = await Promise.all(
          uris.map(async (uri) => ({
            path: vscode.workspace.asRelativePath(uri),
            content: new TextDecoder().decode(
              await vscode.workspace.fs.readFile(uri),
            ),
          })),
        );
        return repoMapBuilder.buildFromFiles(files);
      } catch {
        return "";
      }
    },
  });

  // ---- @-symbol context resolver -------------------------------------
  // Wire ContextResolver so chat input can use @Files, @Folders,
  // @Codebase, etc. The codebase indexing service is a stub for now;
  // @Codebase will return empty results until Round 4.
  const contextResolver = new ContextResolver({
    workspaceRoot,
    indexingService: {
      search: async () => [],
    },
    webSearchTool: {
      execute: async () => ({
        success: false,
        output: "Web search not yet wired",
      }),
    },
  });

  // ---- Skills registry ------------------------------------------------
  // Built-in skills are inlined as TS constants and registered first.
  // User and workspace skills are loaded from disk after — they have
  // higher precedence so the user can override any built-in.
  const skillRegistry = new SkillRegistry();
  for (const { text } of BUILT_IN_SKILL_TEXTS) {
    try {
      skillRegistry.register(SkillLoader.parseFile(text, "built-in"));
    } catch (err) {
      console.error("AIDev: failed to load built-in skill:", err);
    }
  }
  await loadSkillsFromDirectory(
    skillRegistry,
    workspaceRoot ? path.join(workspaceRoot, ".aidev", "skills") : null,
    "workspace",
  );
  await loadSkillsFromDirectory(
    skillRegistry,
    path.join(os.homedir(), ".aidev", "skills"),
    "user",
  );

  // Watch user/workspace skill directories for live reload.
  if (workspaceRoot) {
    const wsSkillsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".aidev/skills/*.md"),
    );
    const reloadWorkspaceSkills = () =>
      loadSkillsFromDirectory(
        skillRegistry,
        path.join(workspaceRoot, ".aidev", "skills"),
        "workspace",
      );
    wsSkillsWatcher.onDidChange(() => void reloadWorkspaceSkills());
    wsSkillsWatcher.onDidCreate(() => void reloadWorkspaceSkills());
    wsSkillsWatcher.onDidDelete(() => void reloadWorkspaceSkills());
    context.subscriptions.push(wsSkillsWatcher);
  }

  // ---- Chat view ------------------------------------------------------
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    agentController,
  );
  chatViewProvider.setContextResolver(contextResolver);
  chatViewProvider.setSkillRegistry(skillRegistry);
  chatViewProvider.setSkillContext(
    {
      build: (userInput: string) => buildSkillContext(workspaceRoot, userInput),
    },
    (template, ctx) => VariableResolver.resolve(template, ctx),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
    ),
  );

  // ---- Inline completion ----------------------------------------------
  // The inline provider holds a *reference* to the active provider, so
  // when we hot-swap below the same instance picks it up.
  const inlineProviderRef: { current: LLMProvider } = { current: stubProvider };
  const inlineProvider = new AidevInlineCompletionProvider(stubProvider);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      {
        async provideInlineCompletionItems(
          document,
          position,
          _context,
          token,
        ) {
          if (!isProviderReady()) return [];
          const prefix = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position),
          );
          const suffix = document.getText(
            new vscode.Range(
              position,
              document.lineAt(document.lineCount - 1).range.end,
            ),
          );
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());

          const completions = await inlineProvider.provideCompletions(
            prefix,
            {
              filePath: vscode.workspace.asRelativePath(document.uri),
              language: document.languageId,
              lineNumber: position.line + 1,
              suffix,
            },
            abort.signal,
          );

          return completions.map(
            (c) =>
              new vscode.InlineCompletionItem(
                c.text,
                new vscode.Range(position, position),
              ),
          );
        },
      },
    ),
  );

  // ---- Commands -------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("aidev.newChat", () => {
      agentController.reset();
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
    }),
    vscode.commands.registerCommand("aidev.toggleMode", async () => {
      const pick = await vscode.window.showQuickPick(
        ["agent", "ask", "manual", "plan", "composer"],
        { placeHolder: "Select agent mode" },
      );
      if (pick) {
        agentController.setMode(pick as AgentMode);
        chatViewProvider?.postMessage({
          type: "modeChanged",
          mode: pick as never,
        });
      }
    }),
    vscode.commands.registerCommand("aidev.indexWorkspace", () => {
      void vscode.window.showInformationMessage(
        "AIDev: codebase indexing is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("aidev.restoreCheckpoint", () => {
      void vscode.window.showInformationMessage(
        "AIDev: checkpoint restore is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("aidev.openSettings", () => {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "aidev",
      );
    }),
    vscode.commands.registerCommand("aidev.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        ["claude", "openai", "gemini", "openai-compatible", "vllm"],
        { placeHolder: "Which provider's API key are you setting?" },
      );
      if (!provider) return;
      const key = await vscode.window.showInputBox({
        prompt: `Enter API key for ${provider}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      const settingMap: Record<string, string> = {
        claude: "aidev.claude.apiKey",
        openai: "aidev.openai.apiKey",
        gemini: "aidev.gemini.apiKey",
        "openai-compatible": "aidev.openaiCompatible.apiKey",
        vllm: "aidev.vllm.apiKey",
      };
      await context.secrets.store(settingMap[provider], key);
      void vscode.window.showInformationMessage(
        `AIDev: ${provider} API key saved. Reloading provider...`,
      );
      await loadProvider();
    }),
    vscode.commands.registerCommand("aidev.generateConfig", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage(
          "AIDev: open a workspace folder before generating a config file.",
        );
        return;
      }
      const targetUri = vscode.Uri.file(
        path.join(workspaceRoot, ".aidev", "config.yaml"),
      );
      // Don't overwrite an existing file silently.
      try {
        await vscode.workspace.fs.stat(targetUri);
        const choice = await vscode.window.showWarningMessage(
          ".aidev/config.yaml already exists. Overwrite?",
          { modal: true },
          "Overwrite",
          "Cancel",
        );
        if (choice !== "Overwrite") return;
      } catch {
        // File doesn't exist — fall through.
      }
      const template = generateDefaultConfigYaml();
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(path.join(workspaceRoot, ".aidev")),
        );
      } catch {
        // Directory may already exist.
      }
      await vscode.workspace.fs.writeFile(
        targetUri,
        new TextEncoder().encode(template),
      );
      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage(
        "AIDev: created .aidev/config.yaml. Edit it and save to apply.",
      );
    }),
  );

  // ---- Config loader (YAML + VS Code settings fallback) -------------
  /**
   * Resolve the effective AidevConfig from (in order of precedence):
   *   1. <workspace>/.aidev/config.yaml
   *   2. ~/.aidev/config.yaml
   *   3. VS Code aidev.* settings (legacy backward-compat)
   *   4. built-in defaults
   *
   * Returns null when no source has a usable config — the loader path
   * is then skipped and the caller falls back to createFromConfig().
   * Errors during YAML parsing are surfaced to the user but do not
   * crash activation.
   */
  const resolveConfig = async (): Promise<AidevConfig | null> => {
    const workspacePath = workspaceRoot
      ? path.join(workspaceRoot, ".aidev", "config.yaml")
      : null;
    const userPath = path.join(os.homedir(), ".aidev", "config.yaml");

    let workspaceConfig: AidevConfig | null = null;
    let userConfig: AidevConfig | null = null;

    if (workspacePath) {
      try {
        const data = await vscode.workspace.fs.readFile(
          vscode.Uri.file(workspacePath),
        );
        workspaceConfig = ConfigLoader.parseYaml(
          new TextDecoder().decode(data),
        );
      } catch (err) {
        // File doesn't exist OR contains invalid YAML. Distinguish by
        // checking the error message — fs.readFile throws with a
        // FileSystemError code for missing files which we ignore.
        if (err instanceof Error && /Invalid YAML/.test(err.message)) {
          void vscode.window.showErrorMessage(
            `AIDev: ${workspacePath} has invalid YAML — ${err.message}`,
          );
        }
      }
    }

    try {
      const data = await vscode.workspace.fs.readFile(
        vscode.Uri.file(userPath),
      );
      userConfig = ConfigLoader.parseYaml(new TextDecoder().decode(data));
    } catch (err) {
      if (err instanceof Error && /Invalid YAML/.test(err.message)) {
        void vscode.window.showErrorMessage(
          `AIDev: ${userPath} has invalid YAML — ${err.message}`,
        );
      }
    }

    if (!workspaceConfig && !userConfig) return null;

    const merged = ConfigLoader.merge(userConfig ?? {}, workspaceConfig ?? {});
    return ConfigLoader.withDefaults(ConfigLoader.substituteEnv(merged));
  };

  // ---- Provider loader (callable on demand) ---------------------------
  /**
   * Try to (re)load the active provider. On success, hot-swaps it into
   * the agent controller, inline completion provider, and status bar.
   * On failure, leaves the stub in place and surfaces the error in the
   * chat panel + status bar.
   *
   * Tries the YAML config path first, falling back to legacy
   * VS Code settings if no YAML config is present.
   */
  const loadProvider = async (): Promise<void> => {
    setStatusLoading();
    try {
      const yamlConfig = await resolveConfig();
      const newProvider = yamlConfig
        ? await factory.createFromAidevConfig(yamlConfig, context.secrets)
        : await factory.createFromConfig(
            vscode.workspace.getConfiguration("aidev"),
            context.secrets,
          );
      // Apply mode and userRules from YAML if present.
      if (yamlConfig?.agent?.defaultMode) {
        agentController.setMode(yamlConfig.agent.defaultMode);
      }
      // Replace any prior real provider in the registry.
      try {
        providerRegistry?.unregister(inlineProviderRef.current.name);
      } catch {
        // First load — nothing to unregister.
      }
      providerRegistry?.register(newProvider);
      agentController.setProvider(newProvider);
      inlineProvider.setProvider(newProvider);
      inlineProviderRef.current = newProvider;
      setStatusReady(newProvider);
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message);
      chatViewProvider?.postMessage({
        type: "error",
        message: `AIDev provider not ready: ${message}\n\nOpen settings (gear icon in the status bar) to configure the active provider, or create a .aidev/config.yaml file.`,
      });
      console.error("AIDev: provider load failed:", err);
    }
  };

  function isProviderReady(): boolean {
    return inlineProviderRef.current.name !== "not-configured";
  }

  function setStatusLoading(): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(loading~spin) AIDev";
    statusBarItem.tooltip = "AIDev — loading provider…";
  }

  function setStatusReady(provider: LLMProvider): void {
    if (!statusBarItem) return;
    statusBarItem.text = `$(robot) AIDev: ${provider.name}`;
    statusBarItem.tooltip = `AIDev provider: ${provider.name} (${provider.config.model})\nClick to open settings`;
  }

  function setStatusError(message: string): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(error) AIDev: error";
    statusBarItem.tooltip = `AIDev provider error: ${message}\nClick to open settings`;
  }

  // Initial load. Failures here are non-fatal — the chat panel will
  // show the error and the user can fix it from settings.
  await loadProvider();

  // ---- Config change watchers -----------------------------------------
  // Watch VS Code aidev.* settings (legacy path).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("aidev")) return;
      await loadProvider();
    }),
  );

  // Watch .aidev/config.yaml in the workspace for live reload. Created,
  // changed, or deleted — any of those should trigger a provider reload
  // since the file is the source of truth when it exists.
  if (workspaceRoot) {
    const yamlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".aidev/config.yaml"),
    );
    yamlWatcher.onDidChange(() => void loadProvider());
    yamlWatcher.onDidCreate(() => void loadProvider());
    yamlWatcher.onDidDelete(() => void loadProvider());
    context.subscriptions.push(yamlWatcher);
  }

  console.log("AIDev extension activated");
}

export function deactivate(): void {
  providerRegistry?.disposeAll();
  providerRegistry = undefined;
  chatViewProvider = undefined;
  metrics = undefined;
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

/**
 * Stub provider used as a placeholder when no real provider has loaded
 * yet. Every call returns an error delta directing the user to settings.
 */
function createStubProvider(name: string): LLMProvider {
  return {
    name,
    config: {
      provider: name,
      model: "none",
      maxTokens: 0,
      temperature: 0,
    },
    async *chat(): AsyncIterable<never> {
      yield {
        type: "error",
        error:
          "No LLM provider is configured. Click the AIDev status bar item or run 'AIDev: Settings' to choose a provider.",
      } as never;
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as never;
    },
    async *complete(): AsyncIterable<never> {
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as never;
    },
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      id: "none",
      name: "none",
      provider: name,
      contextWindow: 0,
      maxOutputTokens: 0,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
  };
}

/**
 * Build a starter .aidev/config.yaml that the user can edit. Defaults
 * are conservative — Ollama at localhost since that's the most common
 * local-first setup. Uncommented blocks show every available knob.
 */
function generateDefaultConfigYaml(): string {
  return `# AIDev configuration — committed to git, shared with the team.
# User-level overrides live in ~/.aidev/config.yaml.
# API keys are NEVER stored here — use the 'AIDev: Set API Key' command.
# See docs/CONFIG.md for the full schema reference.

# Active provider — must match a key under 'providers:' below.
provider: ollama

providers:
  claude:
    model: claude-sonnet-4-20250514

  openai:
    model: gpt-4o

  gemini:
    model: gemini-2.0-flash

  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1

  llamacpp:
    baseUrl: http://localhost:8080/v1
    model: default

  vllm:
    baseUrl: http://localhost:8000/v1
    model: meta-llama/Llama-3.1-8B

  openai-compatible:
    baseUrl: http://localhost:9000/v1
    model: custom-model

# Inline ghost-text autocomplete settings.
autocomplete:
  enabled: true
  debounceMs: 300
  # Optional: use a different (smaller) provider for autocomplete.
  # provider: ollama
  # model: qwen2.5-coder:1.5b

agent:
  # Skip approval prompts for destructive tools (use with caution).
  yoloMode: false
  # Default mode when a chat session starts.
  defaultMode: agent
  # Auto-fix loop after edits — re-prompts the model with LSP errors.
  autoFix:
    enabled: true
    maxIterations: 3

indexing:
  enabled: true
  embeddingProvider: ollama
  ignore:
    - node_modules/**
    - dist/**
    - .git/**
    - test-reports/**

# User-level rules — always injected into the system prompt.
userRules: |
  Always write tests first.
  Use TypeScript strict mode where applicable.
  Prefer composition over inheritance.

# MCP server connections — extend the agent with external tools.
# Uncomment to enable.
# mcp:
#   servers:
#     - name: github
#       command: npx
#       args: ["-y", "@modelcontextprotocol/server-github"]
#       env:
#         GITHUB_TOKEN: \${env:GITHUB_TOKEN}
`;
}

/**
 * Read every .md file from the given directory and register it as a
 * skill of the given source. Existing skills with the same name are
 * compared via the registry's source-precedence rules. Errors during
 * file read or skill parsing are logged but don't crash activation.
 */
async function loadSkillsFromDirectory(
  registry: SkillRegistry,
  dir: string | null,
  source: "user" | "workspace",
): Promise<void> {
  if (!dir) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  } catch {
    // Directory doesn't exist — that's fine, no skills to load.
    return;
  }
  for (const [name, type] of entries) {
    if ((type & vscode.FileType.File) === 0) continue;
    if (!name.endsWith(".md")) continue;
    const filePath = path.join(dir, name);
    try {
      const data = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath),
      );
      const text = new TextDecoder().decode(data);
      const skill = SkillLoader.parseFile(text, source, filePath);
      registry.register(skill);
    } catch (err) {
      console.error(
        `AIDev: failed to load skill from ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Build a SkillContext from the current editor state. Used by the chat
 * view to resolve {{variables}} inside skill templates.
 *
 * Best-effort: any value that can't be determined (no active editor,
 * no git repo, etc.) is left undefined and resolves to empty string in
 * the variable resolver.
 */
function buildSkillContext(
  workspaceRoot: string,
  userInput: string,
): {
  workspaceRoot: string;
  date: string;
  selection?: string;
  currentFile?: string;
  language?: string;
  userInput: string;
  cursorLine?: number;
  branch?: string;
} {
  const editor = vscode.window.activeTextEditor;
  const date = new Date().toISOString().slice(0, 10);

  if (!editor) {
    return { workspaceRoot, date, userInput };
  }

  const doc = editor.document;
  const selection = editor.selection.isEmpty
    ? undefined
    : doc.getText(editor.selection);
  const currentFile = vscode.workspace.asRelativePath(doc.uri);
  const language = doc.languageId;
  const cursorLine = editor.selection.active.line + 1;

  return {
    workspaceRoot,
    date,
    selection,
    currentFile,
    language,
    userInput,
    cursorLine,
  };
}
