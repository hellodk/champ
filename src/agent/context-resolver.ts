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
  | "mcpPrompt";

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
      ];

    // Bare references: @Codebase, @Web, @Git, @Code
    const bareReferences: Array<{ keyword: string; type: ReferenceType }> = [
      { keyword: "@Codebase", type: "codebase" },
      { keyword: "@Web", type: "web" },
      { keyword: "@Git", type: "git" },
      { keyword: "@Code", type: "code" },
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
        const nextChar = message[idx + keyword.length];
        const isWordEnd =
          nextChar === undefined || !/[A-Za-z0-9_]/.test(nextChar);
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
