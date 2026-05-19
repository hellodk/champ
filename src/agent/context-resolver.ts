/**
 * ContextResolver: @-symbol parsing and resolution.
 *
 * Parses references like @Files(src/main.ts), @Folders(src/utils),
 * @Codebase, @Web, @Git, @Docs, @Code, @Symbols from a user message
 * and resolves each reference to its actual content (file contents,
 * search results, web results, etc.) that gets injected into the LLM
 * prompt.
 *
 * Also exposes autocomplete suggestions for the chat UI's @-symbol
 * dropdown.
 */

import { resolveInWorkspace } from "../utils/workspace-path";

/** Types of @-references recognized in chat messages. */
export type ReferenceType =
  | "file"
  | "folder"
  | "code"
  | "symbol"
  | "codebase"
  | "web"
  | "git"
  | "docs"
  | "mcp"
  | "mcpPrompt"
  | "pr"
  | "issue"
  | "terminal"
  | "gitBlame"
  | "testFor";

/** A parsed @-reference before resolution. */
export interface ContextReference {
  type: ReferenceType;
  /** The argument (e.g. file path) for parameterized references. */
  value: string;
  /** Character range in the original message. */
  start: number;
  end: number;
}

/** A resolved reference ready for injection into the LLM prompt. */
export interface ResolvedContext {
  type: ReferenceType;
  label: string;
  content: string;
}

/** An autocomplete suggestion shown in the chat input's @-dropdown. */
export interface AtSymbolSuggestion {
  label: string;
  type: ReferenceType;
  description: string;
  parameterized: boolean;
}

/** Catalogue of all supported @-symbols and their semantics. */
const AT_SYMBOL_CATALOGUE: AtSymbolSuggestion[] = [
  {
    label: "@Files",
    type: "file",
    description: "Reference one or more files",
    parameterized: true,
  },
  {
    label: "@Folders",
    type: "folder",
    description: "Reference a directory",
    parameterized: true,
  },
  {
    label: "@Code",
    type: "code",
    description: "Reference the current editor selection",
    parameterized: false,
  },
  {
    label: "@Symbols",
    type: "symbol",
    description: "Reference a workspace symbol",
    parameterized: true,
  },
  {
    label: "@Codebase",
    type: "codebase",
    description: "Semantic search across the workspace",
    parameterized: false,
  },
  {
    label: "@Web",
    type: "web",
    description: "Search the web",
    parameterized: false,
  },
  {
    label: "@Git",
    type: "git",
    description: "Reference git diff, branch, or history",
    parameterized: false,
  },
  {
    label: "@Docs",
    type: "docs",
    description: "Reference local package documentation (from node_modules)",
    parameterized: true,
  },
  {
    label: "@PR",
    type: "pr",
    description: "Reference a GitHub Pull Request by number",
    parameterized: true,
  },
  {
    label: "@Issue",
    type: "issue",
    description: "Reference a GitHub Issue by number",
    parameterized: true,
  },
  {
    label: "@Terminal",
    type: "terminal",
    description: "Inject recent integrated terminal output into context",
    parameterized: false,
  },
  {
    label: "@GitBlame",
    type: "gitBlame",
    description:
      "Show git blame for a specific file line (e.g. @GitBlame(src/foo.ts:42))",
    parameterized: true,
  },
  {
    label: "@TestFor",
    type: "testFor",
    description: "Find function definition and existing tests for a symbol",
    parameterized: true,
  },
];

/**
 * Dependencies required to resolve references. Injected via constructor
 * so tests can mock them without standing up real services.
 */
export interface ContextResolverDeps {
  workspaceRoot: string;
  /** Semantic search service (from Phase 6 indexing). */
  indexingService: {
    search(query: string, topK?: number): Promise<unknown[]>;
  };
  /** Web search tool (from Phase 9+). */
  webSearchTool: {
    execute(
      args: Record<string, unknown>,
    ): Promise<{ success: boolean; output: string }>;
  };
  /**
   * File system access. Optional — if absent, @Files and @Folders return
   * a short placeholder so the resolver degrades gracefully in tests.
   */
  fileReader?: {
    readFile(absPath: string): Promise<string>;
    readdir(absPath: string): Promise<Array<[string, "file" | "directory"]>>;
  };
  /**
   * Returns the active editor's selection and file info. Optional.
   * Used by the @Code resolver.
   */
  getEditorContext?: () =>
    | {
        selection: string;
        filePath: string;
        language: string;
      }
    | undefined;
  /**
   * Run a shell command in the workspace root and return stdout.
   * Optional — used by the @Git resolver.
   */
  runShellCommand?: (cmd: string, cwd: string) => Promise<string>;
  /**
   * Look up workspace symbols by query string. Optional — used by @Symbols.
   */
  workspaceSymbols?: (
    query: string,
  ) => Promise<
    Array<{ name: string; filePath: string; kind: string; line: number }>
  >;
  /**
   * Read documentation for a package from the workspace's node_modules.
   * Returns README content (up to 200 lines) or null if not found.
   */
  docsReader?: {
    readPackageDocs(packageName: string): Promise<string | null>;
  };
  /**
   * VS Code workspace state Memento used to read back terminal output
   * captured by the run_terminal tool. Optional — degrades gracefully
   * when absent (e.g. in tests).
   */
  workspaceState?: {
    get<T>(key: string): T | undefined;
  };
}

export class ContextResolver {
  constructor(
    private readonly deps: ContextResolverDeps,
    private readonly mcpRegistry?: import("../mcp/mcp-registry").McpRegistry,
  ) {}

  /** Returns the active editor context if `getEditorContext` dep is wired. */
  getEditorContext():
    | { selection: string; filePath: string; language: string }
    | undefined {
    return this.deps.getEditorContext?.();
  }

  /**
   * Scan a user message for @-references and return their metadata.
   * Each reference can later be resolved via resolve().
   */
  parseReferences(message: string): ContextReference[] {
    const refs: ContextReference[] = [];

    // Parameterized references: @Files(path), @Folders(path), @Symbols(name), @Docs(name)
    // @MCPPrompt must come before @MCP to avoid the @MCP prefix swallowing @MCPPrompt.
    // Scan in declared order so the first match wins when references overlap.
    const parameterizedPatterns: Array<{ regex: RegExp; type: ReferenceType }> =
      [
        { regex: /@MCPPrompt\(([^)]+)\)/g, type: "mcpPrompt" },
        { regex: /@MCP\(([^)]+)\)/g, type: "mcp" },
        { regex: /@Files\(([^)]+)\)/g, type: "file" },
        { regex: /@Folders\(([^)]+)\)/g, type: "folder" },
        { regex: /@Symbols\(([^)]+)\)/g, type: "symbol" },
        { regex: /@Docs\(([^)]+)\)/g, type: "docs" },
        { regex: /@PR\((\d+)\)/g, type: "pr" },
        { regex: /@Issue\((\d+)\)/g, type: "issue" },
        { regex: /@GitBlame\(([^)]+)\)/g, type: "gitBlame" },
        { regex: /@TestFor\(([^)]+)\)/g, type: "testFor" },
        { regex: /@Terminal\((\d+)\)/g, type: "terminal" },
      ];

    // Bare references: @Codebase, @Web, @Git, @Code, @Terminal (without parens)
    const bareReferences: Array<{ keyword: string; type: ReferenceType }> = [
      { keyword: "@Codebase", type: "codebase" },
      { keyword: "@Web", type: "web" },
      // @GitBlame must come before @Git so the bare @Git match doesn't consume @GitBlame
      { keyword: "@Git", type: "git" },
      { keyword: "@Code", type: "code" },
      { keyword: "@Terminal", type: "terminal" },
    ];

    for (const { regex, type } of parameterizedPatterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(message)) !== null) {
        refs.push({
          type,
          value: match[1].trim(),
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    for (const { keyword, type } of bareReferences) {
      let startIdx = 0;
      while (true) {
        const idx = message.indexOf(keyword, startIdx);
        if (idx === -1) break;
        // Ensure the keyword isn't a prefix of another (e.g. @Code vs @Codebase)
        // by checking the next character is a word-boundary.
        // Also skip if the keyword is immediately followed by '(' — that means
        // it has arguments and should have been matched by a parameterized pattern.
        const nextChar = message[idx + keyword.length];
        const isWordEnd =
          nextChar === undefined ||
          (!/[A-Za-z0-9_]/.test(nextChar) && nextChar !== "(");
        if (isWordEnd) {
          // Extract the value as the rest of the line after the keyword.
          const rest = message.slice(idx + keyword.length).trim();
          refs.push({
            type,
            value: rest,
            start: idx,
            end: idx + keyword.length,
          });
        }
        startIdx = idx + keyword.length;
      }
    }

    // Sort by start position so downstream consumers see references in
    // the order they appear in the original message.
    refs.sort((a, b) => a.start - b.start);
    return refs;
  }

  /**
   * Resolve a list of references into content that can be injected into
   * the LLM prompt. Each resolver handles its type-specific fetch logic.
   */
  async resolve(refs: ContextReference[]): Promise<ResolvedContext[]> {
    const resolved: ResolvedContext[] = [];

    for (const ref of refs) {
      switch (ref.type) {
        case "file": {
          if (!this.deps.fileReader) {
            resolved.push({
              type: "file",
              label: ref.value,
              content: `[File reference: ${ref.value}]`,
            });
            break;
          }
          const absPath = resolveInWorkspace(
            this.deps.workspaceRoot,
            ref.value,
          );
          let fileContent: string;
          if (absPath === null) {
            fileContent = `(path outside workspace: ${ref.value})`;
          } else {
            try {
              fileContent = await this.deps.fileReader.readFile(absPath);
            } catch {
              fileContent = `(could not read ${ref.value})`;
            }
          }
          resolved.push({
            type: "file",
            label: ref.value,
            content: fileContent,
          });
          break;
        }
        case "folder": {
          if (!this.deps.fileReader) {
            resolved.push({
              type: "folder",
              label: ref.value,
              content: `[Folder reference: ${ref.value}]`,
            });
            break;
          }
          const absDir = resolveInWorkspace(this.deps.workspaceRoot, ref.value);
          if (absDir === null) {
            resolved.push({
              type: "folder",
              label: `@Folders ${ref.value}`,
              content: `(path outside workspace: ${ref.value})`,
            });
            break;
          }
          let entries: Array<[string, "file" | "directory"]>;
          try {
            entries = await this.deps.fileReader.readdir(absDir);
          } catch {
            resolved.push({
              type: "folder",
              label: `@Folders ${ref.value}`,
              content: `(could not list ${ref.value})`,
            });
            break;
          }
          const listing = entries
            .map(([name, t]) => (t === "directory" ? `${name}/` : name))
            .join("\n");
          resolved.push({
            type: "folder",
            label: `@Folders ${ref.value}`,
            content: `Directory: ${ref.value}\n\n${listing}`,
          });
          break;
        }
        case "codebase": {
          const raw = await this.deps.indexingService.search(ref.value, 8);
          const results = Array.isArray(raw)
            ? (raw as Array<{
                filePath: string;
                chunkText: string;
                startLine: number;
                endLine: number;
                chunkType: string;
                distance: number;
              }>)
            : [];
          const isEmpty = results.length === 0;
          const content = isEmpty
            ? `(no matching results for "${ref.value}" — if the workspace is not yet indexed, wait a moment and try again)`
            : results
                .map(
                  (r) =>
                    `// ${r.filePath}:${r.startLine}-${r.endLine} [${r.chunkType}]\n${r.chunkText}`,
                )
                .join("\n\n---\n\n");
          resolved.push({
            type: "codebase",
            label: `@Codebase "${ref.value}"`,
            content,
          });
          break;
        }
        case "web": {
          let webContent: string;
          try {
            const result = await this.deps.webSearchTool.execute({
              query: ref.value,
            });
            webContent = result.success ? result.output : "[web search failed]";
          } catch {
            webContent = "[web search error — check network or API key]";
          }
          resolved.push({
            type: "web",
            label: `@Web ${ref.value}`,
            content: webContent,
          });
          break;
        }
        case "git": {
          if (!this.deps.runShellCommand) {
            resolved.push({
              type: "git",
              label: `@Git ${ref.value}`,
              content: "[Git context placeholder]",
            });
            break;
          }
          const gitCmd =
            "git diff --stat HEAD 2>/dev/null && echo '---' && git log --oneline -5 2>/dev/null && echo '---' && git status -s 2>/dev/null";
          let gitOutput: string;
          try {
            gitOutput = await this.deps.runShellCommand(
              gitCmd,
              this.deps.workspaceRoot,
            );
          } catch {
            gitOutput = "(git not available in this workspace)";
          }
          resolved.push({
            type: "git",
            label: "@Git",
            content: gitOutput || "(no git changes)",
          });
          break;
        }
        case "code": {
          if (!this.deps.getEditorContext) {
            resolved.push({
              type: "code",
              label: "@Code",
              content: "[Current editor selection placeholder]",
            });
            break;
          }
          const editorCtx = this.deps.getEditorContext();
          if (!editorCtx) {
            resolved.push({
              type: "code",
              label: "@Code",
              content:
                "(no active editor — open a file and select some code before using @Code)",
            });
            break;
          }
          resolved.push({
            type: "code",
            label: `@Code (${editorCtx.filePath})`,
            content: `// ${editorCtx.filePath} [${editorCtx.language}]\n${editorCtx.selection || "(no text selected — place cursor in editor and select code)"}`,
          });
          break;
        }
        case "symbol": {
          if (!this.deps.workspaceSymbols) {
            resolved.push({
              type: "symbol",
              label: ref.value,
              content: `[Workspace symbol: ${ref.value}]`,
            });
            break;
          }
          let symbols: Array<{
            name: string;
            filePath: string;
            kind: string;
            line: number;
          }>;
          try {
            symbols = await this.deps.workspaceSymbols(ref.value);
          } catch {
            symbols = [];
          }
          if (symbols.length === 0) {
            resolved.push({
              type: "symbol",
              label: ref.value,
              content: `(no symbols matching "${ref.value}")`,
            });
            break;
          }
          const symbolList = symbols
            .map((s) => `${s.kind} ${s.name} — ${s.filePath}:${s.line}`)
            .join("\n");
          resolved.push({
            type: "symbol",
            label: `@Symbols ${ref.value}`,
            content: symbolList,
          });
          break;
        }
        case "docs": {
          if (!this.deps.docsReader) {
            resolved.push({
              type: "docs",
              label: ref.value,
              content: `[Docs: ${ref.value} — configure docsReader for real content]`,
            });
            break;
          }
          let docsContent: string | null;
          try {
            docsContent = await this.deps.docsReader.readPackageDocs(ref.value);
          } catch {
            docsContent = null;
          }
          resolved.push({
            type: "docs",
            label: `@Docs ${ref.value}`,
            content:
              docsContent ??
              `Package "${ref.value}" not found in node_modules. Run \`npm install ${ref.value}\` to make docs available.`,
          });
          break;
        }
        case "mcp": {
          if (!this.mcpRegistry) {
            resolved.push({
              type: "mcp",
              label: ref.value,
              content: "[MCP registry not available]",
            });
            break;
          }
          const colonIdx = ref.value.indexOf(":");
          if (colonIdx === -1) {
            resolved.push({
              type: "mcp",
              label: ref.value,
              content: `[Invalid @MCP reference: missing server:uri separator]`,
            });
            break;
          }
          const serverName = ref.value.slice(0, colonIdx);
          const uri = ref.value.slice(colonIdx + 1);
          const content = await this.mcpRegistry.readResource(serverName, uri);
          resolved.push({
            type: "mcp",
            label: `MCP resource: ${serverName}/${uri}`,
            content:
              content ?? `[Resource not found: ${uri} on server ${serverName}]`,
          });
          break;
        }
        case "mcpPrompt": {
          if (!this.mcpRegistry) {
            resolved.push({
              type: "mcpPrompt",
              label: ref.value,
              content: "[MCP registry not available]",
            });
            break;
          }
          // Split on first colon to get server:rest
          const mcpColonIdx = ref.value.indexOf(":");
          if (mcpColonIdx === -1) {
            resolved.push({
              type: "mcpPrompt",
              label: ref.value,
              content: `[Invalid @MCPPrompt reference: missing server:name separator]`,
            });
            break;
          }
          const mcpServer = ref.value.slice(0, mcpColonIdx);
          const rest = ref.value.slice(mcpColonIdx + 1);
          // Split on ? to get promptName and query string
          const qIdx = rest.indexOf("?");
          const promptName = qIdx === -1 ? rest : rest.slice(0, qIdx);
          const queryStr = qIdx === -1 ? "" : rest.slice(qIdx + 1);
          // Parse query string into args object
          const args: Record<string, string> = {};
          if (queryStr) {
            for (const pair of queryStr.split("&")) {
              const eqIdx = pair.indexOf("=");
              if (eqIdx !== -1) {
                args[decodeURIComponent(pair.slice(0, eqIdx))] =
                  decodeURIComponent(pair.slice(eqIdx + 1));
              }
            }
          }
          const promptContent = await this.mcpRegistry.getPrompt(
            mcpServer,
            promptName,
            args,
          );
          resolved.push({
            type: "mcpPrompt",
            label: `MCP prompt: ${mcpServer}/${promptName}`,
            content:
              promptContent ??
              `[Prompt not found: ${promptName} on server ${mcpServer}]`,
          });
          break;
        }
        case "pr": {
          const prNumber = parseInt(ref.value, 10);
          if (isNaN(prNumber)) {
            resolved.push({
              type: "pr",
              label: `PR #${ref.value}`,
              content: "[Invalid PR number]",
            });
            break;
          }
          try {
            const { execSync } = await import("child_process");
            const prJson = execSync(
              `gh pr view ${prNumber} --json title,body,author,state,files,reviews,comments --repo $(git remote get-url origin)`,
              {
                cwd: this.deps.workspaceRoot,
                encoding: "utf-8",
                timeout: 10000,
              },
            );
            const pr = JSON.parse(prJson);
            const files = (pr.files || [])
              .slice(0, 20)
              .map(
                (f: { path: string; additions: number; deletions: number }) =>
                  `  ${f.path} (+${f.additions} -${f.deletions})`,
              )
              .join("\n");
            const comments = (pr.comments || [])
              .slice(0, 5)
              .map(
                (c: { author: { login: string }; body: string }) =>
                  `${c.author?.login}: ${c.body?.slice(0, 200)}`,
              )
              .join("\n---\n");
            const content = [
              `# PR #${prNumber}: ${pr.title}`,
              `Author: ${pr.author?.login} | State: ${pr.state}`,
              `\n## Description\n${pr.body?.slice(0, 1000) || "(no description)"}`,
              files
                ? `\n## Changed files (${pr.files?.length || 0})\n${files}`
                : "",
              comments ? `\n## Recent comments\n${comments}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            resolved.push({
              type: "pr",
              label: `PR #${prNumber}: ${pr.title}`,
              content: content.slice(0, 8000),
            });
          } catch (err) {
            resolved.push({
              type: "pr",
              label: `PR #${prNumber}`,
              content: `[Failed to fetch PR #${prNumber}: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}. Is gh CLI installed and authenticated?]`,
            });
          }
          break;
        }
        case "issue": {
          const issueNumber = parseInt(ref.value, 10);
          if (isNaN(issueNumber)) {
            resolved.push({
              type: "issue",
              label: `Issue #${ref.value}`,
              content: "[Invalid issue number]",
            });
            break;
          }
          try {
            const { execSync } = await import("child_process");
            const issueJson = execSync(
              `gh issue view ${issueNumber} --json title,body,author,state,labels,comments`,
              {
                cwd: this.deps.workspaceRoot,
                encoding: "utf-8",
                timeout: 10000,
              },
            );
            const issue = JSON.parse(issueJson);
            const labels = (issue.labels || [])
              .map((l: { name: string }) => l.name)
              .join(", ");
            const comments = (issue.comments || [])
              .slice(0, 5)
              .map(
                (c: { author: { login: string }; body: string }) =>
                  `${c.author?.login}: ${c.body?.slice(0, 300)}`,
              )
              .join("\n---\n");
            const content = [
              `# Issue #${issueNumber}: ${issue.title}`,
              `Author: ${issue.author?.login} | State: ${issue.state}`,
              labels ? `Labels: ${labels}` : "",
              `\n## Description\n${issue.body?.slice(0, 2000) || "(no description)"}`,
              comments ? `\n## Comments\n${comments}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            resolved.push({
              type: "issue",
              label: `Issue #${issueNumber}: ${issue.title}`,
              content: content.slice(0, 8000),
            });
          } catch (err) {
            resolved.push({
              type: "issue",
              label: `Issue #${issueNumber}`,
              content: `[Failed to fetch Issue #${issueNumber}: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}]`,
            });
          }
          break;
        }
        case "terminal": {
          // ref.value is either empty (bare @Terminal) or a digit string from @Terminal(50)
          const lines = parseInt(ref.value || "30", 10) || 30;
          const stored =
            this.deps.workspaceState?.get<string>("champ.lastTerminalOutput") ??
            "";
          const content = stored
            ? stored.split("\n").slice(-lines).join("\n")
            : "[No recent terminal output captured. Run a command first.]";
          resolved.push({
            type: "terminal",
            label: "Recent terminal output",
            content,
          });
          break;
        }
        case "gitBlame": {
          // ref.value is "src/foo.ts:42"
          const colonIdx = ref.value.lastIndexOf(":");
          const filePath =
            colonIdx !== -1 ? ref.value.slice(0, colonIdx) : ref.value;
          const line =
            colonIdx !== -1
              ? parseInt(ref.value.slice(colonIdx + 1), 10) || 1
              : 1;
          try {
            const { execSync } = await import("child_process");
            const blameOutput = execSync(
              `git blame -L ${line},${line} "${filePath}" --porcelain`,
              {
                cwd: this.deps.workspaceRoot,
                encoding: "utf-8",
                timeout: 5000,
              },
            );
            resolved.push({
              type: "gitBlame",
              label: `Git blame: ${filePath}:${line}`,
              content: blameOutput.slice(0, 4000),
            });
          } catch {
            resolved.push({
              type: "gitBlame",
              label: `Git blame: ${filePath}:${line}`,
              content: `[Git blame failed for ${filePath}:${line}]`,
            });
          }
          break;
        }
        case "testFor": {
          const symbolName = ref.value.trim();
          const { execSync } = await import("child_process");
          let defContent = "";
          let testContent = "";
          try {
            const grepResult = execSync(
              `grep -rn "function ${symbolName}\\|const ${symbolName}\\|${symbolName}(" src/ --include="*.ts" -l`,
              {
                cwd: this.deps.workspaceRoot,
                encoding: "utf-8",
                timeout: 3000,
              },
            );
            const files = grepResult
              .trim()
              .split("\n")
              .filter(Boolean)
              .slice(0, 3);
            for (const f of files) {
              if (f.includes(".test.") || f.includes(".spec.")) continue;
              const content = await import("fs/promises")
                .then((fs) =>
                  fs.readFile(
                    require("path").join(this.deps.workspaceRoot, f.trim()),
                    "utf-8",
                  ),
                )
                .catch(() => "");
              defContent += `// ${f}\n${content.slice(0, 3000)}\n\n`;
            }
            // Find existing tests
            const testGrep = execSync(
              `grep -rn "${symbolName}" src/ test/ --include="*.test.ts" --include="*.spec.ts" -l`,
              {
                cwd: this.deps.workspaceRoot,
                encoding: "utf-8",
                timeout: 3000,
              },
            )
              .trim()
              .split("\n")
              .filter(Boolean)
              .slice(0, 2);
            for (const tf of testGrep) {
              const content = await import("fs/promises")
                .then((fs) =>
                  fs.readFile(
                    require("path").join(this.deps.workspaceRoot, tf.trim()),
                    "utf-8",
                  ),
                )
                .catch(() => "");
              testContent += `// ${tf} (existing tests)\n${content.slice(0, 2000)}\n\n`;
            }
          } catch {
            /* ignore grep failures — symbol or directory may not exist */
          }
          const combined = [
            defContent ? `## Function definition\n${defContent}` : "",
            testContent
              ? `## Existing tests\n${testContent}`
              : "(no existing tests found)",
          ]
            .filter(Boolean)
            .join("\n");
          resolved.push({
            type: "testFor",
            label: `Test context: ${symbolName}`,
            content: combined || `[Symbol ${symbolName} not found]`,
          });
          break;
        }
      }
    }

    return resolved;
  }

  /**
   * Return autocomplete suggestions for the chat input's @-dropdown.
   * Given a prefix like "@Fi" returns `@Files`, given bare "@" returns
   * the full catalogue.
   */
  getAutocompleteSuggestions(prefix: string): AtSymbolSuggestion[] {
    if (!prefix.startsWith("@")) return [];
    if (prefix === "@") return [...AT_SYMBOL_CATALOGUE];

    const lowered = prefix.toLowerCase();
    return AT_SYMBOL_CATALOGUE.filter((s) =>
      s.label.toLowerCase().startsWith(lowered),
    );
  }
}
