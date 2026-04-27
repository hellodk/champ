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
import type { LLMProvider, StreamDelta } from "./providers/types";
import type { AvailableProviderModel } from "./ui/messages";
import { SAMPLE_CONFIGS } from "./config/sample-configs";
import { AgentManager } from "./agent-manager/agent-manager";
import { SessionStore } from "./agent-manager/session-store";
import { SmartRouter } from "./providers/smart-router";
import { generateDiagramTool } from "./tools/generate-diagram";
import { generateDocTool } from "./tools/generate-doc";
import { createCodebaseSearchTool } from "./tools/codebase-search";
import { IndexingService } from "./indexing/indexing-service";
import { MultiAgentRunner } from "./agent/multi-agent-runner";
import { AgentAnalytics } from "./observability/agent-analytics";
import type { AgentRunReport } from "./agent-manager/types";
import {
  AnalyticsExporter,
  type TelemetryEvent,
} from "./telemetry/analytics-exporter";

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
let smartRouter: SmartRouter | undefined;
let cachedYamlConfig: import("./config/config-loader").ChampConfig | null =
  null;
let lastAnalyticsReport: AgentRunReport | null = null;
let analyticsExporter: AnalyticsExporter | undefined;
let sessionAnalytics: AgentAnalytics | undefined;
let analyticsChannel: vscode.OutputChannel | undefined;
let saveActiveTimeout: ReturnType<typeof setTimeout> | null = null;
let indexingService: IndexingService | undefined;

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
  toolRegistry.register(generateDiagramTool);
  toolRegistry.register(generateDocTool);
  toolRegistry.register(
    createCodebaseSearchTool(() => indexingService ?? null),
  );

  // ---- Status bar item -----------------------------------------------
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "champ.openSettings";
  statusBarItem.text = "$(loading~spin) Champ";
  statusBarItem.tooltip = "Champ — click to open settings";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  analyticsChannel = vscode.window.createOutputChannel("Champ Analytics");
  context.subscriptions.push(analyticsChannel);

  // ---- Agent controller (created with a placeholder provider) --------
  // We use a stub provider until the real one loads. This way the chat
  // view, commands, and inline completion can register before any
  // network/SDK errors happen.
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const stubProvider = createStubProvider("not-configured");
  const inlineProviderRef: { current: LLMProvider } = { current: stubProvider };
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

  // ---- Smart Router (multi-provider model discovery) ----------------
  smartRouter = new SmartRouter();
  // Wire SmartRouter into AgentController and AgentManager for per-message
  // model selection (coding tasks → best coding model, ask/plan → chat model).
  agentController.setSmartRouter(smartRouter);
  agentManager?.setSmartRouter(smartRouter);
  // When the router discovers models, (re-)initialize the indexing service
  // so it can pick up a newly available embedding model automatically.
  smartRouter.onChange(() => {
    if (cachedYamlConfig?.indexing?.enabled !== false && smartRouter) {
      indexingService?.dispose();
      indexingService = new IndexingService(
        workspaceRoot,
        smartRouter,
        cachedYamlConfig ?? {},
      );
      void indexingService.initialize().then((stats) => {
        if (stats) {
          console.log(
            `Champ: semantic index ready — ${stats.chunksIndexed} chunks from ${stats.filesIndexed} files (${stats.embeddingModel})`,
          );
        }
      });
    }
    if (!chatViewProvider) return;
    const discovered = smartRouter!.getModels();
    const discoveredProviders = new Set(discovered.map((m) => m.providerName));

    // Build the available list: only auto-detected (reachable) models.
    const available: AvailableProviderModel[] = discovered.map((m) => ({
      providerName: m.providerName,
      modelName: m.id,
      label: `${m.id} (${m.providerName}) ${m.capabilities.join(", ")}`,
    }));

    // Append config-defined but unreachable providers.
    // Cloud providers (no baseUrl) show normally — they just need an API key.
    // Local providers that are down show as [offline].
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

    const activeProvider = inlineProviderRef?.current;
    chatViewProvider.broadcastProviderStatus({
      state: "ready",
      providerName: activeProvider?.name ?? (discovered[0]?.providerName || ""),
      modelName: activeProvider?.config.model ?? (discovered[0]?.id || ""),
      available,
    });
  });

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
  // Skill loading is fire-and-forget — built-in skills are already
  // registered, disk skills are async bonuses that don't need to block.
  void loadSkillsFromDirectory(
    skillRegistry,
    workspaceRoot ? path.join(workspaceRoot, ".champ", "skills") : null,
    "workspace",
  );
  void loadSkillsFromDirectory(
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
    context.extension.packageJSON.version as string,
  );
  chatViewProvider.setContextResolver(contextResolver);
  chatViewProvider.setSkillRegistry(skillRegistry);
  chatViewProvider.setSkillContext(
    {
      build: (userInput: string) => buildSkillContext(workspaceRoot, userInput),
    },
    (template, ctx) => VariableResolver.resolve(template, ctx),
  );
  // Auto-label sessions + Smart Router model selection.
  chatViewProvider.onUserMessage((text) => {
    const active = agentManager?.getActive();
    if (active && active.metadata.label === "New chat") {
      agentManager?.autoLabelSession(active.metadata.id, text);
      broadcastSessionList();
    }

    // ── SmartRouter: swap provider before each message ──
    // Determine the task type from the current agent mode and route
    // to the best model. Only in Auto mode — manual overrides skip.
    if (smartRouter && smartRouter.getMode() === "smart") {
      const session = agentManager?.getActive();
      if (session) {
        const mode = session.controller.getMode();
        let taskType: import("./providers/smart-router").TaskType = "chat";
        if (mode === "agent" || mode === "composer") taskType = "coding";
        else if (mode === "plan") taskType = "chat";
        else if (mode === "ask") taskType = "chat";

        const route = smartRouter.select(taskType);
        if (route) {
          // If SmartRouter picked a model whose ID differs from the
          // provider's configured model (e.g., Ollama has a different
          // model installed than what YAML specifies), clone the provider
          // for the selected model so the request uses the correct name.
          const routeProvider =
            route.model.id !== route.provider.config.model
              ? (route.provider.withModel?.(route.model.id) ?? route.provider)
              : route.provider;
          session.controller.setProvider(routeProvider);
          console.log(
            `Champ SmartRouter: ${taskType} → ${route.model.id} (${route.model.providerName}) [${route.reason}]`,
          );
        }
      }
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
    if (sessionAnalytics) {
      lastAnalyticsReport = sessionAnalytics.toReport();
    }
    if (analyticsExporter && lastAnalyticsReport) {
      const event: TelemetryEvent = {
        runId: lastAnalyticsReport.runId,
        timestamp: new Date(lastAnalyticsReport.startTime).toISOString(),
        userId: analyticsExporter.userId,
        sessionId: agentManager?.getActiveId() ?? "unknown",
        workspaceId: analyticsExporter.workspaceId,
        extensionVersion: context.extension.packageJSON.version as string,
        report: lastAnalyticsReport,
      };
      void analyticsExporter.export(event);
    }
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
      // Rebuild current available list from SmartRouter state + YAML static models.
      const discovered = smartRouter?.getModels() ?? [];
      const discoveredProviders = new Set(
        discovered.map((m) => m.providerName),
      );
      const available: AvailableProviderModel[] = discovered.map((m) => ({
        providerName: m.providerName,
        modelName: m.id,
        label: `${m.id} (${m.providerName}) ${m.capabilities.join(", ")}`,
      }));
      if (cachedYamlConfig?.providers) {
        for (const [pName, pConf] of Object.entries(
          cachedYamlConfig.providers,
        )) {
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
      if (available.length === 0) {
        available.push({
          providerName: provider.name,
          modelName: provider.config.model,
          label: `${provider.config.model} (${provider.name})`,
        });
      }
      chatViewProvider?.broadcastProviderStatus({
        state: "ready",
        providerName: provider.name,
        modelName: provider.config.model,
        available,
      });
    }
    broadcastSessionList();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ---- Chat participant (VS Code native Chat view) -------------------
  // Registers Champ as @champ in VS Code's built-in Chat view,
  // alongside Continue, Codex, Claude, etc. Uses the stable
  // vscode.chat.createChatParticipant API (available since 1.93).
  try {
    const chatApi = (
      vscode as typeof vscode & {
        chat?: {
          createChatParticipant: (
            id: string,
            handler: vscode.ChatRequestHandler,
          ) => vscode.ChatParticipant;
        };
      }
    ).chat;
    if (chatApi && typeof chatApi.createChatParticipant === "function") {
      const participant = chatApi.createChatParticipant(
        "champ.default",
        async (request, _chatContext, stream, token) => {
          console.log("Champ chat participant invoked:", request.prompt);
          let activeSession = agentManager?.getActive();
          if (!activeSession && agentManager) {
            activeSession = agentManager.createSession();
          }
          if (!activeSession) {
            stream.markdown("Champ: session unavailable.");
            return;
          }
          const controller = activeSession.controller;
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const dispose = controller.onStreamDelta((delta) => {
            if (delta.type === "text" && delta.text) {
              stream.markdown(delta.text);
            } else if (delta.type === "error" && delta.error) {
              stream.markdown(`\n\n**Error:** ${delta.error}`);
            }
          });
          try {
            await controller.processMessage(request.prompt, {
              abortSignal: abort.signal,
              requestApproval: async () => true,
            });
          } catch (err) {
            stream.markdown(
              `\n\n**Error:** ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            dispose();
          }
        },
      );
      participant.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "media",
        "icon.png",
      );
      context.subscriptions.push(participant);
      console.log("Champ: chat participant registered as @champ");
    } else {
      console.warn("Champ: vscode.chat API unavailable (need VS Code 1.93+)");
    }
  } catch (err) {
    console.error("Champ: chat participant registration failed:", err);
  }

  // ---- Inline completion ----------------------------------------------
  // The inline provider holds a *reference* to the active provider, so
  // when we hot-swap below the same instance picks it up.
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
        if (sessionAnalytics)
          session.controller.setAnalytics(sessionAnalytics, "champ");
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
      // If file exists, just open it (don't prompt to overwrite).
      try {
        await vscode.workspace.fs.stat(targetUri);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc);
        return;
      } catch {
        // File doesn't exist — create it below.
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
        // Tell SmartRouter to switch to manual mode for this model.
        let selectedModelId: string | null = null;
        if (smartRouter) {
          // Find the model id for this provider from discovered models.
          const models = smartRouter.getModels();
          const match = models.find((m) => m.providerName === providerName);
          if (match) {
            selectedModelId = match.id;
            smartRouter.setManualModel(match.id);
            console.log(
              `Champ: manual model selection → ${match.id} (${providerName})`,
            );
          }
        }
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
          // Config doesn't exist — create it silently with defaults.
          const template = generateDefaultConfigYaml();
          try {
            await vscode.workspace.fs.createDirectory(
              vscode.Uri.file(path.join(workspaceRoot, ".champ")),
            );
          } catch {
            /* exists */
          }
          await vscode.workspace.fs.writeFile(
            yamlUri,
            new TextEncoder().encode(template),
          );
          text = template;
        }
        if (!/^provider:/m.test(text)) {
          void vscode.window.showWarningMessage(
            `Champ: no top-level \`provider:\` line found in ${yamlPath}.`,
          );
          return;
        }
        const updated = setActiveProviderInYaml(text, providerName);
        if (updated === text) {
          // Same provider already active — update the model line only.
        }
        // Also write the selected model name into providers.{name}.model so it
        // persists through the next loadProvider() call.
        const finalText = selectedModelId
          ? setProviderModelInYaml(updated, providerName, selectedModelId)
          : updated;
        await vscode.workspace.fs.writeFile(
          yamlUri,
          new TextEncoder().encode(finalText),
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
      if (sessionAnalytics) {
        session.controller.setAnalytics(sessionAnalytics, "champ");
      }
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
          if (sessionAnalytics)
            fresh.controller.setAnalytics(sessionAnalytics, "champ");
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
    vscode.commands.registerCommand("champ.rescanModels", () => {
      if (smartRouter) {
        void smartRouter.discover();
        void vscode.window.showInformationMessage(
          "Champ: re-scanning all providers for models...",
        );
      }
    }),
    vscode.commands.registerCommand("champ.resetToAuto", () => {
      if (smartRouter) {
        smartRouter.resetToAuto();
        void loadProvider();
      }
    }),
    vscode.commands.registerCommand("champ.runMultiAgent", async () => {
      const userRequest = await vscode.window.showInputBox({
        prompt: "Describe the feature or task for the multi-agent workflow",
        placeHolder:
          "e.g. Add JWT authentication with refresh tokens and tests",
        ignoreFocusOut: true,
      });
      if (!userRequest) return;

      const provider = inlineProviderRef.current;
      if (provider.name === "not-configured") {
        void vscode.window.showErrorMessage(
          "Champ: configure a provider first.",
        );
        return;
      }

      const runAnalytics = new AgentAnalytics();

      chatViewProvider?.postMessage({
        type: "streamDelta",
        text: `**Multi-agent workflow started**\n\n> ${userRequest}\n\n`,
      });

      const runner = MultiAgentRunner.buildDefaultPipeline(
        provider,
        toolRegistry,
        workspaceRoot ?? "",
      );

      try {
        await runner.run(userRequest, {
          analytics: runAnalytics,
          onProgress: (event) => {
            if (event.type === "agent_started") {
              chatViewProvider?.postMessage({
                type: "toolCallStart",
                toolName: event.agentName,
                args: { step: `${event.step}/${event.totalSteps}` },
              });
            } else if (event.type === "agent_completed") {
              chatViewProvider?.postMessage({
                type: "toolCallResult",
                toolName: event.agentName,
                result: event.output.slice(0, 300),
                success: true,
              });
            } else if (event.type === "agent_failed") {
              chatViewProvider?.postMessage({
                type: "toolCallResult",
                toolName: event.agentName,
                result: `Failed (attempt ${event.attempt}): ${event.error}`,
                success: false,
              });
            } else if (event.type === "workflow_complete") {
              lastAnalyticsReport = event.report;
              if (analyticsExporter) {
                const telEvent: TelemetryEvent = {
                  runId: event.report.runId,
                  timestamp: new Date(event.report.startTime).toISOString(),
                  userId: analyticsExporter.userId,
                  sessionId: "multi-agent",
                  workspaceId: analyticsExporter.workspaceId,
                  extensionVersion: context.extension.packageJSON
                    .version as string,
                  report: event.report,
                };
                void analyticsExporter.export(telEvent);
              }
              const md = runAnalytics.formatMarkdown();
              chatViewProvider?.postMessage({
                type: "streamDelta",
                text: `\n\n${md}\n`,
              });
              chatViewProvider?.postMessage({ type: "streamEnd" });
            }
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chatViewProvider?.postMessage({
          type: "error",
          message: `Multi-agent workflow failed: ${msg}`,
        });
      }
    }),
    vscode.commands.registerCommand("champ.showAnalytics", () => {
      if (!lastAnalyticsReport) {
        void vscode.window.showInformationMessage(
          "Champ: no analytics data yet — send a message first.",
        );
        return;
      }
      const channel = analyticsChannel!;
      channel.clear();
      channel.appendLine("# Champ Analytics Report");
      channel.appendLine("");
      channel.appendLine(`Run ID:     ${lastAnalyticsReport.runId}`);
      channel.appendLine(
        `Start:      ${new Date(lastAnalyticsReport.startTime).toLocaleTimeString()}`,
      );
      channel.appendLine(
        `Duration:   ${(lastAnalyticsReport.totalDurationMs / 1000).toFixed(1)}s`,
      );
      channel.appendLine(`Tokens in:  ${lastAnalyticsReport.totalInputTokens}`);
      channel.appendLine(
        `Tokens out: ${lastAnalyticsReport.totalOutputTokens}`,
      );
      channel.appendLine(`Success:    ${lastAnalyticsReport.success}`);
      channel.appendLine("");
      channel.appendLine("## Per-agent tasks");
      for (const a of lastAnalyticsReport.agents) {
        channel.appendLine(
          `  ${a.success ? "✓" : "✗"} ${a.agentName.padEnd(14)} ${(a.durationMs / 1000).toFixed(1)}s  in=${a.inputTokens}  out=${a.outputTokens}  tools=${a.toolCalls.length}`,
        );
        for (const t of a.toolCalls) {
          channel.appendLine(
            `      [${t.success ? "ok" : "fail"}] ${t.toolName.padEnd(20)} ${t.durationMs}ms`,
          );
        }
      }
      channel.show(true);
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
    // Cache for onWebviewReady re-broadcast.
    try {
      yamlConfig = await resolveConfig();
      cachedYamlConfig = yamlConfig;
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
      // Wire a fresh AgentAnalytics instance into every session's controller.
      sessionAnalytics = new AgentAnalytics();
      agentManager?.listSessions(true).forEach((meta) => {
        const sess = agentManager!.getSession(meta.id);
        sess?.controller.setAnalytics(sessionAnalytics!, "champ");
      });
      inlineProvider.setProvider(newProvider);
      inlineProviderRef.current = newProvider;
      // If YAML configures a separate autocomplete provider or model, wire it.
      if (
        yamlConfig?.autocomplete?.provider &&
        yamlConfig.autocomplete.provider !== newProvider.name
      ) {
        try {
          const acProvider = await factory.createFromChampConfig(
            {
              ...yamlConfig,
              provider: yamlConfig.autocomplete
                .provider as import("./config/config-loader").ProviderName,
            },
            context.secrets,
          );
          const acModel = yamlConfig.autocomplete.model;
          inlineProvider.setProvider(
            acModel && acProvider.withModel
              ? acProvider.withModel(acModel)
              : acProvider,
          );
        } catch {
          // Autocomplete provider unavailable — keep main provider.
        }
      } else if (
        yamlConfig?.autocomplete?.model &&
        yamlConfig.autocomplete.model !== newProvider.config.model
      ) {
        const acProvider = newProvider.withModel?.(
          yamlConfig.autocomplete.model,
        );
        if (acProvider) inlineProvider.setProvider(acProvider);
      }
      setStatusReady(newProvider);
      // Broadcast a minimal status immediately (SmartRouter's onChange
      // will replace the model list once discovery completes with only
      // the models from reachable providers).
      chatViewProvider?.broadcastProviderStatus({
        state: "ready",
        providerName: newProvider.name,
        modelName: newProvider.config.model,
        available: [],
      });
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
      // Register all configured providers with SmartRouter — each gets
      // its OWN provider instance so routing actually switches backends.
      if (smartRouter) {
        smartRouter.registerProvider(
          newProvider.name,
          newProvider,
          newProvider.name,
          yamlConfig?.providers?.[
            newProvider.name as keyof typeof yamlConfig.providers
          ]?.baseUrl ?? (newProvider.config as { baseUrl?: string }).baseUrl,
        );
        if (yamlConfig?.providers) {
          for (const [pName, pConf] of Object.entries(yamlConfig.providers)) {
            if (!pConf?.baseUrl || pName === newProvider.name) continue;
            // Create a dedicated provider instance for this backend.
            try {
              const otherProvider = await factory.createFromChampConfig(
                {
                  ...yamlConfig,
                  provider:
                    pName as import("./config/config-loader").ProviderName,
                },
                context.secrets,
              );
              smartRouter.registerProvider(
                pName,
                otherProvider,
                pName,
                pConf.baseUrl,
              );
            } catch {
              // Provider creation failed — skip (will show as offline).
            }
          }
        }
        // Apply routing config from YAML before first discovery.
        if (yamlConfig?.routing) {
          const { mode, coding, chat, completion, embedding } =
            yamlConfig.routing;
          if (mode) smartRouter.setMode(mode);
          if (coding !== undefined)
            smartRouter.setTaskModel("coding", coding ?? null);
          if (chat !== undefined)
            smartRouter.setTaskModel("chat", chat ?? null);
          if (completion !== undefined)
            smartRouter.setTaskModel("completion", completion ?? null);
          if (embedding !== undefined)
            smartRouter.setTaskModel("embedding", embedding ?? null);
        }
        void smartRouter.discover();
      }
      // Rebuild telemetry exporter whenever config reloads.
      analyticsExporter?.dispose();
      analyticsExporter = undefined;
      if (
        yamlConfig?.telemetry?.enabled !== false &&
        yamlConfig?.telemetry?.endpoint
      ) {
        const machineId: string = vscode.env.machineId;
        const resolvedUserId = yamlConfig.telemetry.userId ?? machineId;
        const wsHash = workspaceRoot
          ? Buffer.from(workspaceRoot).toString("base64").slice(0, 8)
          : "unknown";
        analyticsExporter = new AnalyticsExporter(
          yamlConfig.telemetry,
          resolvedUserId,
          wsHash,
        );
      }
      // SmartRouter.discover() handles all model detection. If no YAML,
      // also register the active provider from VS Code settings.
      if (!yamlConfig && smartRouter) {
        const vsConfig = vscode.workspace.getConfiguration("champ");
        const baseUrl = (
          vsConfig.get<string>(`${newProvider.name}.baseUrl`) ?? ""
        ).replace(/\/+$/, "");
        if (baseUrl) {
          smartRouter.registerProvider(
            newProvider.name,
            newProvider,
            newProvider.name,
            baseUrl,
          );
          void smartRouter.discover();
        }
      }
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
    statusBarItem.text = "$(loading~spin) Champ";
    statusBarItem.tooltip = "Champ — loading provider…";
  }

  function setStatusReady(provider: LLMProvider): void {
    if (!statusBarItem) return;
    statusBarItem.text = `$(robot) Champ: ${provider.name}`;
    statusBarItem.tooltip = `Champ provider: ${provider.name} (${provider.config.model})\nClick to open settings`;
  }

  function setStatusError(message: string): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(error) Champ: error";
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
  function saveActiveSession(): void {
    if (saveActiveTimeout) clearTimeout(saveActiveTimeout);
    saveActiveTimeout = setTimeout(() => {
      saveActiveTimeout = null;
      const id = agentManager?.getActiveId();
      if (id) void saveSession(id);
    }, 500);
  }

  // ---- Background initialization ----------------------------------------
  // All the slow stuff (disk I/O, provider loading, HTTP calls for
  // auto-detect) runs AFTER activate() returns. This means the Champ
  // sidebar icon appears instantly; the user can open it and see
  // "loading..." while the provider and sessions come online.
  void (async () => {
    // 1. Load provider (reads YAML, creates provider, auto-detects models).
    await loadProvider();

    // 2. First-run detection. Use cached config (loadProvider already read it).
    const onboardingDismissed = context.globalState.get<boolean>(
      "champ.onboardingDismissed",
      false,
    );
    if (!onboardingDismissed && !cachedYamlConfig) {
      chatViewProvider?.broadcastFirstRunWelcome(
        SAMPLE_CONFIGS.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
        })),
      );
    }

    // 3. Restore persisted sessions from .champ/sessions/.
    if (sessionStore && agentManager) {
      try {
        const persisted = await sessionStore.loadAll();
        for (const s of persisted) {
          agentManager.importSession(s);
        }
        if (persisted.length > 0) {
          const sorted = persisted.sort(
            (a, b) => b.metadata.lastActivityAt - a.metadata.lastActivityAt,
          );
          agentManager.setActive(sorted[0].metadata.id);
        }
      } catch {
        /* non-fatal */
      }
      if (agentManager.listSessions(true).length === 0) {
        agentManager.createSession();
      }
      const activeSession = agentManager.getActive();
      if (activeSession) {
        chatViewProvider?.setAgent(activeSession.controller);
        chatViewProvider?.postMessage({
          type: "conversationHistory",
          messages: activeSession.controller.getHistory(),
        });
      }
      broadcastSessionList();

      // Wire analytics into all sessions that were restored at boot.
      // loadProvider() ran before sessions existed, so we wire them here.
      if (sessionAnalytics && agentManager) {
        agentManager.listSessions(true).forEach((meta) => {
          const sess = agentManager!.getSession(meta.id);
          sess?.controller.setAnalytics(sessionAnalytics!, "champ");
        });
      }

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
  })();

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
  if (saveActiveTimeout) {
    clearTimeout(saveActiveTimeout);
    saveActiveTimeout = null;
  }
  indexingService?.dispose();
  analyticsExporter?.dispose();
  analyticsChannel?.dispose();
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
    async *chat(): AsyncIterable<StreamDelta> {
      yield {
        type: "error" as const,
        error:
          "No LLM provider is configured. Click the Champ status bar item or run 'Champ: Settings' to choose a provider.",
      };
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *complete(): AsyncIterable<StreamDelta> {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
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
# API keys: use the 'Champ: Set API Key' command (never put keys here).
# Champ auto-discovers all models from every provider listed below.
# Just add the baseUrl — Champ scans for available models automatically.

# Active provider for chat (Champ's Smart Router can override per-task).
provider: ollama

# ── Add ALL your inference backends here. ──────────────────────────
# Champ will scan each one for available models on startup.
# Models appear automatically in the model picker.
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:7b-instruct

  # Uncomment any provider you have running:
  llamacpp:
    baseUrl: http://localhost:8080/v1
    model: default

  # vllm:
  #   baseUrl: http://localhost:8000/v1
  #   model: meta-llama/Llama-3.1-8B

  # claude:
  #   model: claude-sonnet-4-20250514

  # openai:
  #   model: gpt-4o

# ── Smart Routing (auto-picks best model per task) ─────────────────
# routing:
#   mode: smart      # "smart" (auto) or "manual" (you pick)
#   coding: null      # override: force this model for coding
#   chat: null        # override: force this model for chat
#   completion: null  # override: force this model for ghost-text

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

# Telemetry (optional — export run analytics to OTLP or JSON endpoint)
# telemetry:
#   enabled: false
#   endpoint: "http://localhost:4318/v1/traces"
#   format: "otlp"          # "otlp" | "json"
#   # userId: "team-name"
#   # headers:
#   #   Authorization: "Bearer <token>"
#   # bufferMaxEvents: 1000
#   # bufferMaxBytes: 5242880   # 5 MB
#   # timeoutMs: 5000
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
 * Rewrite the `model:` line under a specific provider section in YAML.
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
    if (
      /^\s{2}/.test(line) &&
      line.trimStart().startsWith(`${providerName}:`)
    ) {
      inProvider = true;
      continue;
    }
    if (inProvider) {
      if (line.length > 0 && !/^\s/.test(line)) break;
      if (/^\s{2}[^\s]/.test(line)) break;
      if (/^\s{4,}model:\s*/.test(line)) {
        lines[i] = line.replace(/^(\s+model:\s*).*$/, `$1${modelId}`);
        break;
      }
    }
  }
  return lines.join("\n");
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
