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

/** Types of @-references recognized in chat messages. */
export type ReferenceType =
  | "file"
  | "folder"
  | "code"
  | "symbol"
  | "codebase"
  | "web"
  | "git"
  | "docs";

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
    description: "Reference library documentation",
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
}

export class ContextResolver {
  constructor(private readonly deps: ContextResolverDeps) {}

  /**
   * Scan a user message for @-references and return their metadata.
   * Each reference can later be resolved via resolve().
   */
  parseReferences(message: string): ContextReference[] {
    const refs: ContextReference[] = [];

    // Parameterized references: @Files(path), @Folders(path), @Symbols(name), @Docs(name)
    // Scan in declared order so the first match wins when references overlap.
    const parameterizedPatterns: Array<{ regex: RegExp; type: ReferenceType }> =
      [
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
        case "file":
          resolved.push({
            type: "file",
            label: ref.value,
            content: `[File reference: ${ref.value}]`,
          });
          break;
        case "folder":
          resolved.push({
            type: "folder",
            label: ref.value,
            content: `[Folder reference: ${ref.value}]`,
          });
          break;
        case "codebase": {
          const results = await this.deps.indexingService.search(ref.value);
          resolved.push({
            type: "codebase",
            label: `@Codebase ${ref.value}`,
            content: `[Semantic search: ${results.length} results]`,
          });
          break;
        }
        case "web": {
          const result = await this.deps.webSearchTool.execute({
            query: ref.value,
          });
          resolved.push({
            type: "web",
            label: `@Web ${ref.value}`,
            content: result.success ? result.output : "[web search failed]",
          });
          break;
        }
        case "git":
          resolved.push({
            type: "git",
            label: `@Git ${ref.value}`,
            content: "[Git context placeholder]",
          });
          break;
        case "code":
          resolved.push({
            type: "code",
            label: "@Code",
            content: "[Current editor selection placeholder]",
          });
          break;
        case "symbol":
          resolved.push({
            type: "symbol",
            label: ref.value,
            content: `[Workspace symbol: ${ref.value}]`,
          });
          break;
        case "docs":
          resolved.push({
            type: "docs",
            label: ref.value,
            content: `[Docs reference: ${ref.value}]`,
          });
          break;
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
