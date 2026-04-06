// VS Code API mock for unit testing outside the extension host
// This provides minimal stubs so imports of 'vscode' resolve in vitest

export const Uri = {
  file: (path: string) => ({
    scheme: "file",
    fsPath: path,
    path,
    toString: () => path,
  }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join("/");
    return {
      scheme: "file",
      fsPath: joined,
      path: joined,
      toString: () => joined,
    };
  },
  parse: (str: string) => ({
    scheme: "file",
    fsPath: str,
    path: str,
    toString: () => str,
  }),
};

export const workspace = {
  fs: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    delete: vi.fn(),
    readDirectory: vi.fn(),
    stat: vi.fn(),
    createDirectory: vi.fn(),
  },
  applyEdit: vi.fn().mockResolvedValue(true),
  findFiles: vi.fn().mockResolvedValue([]),
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn(),
    update: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    inspect: vi.fn(),
  }),
  workspaceFolders: [
    {
      uri: { fsPath: "/test-workspace", scheme: "file" },
      name: "test",
      index: 0,
    },
  ],
  createFileSystemWatcher: vi.fn().mockReturnValue({
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  }),
  openTextDocument: vi.fn(),
  asRelativePath: vi.fn((path: string) => path),
};

export const window = {
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  createOutputChannel: vi.fn().mockReturnValue({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  createWebviewPanel: vi.fn(),
  registerWebviewViewProvider: vi.fn(),
  activeTextEditor: undefined,
  visibleTextEditors: [],
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export const languages = {
  getDiagnostics: vi.fn().mockReturnValue([]),
  onDidChangeDiagnostics: vi.fn(),
  registerInlineCompletionItemProvider: vi.fn(),
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class WorkspaceEdit {
  private _edits: Array<{ uri: unknown; range: Range; newText: string }> = [];
  replace(uri: unknown, range: Range, newText: string): void {
    this._edits.push({ uri, range, newText });
  }
  get size(): number {
    return this._edits.length;
  }
}

export class InlineCompletionItem {
  constructor(
    public insertText: string,
    public range?: Range,
  ) {}
}

export class InlineCompletionList {
  constructor(public items: InlineCompletionItem[]) {}
}

export const EventEmitter = vi.fn().mockImplementation(() => ({
  event: vi.fn(),
  fire: vi.fn(),
  dispose: vi.fn(),
}));

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

export const SecretStorage = vi.fn();

export enum ViewColumn {
  One = 1,
  Two = 2,
}

export const ExtensionContext = vi.fn();
