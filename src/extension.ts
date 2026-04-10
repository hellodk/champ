/**
 * Champ extension entry point.
 *
 * Activation philosophy: never crash. Even if the configured LLM
 * provider fails to load (missing API key, unreachable server, bad
 * config), the chat view, commands, and status bar are always
 * registered so the user has a working UI to fix the problem from.
 *
 * Provider failures are reported via:
 *   - the chat panel itself (red error bubble)
 *   - the status bar item (shows "Champ: error" with hover details)
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
import { ChampInlineCompletionProvider } from "./completion/inline-provider";
import { MetricsCollector } from "./observability/metrics-collector";
import { ChunkingService } from "./indexing/chunking-service";
import { RepoMapBuilder } from "./indexing/repo-map-builder";
import { ContextResolver } from "./agent/context-resolver";
import { ConfigLoader, type ChampConfig } from "./config/config-loader";
import { SkillRegistry } from "./skills/skill-registry";
import { SkillLoader } from "./skills/skill-loader";
import { VariableResolver } from "./skills/variable-resolver";
import { BUILT_IN_SKILL_TEXTS } from "./skills/built-in";
import type { LLMProvider } from "./providers/types";
import type { AvailableProviderModel } from "./ui/messages";
import { SAMPLE_CONFIGS } from "./config/sample-configs";
import { AgentManager } from "./agent-manager/agent-manager";
import { SessionStore } from "./agent-manager/session-store";

/**
 * Module-level singletons. Held so the deactivate() hook can dispose
 * them cleanly.
 */
let providerRegistry: ProviderRegistry | undefined;
let chatViewProvider: ChatViewProvider | undefined;
let metrics: MetricsCollector | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let agentManager: AgentManager | undefined;
let sessionStore: SessionStore | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("Champ extension activating...");

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
  statusBarItem.command = "champ.openSettings";
  statusBarItem.text = "$(loading~spin) Champ-1.0.0";
  statusBarItem.tooltip = "Champ — click to open settings";
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

  // ---- Agent Manager (multi-session orchestrator) --------------------
  agentManager = new AgentManager(
    toolRegistry,
    workspaceRoot,
    () => inlineProviderRef?.current ?? stubProvider,
  );
  sessionStore = new SessionStore(
    path.join(workspaceRoot, ".champ", "sessions"),
  );

  // Stream metrics and session persistence are wired via
  // ChatViewProvider callbacks below (after chatViewProvider is created)
  // rather than on the standalone agentController, because the active
  // session's controller changes when the user switches sessions.

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
      console.error("Champ: failed to load built-in skill:", err);
    }
  }
  await loadSkillsFromDirectory(
    skillRegistry,
    workspaceRoot ? path.join(workspaceRoot, ".champ", "skills") : null,
    "workspace",
  );
  await loadSkillsFromDirectory(
    skillRegistry,
    path.join(os.homedir(), ".champ", "skills"),
    "user",
  );

  // Watch user/workspace skill directories for live reload.
  if (workspaceRoot) {
    const wsSkillsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".champ/skills/*.md"),
    );
    const reloadWorkspaceSkills = () =>
      loadSkillsFromDirectory(
        skillRegistry,
        path.join(workspaceRoot, ".champ", "skills"),
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
  // Auto-label sessions from the first user message.
  chatViewProvider.onUserMessage((text) => {
    const active = agentManager?.getActive();
    if (active && active.metadata.label === "New chat") {
      agentManager?.autoLabelSession(active.metadata.id, text);
      broadcastSessionList();
    }
  });
  // Metrics + session persistence — fires on every LLM turn completion.
  chatViewProvider.onStreamCompleted((usage) => {
    if (usage) {
      metrics?.recordRequest({
        requestLatency: 0,
        totalLatency: 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    }
    broadcastMetrics();
    saveActiveSession();
  });
  chatViewProvider.onStreamError((error) => {
    metrics?.recordFailure(error);
    broadcastMetrics();
    saveActiveSession();
  });
  // When the webview resolves, re-broadcast all state that may have
  // been sent before it was ready (provider status, session list).
  chatViewProvider.onWebviewReady(() => {
    const provider = inlineProviderRef.current;
    if (provider.name !== "not-configured") {
      const yamlConfig = null; // Re-resolve would be async; use cached available models.
      chatViewProvider?.broadcastProviderStatus({
        state: "ready",
        providerName: provider.name,
        modelName: provider.config.model,
        available: buildAvailableModels(yamlConfig),
      });
    }
    broadcastSessionList();
  });
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
  const inlineProvider = new ChampInlineCompletionProvider(stubProvider);
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
    vscode.commands.registerCommand("champ.newChat", () => {
      if (agentManager) {
        const session = agentManager.createSession();
        chatViewProvider?.setAgent(session.controller);
        void saveSession(session.metadata.id);
        broadcastSessionList();
      } else {
        agentController.reset();
      }
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
    }),
    vscode.commands.registerCommand("champ.toggleMode", async () => {
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
    vscode.commands.registerCommand("champ.indexWorkspace", () => {
      void vscode.window.showInformationMessage(
        "Champ: codebase indexing is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("champ.restoreCheckpoint", () => {
      void vscode.window.showInformationMessage(
        "Champ: checkpoint restore is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("champ.openSettings", () => {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "champ",
      );
    }),
    vscode.commands.registerCommand("champ.setApiKey", async () => {
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
        claude: "champ.claude.apiKey",
        openai: "champ.openai.apiKey",
        gemini: "champ.gemini.apiKey",
        "openai-compatible": "champ.openaiCompatible.apiKey",
        vllm: "champ.vllm.apiKey",
      };
      await context.secrets.store(settingMap[provider], key);
      void vscode.window.showInformationMessage(
        `Champ: ${provider} API key saved. Reloading provider...`,
      );
      await loadProvider();
    }),
    vscode.commands.registerCommand("champ.generateConfig", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage(
          "Champ: open a workspace folder before generating a config file.",
        );
        return;
      }
      const targetUri = vscode.Uri.file(
        path.join(workspaceRoot, ".champ", "config.yaml"),
      );
      // Don't overwrite an existing file silently.
      try {
        await vscode.workspace.fs.stat(targetUri);
        const choice = await vscode.window.showWarningMessage(
          ".champ/config.yaml already exists. Overwrite?",
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
          vscode.Uri.file(path.join(workspaceRoot, ".champ")),
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
        "Champ: created .champ/config.yaml. Edit it and save to apply.",
      );
    }),
    vscode.commands.registerCommand("champ.showHelp", async () => {
      // Open the bundled USER_GUIDE.md as an editor tab. The doc ships
      // with the extension so the URI lives under extensionUri.
      const helpUri = vscode.Uri.joinPath(
        context.extensionUri,
        "docs",
        "USER_GUIDE.md",
      );
      try {
        const doc = await vscode.workspace.openTextDocument(helpUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        void vscode.window.showErrorMessage(
          "Champ: USER_GUIDE.md is not bundled with this extension build.",
        );
      }
    }),
    vscode.commands.registerCommand(
      "champ.setActiveModel",
      async (providerName: string) => {
        // Surgically rewrite the workspace YAML's top-level
        // `provider:` line. Comments and the rest of the file are
        // preserved. The file watcher fires loadProvider() which
        // broadcasts a fresh providerStatus to the chat view.
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "Champ: cannot switch model without an open workspace.",
          );
          return;
        }
        const yamlPath = path.join(workspaceRoot, ".champ", "config.yaml");
        const yamlUri = vscode.Uri.file(yamlPath);
        let text: string;
        try {
          const data = await vscode.workspace.fs.readFile(yamlUri);
          text = new TextDecoder().decode(data);
        } catch {
          void vscode.window.showErrorMessage(
            `Champ: cannot find ${yamlPath}. Run "Champ: Generate Config File" first.`,
          );
          return;
        }
        const updated = setActiveProviderInYaml(text, providerName);
        if (updated === text) {
          void vscode.window.showWarningMessage(
            `Champ: no top-level \`provider:\` line found in ${yamlPath}.`,
          );
          return;
        }
        await vscode.workspace.fs.writeFile(
          yamlUri,
          new TextEncoder().encode(updated),
        );
        // The file watcher will fire loadProvider() which broadcasts
        // a fresh providerStatus. Nothing more to do here.
      },
    ),
    vscode.commands.registerCommand(
      "champ.firstRunSelect",
      async (templateId: string) => {
        const template = SAMPLE_CONFIGS.find((c) => c.id === templateId);
        if (!template) {
          void vscode.window.showErrorMessage(
            `Champ: unknown onboarding template "${templateId}".`,
          );
          return;
        }
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "Champ: open a workspace folder before creating a config file.",
          );
          return;
        }
        const targetDir = vscode.Uri.file(path.join(workspaceRoot, ".champ"));
        const targetUri = vscode.Uri.file(
          path.join(workspaceRoot, ".champ", "config.yaml"),
        );
        try {
          await vscode.workspace.fs.createDirectory(targetDir);
        } catch {
          // Directory may already exist.
        }
        await vscode.workspace.fs.writeFile(
          targetUri,
          new TextEncoder().encode(template.yaml),
        );
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `Champ: created .champ/config.yaml from "${template.label}". Edit and save to customize.`,
        );
        // The file watcher fires loadProvider() automatically.
      },
    ),
    vscode.commands.registerCommand("champ.firstRunDismiss", () => {
      context.globalState.update("champ.onboardingDismissed", true);
    }),
    vscode.commands.registerCommand("champ.showOnboarding", () => {
      chatViewProvider?.broadcastFirstRunWelcome(
        SAMPLE_CONFIGS.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
        })),
      );
    }),
    // ---- Session management commands ------------------------------------
    vscode.commands.registerCommand(
      "champ.switchSession",
      (sessionId: string) => {
        if (!agentManager) return;
        try {
          // Save the outgoing session's history before switching.
          const outgoingId = agentManager.getActiveId();
          if (outgoingId) void saveSession(outgoingId);
          agentManager.setActive(sessionId);
          const session = agentManager.getActive();
          if (session) {
            // Swap the chat view's agent to the new session's controller.
            chatViewProvider?.setAgent(session.controller);
            chatViewProvider?.postMessage({
              type: "conversationHistory",
              messages: session.controller.getHistory(),
            });
          }
          broadcastSessionList();
        } catch {
          void vscode.window.showErrorMessage(
            "Champ: failed to switch session.",
          );
        }
      },
    ),
    vscode.commands.registerCommand("champ.newSession", (label?: string) => {
      if (!agentManager) return;
      const session = agentManager.createSession(label);
      // Swap the chat view to the new session's controller.
      chatViewProvider?.setAgent(session.controller);
      void saveSession(session.metadata.id);
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
      broadcastSessionList();
    }),
    vscode.commands.registerCommand(
      "champ.deleteSession",
      async (sessionId: string) => {
        if (!agentManager || !sessionStore) return;
        agentManager.deleteSession(sessionId);
        await sessionStore.delete(sessionId);
        const active = agentManager.getActive();
        if (active) {
          chatViewProvider?.setAgent(active.controller);
          chatViewProvider?.postMessage({
            type: "conversationHistory",
            messages: active.controller.getHistory(),
          });
        } else {
          // No sessions left — create a fresh one.
          const fresh = agentManager.createSession();
          chatViewProvider?.setAgent(fresh.controller);
          chatViewProvider?.postMessage({
            type: "conversationHistory",
            messages: [],
          });
        }
        broadcastSessionList();
      },
    ),
    vscode.commands.registerCommand(
      "champ.renameSession",
      (sessionId: string, newLabel: string) => {
        if (!agentManager) return;
        agentManager.renameSession(sessionId, newLabel);
        void saveSession(sessionId);
        broadcastSessionList();
      },
    ),
    vscode.commands.registerCommand("champ.cleanupSessions", async () => {
      if (!sessionStore) return;
      const pruned = await sessionStore.pruneOlderThan(30);
      void vscode.window.showInformationMessage(
        `Champ: cleaned up ${pruned} session(s) older than 30 days.`,
      );
    }),
  );

  // ---- Config loader (YAML + VS Code settings fallback) -------------
  /**
   * Resolve the effective ChampConfig from (in order of precedence):
   *   1. <workspace>/.champ/config.yaml
   *   2. ~/.champ/config.yaml
   *   3. VS Code champ.* settings (legacy backward-compat)
   *   4. built-in defaults
   *
   * Returns null when no source has a usable config — the loader path
   * is then skipped and the caller falls back to createFromConfig().
   * Errors during YAML parsing are surfaced to the user but do not
   * crash activation.
   */
  const resolveConfig = async (): Promise<ChampConfig | null> => {
    const workspacePath = workspaceRoot
      ? path.join(workspaceRoot, ".champ", "config.yaml")
      : null;
    const userPath = path.join(os.homedir(), ".champ", "config.yaml");

    let workspaceConfig: ChampConfig | null = null;
    let userConfig: ChampConfig | null = null;

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
            `Champ: ${workspacePath} has invalid YAML — ${err.message}`,
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
          `Champ: ${userPath} has invalid YAML — ${err.message}`,
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
    chatViewProvider?.broadcastProviderStatus({
      state: "loading",
      available: [],
    });
    let yamlConfig: ChampConfig | null = null;
    try {
      yamlConfig = await resolveConfig();
      const newProvider = yamlConfig
        ? await factory.createFromChampConfig(yamlConfig, context.secrets)
        : await factory.createFromConfig(
            vscode.workspace.getConfiguration("champ"),
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
      // Push the new provider into all session controllers too.
      agentManager?.swapProvider(newProvider);
      inlineProvider.setProvider(newProvider);
      inlineProviderRef.current = newProvider;
      setStatusReady(newProvider);
      chatViewProvider?.broadcastProviderStatus({
        state: "ready",
        providerName: newProvider.name,
        modelName: newProvider.config.model,
        available: buildAvailableModels(yamlConfig),
      });
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message);
      chatViewProvider?.broadcastProviderStatus({
        state: "error",
        errorMessage: message,
        available: buildAvailableModels(yamlConfig),
      });
      chatViewProvider?.postMessage({
        type: "error",
        message: `Champ provider not ready: ${message}\n\nOpen settings (gear icon in the status bar) to configure the active provider, or create a .champ/config.yaml file.`,
      });
      console.error("Champ: provider load failed:", err);
    }
  };

  function isProviderReady(): boolean {
    return inlineProviderRef.current.name !== "not-configured";
  }

  function setStatusLoading(): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(loading~spin) Champ-1.0.0";
    statusBarItem.tooltip = "Champ — loading provider…";
  }

  function setStatusReady(provider: LLMProvider): void {
    if (!statusBarItem) return;
    statusBarItem.text = `$(robot) Champ-1.0.0: ${provider.name}`;
    statusBarItem.tooltip = `Champ provider: ${provider.name} (${provider.config.model})\nClick to open settings`;
  }

  function setStatusError(message: string): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(error) Champ-1.0.0: error";
    statusBarItem.tooltip = `Champ provider error: ${message}\nClick to open settings`;
  }

  /** Broadcast the current session list to the webview. */
  function broadcastSessionList(): void {
    if (!agentManager) return;
    chatViewProvider?.broadcastSessionList(
      agentManager.listSessions(),
      agentManager.getActiveId(),
    );
  }

  /** Broadcast current metrics snapshot to the webview. */
  function broadcastMetrics(): void {
    if (!metrics) return;
    const m = metrics.getMetrics();
    chatViewProvider?.postMessage({
      type: "metricsUpdate",
      totalRequests: m.totalRequests,
      totalTokensIn: m.totalTokensIn,
      totalTokensOut: m.totalTokensOut,
      averageLatency: Math.round(m.averageLatency),
      totalFailures: m.totalFailures,
    });
  }

  /** Save a session to disk. */
  async function saveSession(id: string): Promise<void> {
    if (!agentManager || !sessionStore) return;
    try {
      const serialized = agentManager.exportSession(id);
      await sessionStore.save(serialized);
    } catch {
      // Non-fatal — session will be lost on restart but the user
      // can keep working.
    }
  }

  /**
   * Save the currently active session. Debounced so rapid-fire
   * stream deltas don't hammer the filesystem.
   */
  let saveActiveTimeout: ReturnType<typeof setTimeout> | null = null;
  function saveActiveSession(): void {
    if (saveActiveTimeout) clearTimeout(saveActiveTimeout);
    saveActiveTimeout = setTimeout(() => {
      saveActiveTimeout = null;
      const id = agentManager?.getActiveId();
      if (id) void saveSession(id);
    }, 500);
  }

  // Initial load. Failures here are non-fatal — the chat panel will
  // show the error and the user can fix it from settings.
  await loadProvider();

  // ---- First-run detection (onboarding) ---------------------------------
  // If no config exists at all and the user hasn't dismissed onboarding
  // before, broadcast a firstRunWelcome so the chat panel shows the
  // onboarding picker with starter templates.
  const onboardingDismissed = context.globalState.get<boolean>(
    "champ.onboardingDismissed",
    false,
  );
  if (!onboardingDismissed) {
    const hasConfig = await resolveConfig();
    if (!hasConfig) {
      chatViewProvider?.broadcastFirstRunWelcome(
        SAMPLE_CONFIGS.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
        })),
      );
    }
  }

  // ---- Restore persisted sessions ---------------------------------------
  // Load any saved sessions from disk, or create a default session if
  // none exist. This ensures the user always has at least one session.
  if (sessionStore && agentManager) {
    try {
      const persisted = await sessionStore.loadAll();
      for (const s of persisted) {
        agentManager.importSession(s);
      }
      if (persisted.length > 0) {
        // Activate the most recently used session.
        const sorted = persisted.sort(
          (a, b) => b.metadata.lastActivityAt - a.metadata.lastActivityAt,
        );
        agentManager.setActive(sorted[0].metadata.id);
      }
    } catch {
      // Non-fatal — start fresh.
    }
    // Ensure at least one session exists.
    if (agentManager.listSessions(true).length === 0) {
      agentManager.createSession();
    }

    // Point the ChatViewProvider at the active session's controller.
    const activeSession = agentManager.getActive();
    if (activeSession) {
      chatViewProvider?.setAgent(activeSession.controller);
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: activeSession.controller.getHistory(),
      });
    }
    broadcastSessionList();

    // Auto-broadcast session list on every manager event, and
    // auto-save sessions after state changes.
    agentManager.onChange((event) => {
      broadcastSessionList();
      if (
        event.type === "sessionCreated" ||
        event.type === "sessionStateChanged" ||
        event.type === "sessionUpdated"
      ) {
        void saveSession(event.id);
      }
    });
  }

  // ---- Config change watchers -----------------------------------------
  // Watch VS Code champ.* settings (legacy path).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("champ")) return;
      await loadProvider();
    }),
  );

  // Watch .champ/config.yaml in the workspace for live reload. Created,
  // changed, or deleted — any of those should trigger a provider reload
  // since the file is the source of truth when it exists.
  if (workspaceRoot) {
    const yamlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".champ/config.yaml"),
    );
    yamlWatcher.onDidChange(() => void loadProvider());
    yamlWatcher.onDidCreate(() => void loadProvider());
    yamlWatcher.onDidDelete(() => void loadProvider());
    context.subscriptions.push(yamlWatcher);
  }

  console.log("Champ extension activated");
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
          "No LLM provider is configured. Click the Champ status bar item or run 'Champ: Settings' to choose a provider.",
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
 * Build a starter .champ/config.yaml that the user can edit. Defaults
 * are conservative — Ollama at localhost since that's the most common
 * local-first setup. Uncommented blocks show every available knob.
 */
function generateDefaultConfigYaml(): string {
  return `# Champ configuration
# See .champ/config.yaml.example for all available options.
# API keys: use the 'Champ: Set API Key' command (never put keys here).

provider: ollama

providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:7b-instruct

  # Uncomment to add more providers:
  # claude:
  #   model: claude-sonnet-4-20250514
  # openai:
  #   model: gpt-4o
  # llamacpp:
  #   baseUrl: http://localhost:8080/v1
  #   model: default
  # vllm:
  #   baseUrl: http://localhost:8000/v1
  #   model: meta-llama/Llama-3.1-8B

autocomplete:
  enabled: true
  debounceMs: 300

agent:
  yoloMode: false
  defaultMode: agent
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
`;
}

/**
 * Build the list of provider+model combinations that the bottom-bar
 * model dropdown should display. Each entry under `providers:` in the
 * YAML config becomes one row, formatted as "provider: model" so the
 * webview can render it directly.
 *
 * Returns an empty list when no YAML config is available — the legacy
 * VS Code settings path doesn't enumerate providers, so the dropdown
 * is hidden in that case.
 */
function buildAvailableModels(
  yamlConfig: ChampConfig | null,
): AvailableProviderModel[] {
  if (!yamlConfig?.providers) return [];
  const out: AvailableProviderModel[] = [];
  for (const [providerName, conf] of Object.entries(yamlConfig.providers)) {
    if (!conf) continue;
    const modelName = conf.model ?? "default";
    out.push({
      providerName,
      modelName,
      label: `${providerName}: ${modelName}`,
    });
  }
  return out;
}

/**
 * Surgically rewrite the top-level `provider:` line in a YAML config
 * file. Comments, indentation, and the rest of the file are preserved
 * exactly — only the provider name on that one line changes. Returns
 * the original text unchanged if no top-level `provider:` line exists.
 *
 * The regex anchors to start-of-line so nested `provider:` keys (e.g.
 * `autocomplete.provider`) are never touched.
 */
function setActiveProviderInYaml(
  yamlText: string,
  newProvider: string,
): string {
  return yamlText.replace(/^provider:[^\n]*$/m, `provider: ${newProvider}`);
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
        `Champ: failed to load skill from ${filePath}:`,
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
