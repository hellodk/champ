// webview-ui/src/components/McpMarketplacePanel.tsx
import { signal, computed } from "@preact/signals";
import type { McpMarketplaceEntry } from "../types";

export const isOpenSignal = signal(false);
export const entriesSignal = signal<McpMarketplaceEntry[]>([]);
const isLoadingSignal = signal(false);
const searchQuerySignal = signal("");
const installedNamesSignal = signal<Set<string>>(new Set());
const installErrorsSignal = signal<Map<string, string>>(new Map());

const filteredEntriesSignal = computed(() => {
  const q = searchQuerySignal.value.toLowerCase();
  if (!q) return entriesSignal.value;
  return entriesSignal.value.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
});

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (
    typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined"
  ) {
    return (
      window as unknown as { vscode: { postMessage: (msg: unknown) => void } }
    ).vscode;
  }
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
}

window.addEventListener("champ:mcpMarketplaceOpen", () => {
  isOpenSignal.value = true;
  isLoadingSignal.value = true;
  entriesSignal.value = [];
  installedNamesSignal.value = new Set();
  installErrorsSignal.value = new Map();
  searchQuerySignal.value = "";
  getVsCode().postMessage({ type: "fetchMcpMarketplace" });
});

window.addEventListener("champ:mcpMarketplaceEntries", (e: Event) => {
  const msg = (e as CustomEvent<{ entries: McpMarketplaceEntry[] }>).detail;
  if (Array.isArray(msg.entries)) {
    entriesSignal.value = msg.entries;
  }
  isLoadingSignal.value = false;
});

window.addEventListener("champ:mcpMarketplaceInstallComplete", (e: Event) => {
  const msg = (
    e as CustomEvent<{ name: string; success: boolean; errorMessage?: string }>
  ).detail;
  if (msg.success) {
    const next = new Set(installedNamesSignal.value);
    next.add(msg.name);
    installedNamesSignal.value = next;
  } else {
    const next = new Map(installErrorsSignal.value);
    next.set(msg.name, msg.errorMessage ?? "Installation failed");
    installErrorsSignal.value = next;
  }
});

function TagChip({ tag }: { tag: string }): JSX.Element {
  return (
    <span
      style="display:inline-block; padding:1px 6px; margin:1px 2px; border-radius:10px;
             font-size:10px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground);"
    >
      {tag}
    </span>
  );
}

function ServerCard({ entry }: { entry: McpMarketplaceEntry }): JSX.Element {
  const isInstalled = installedNamesSignal.value.has(entry.name);
  const errorMsg = installErrorsSignal.value.get(entry.name);

  function handleInstall(): void {
    getVsCode().postMessage({ type: "mcpMarketplaceInstall", entry });
  }

  return (
    <div
      style="border:1px solid var(--vscode-panel-border); border-radius:6px;
             padding:10px 12px; background:var(--vscode-editor-background);
             display:flex; flex-direction:column; gap:6px;"
    >
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px; font-weight:600;">{entry.name}</span>
        <span
          style="font-size:10px; padding:1px 5px; border-radius:3px;
                 background:var(--vscode-badge-background); color:var(--vscode-badge-foreground);"
        >
          {entry.transport}
        </span>
      </div>
      <p style="margin:0; font-size:12px; color:var(--vscode-descriptionForeground); line-height:1.4;">
        {entry.description}
      </p>
      <div style="display:flex; flex-wrap:wrap; gap:2px;">
        {entry.tags.map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </div>
      {errorMsg && (
        <p style="margin:0; font-size:11px; color:var(--vscode-inputValidation-errorForeground);">
          Error: {errorMsg}
        </p>
      )}
      <button
        onClick={isInstalled ? undefined : handleInstall}
        disabled={isInstalled}
        style={`margin-top:4px; padding:4px 10px; cursor:${isInstalled ? "default" : "pointer"};
                background:${isInstalled ? "transparent" : "var(--vscode-button-background)"};
                color:${isInstalled ? "var(--vscode-terminal-ansiGreen)" : "var(--vscode-button-foreground)"};
                border:${isInstalled ? "1px solid var(--vscode-terminal-ansiGreen)" : "none"};
                border-radius:3px; font-size:12px;`}
      >
        {isInstalled ? "Installed" : "Install"}
      </button>
    </div>
  );
}

export function McpMarketplacePanel(): JSX.Element | null {
  if (!isOpenSignal.value) return null;

  function handleClose(): void {
    isOpenSignal.value = false;
  }

  function handleSearchInput(e: Event): void {
    searchQuerySignal.value = (e.target as HTMLInputElement).value;
  }

  const filtered = filteredEntriesSignal.value;

  return (
    <div
      style="position:fixed; inset:0; z-index:200;
             background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;"
      onClick={(e: MouseEvent) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style="background:var(--vscode-sideBar-background); border-radius:8px;
               width:min(640px,90vw); max-height:80vh; display:flex; flex-direction:column;
               overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.5);"
      >
        <div
          style="display:flex; justify-content:space-between; align-items:center;
                 padding:12px 16px; background:var(--vscode-titleBar-activeBackground);
                 flex-shrink:0;"
        >
          <span style="font-size:14px; font-weight:700;">
            MCP Server Marketplace
          </span>
          <button
            onClick={handleClose}
            style="background:none; border:none; cursor:pointer;
                   color:var(--vscode-icon-foreground); font-size:18px; line-height:1;"
            aria-label="Close marketplace"
          >
            x
          </button>
        </div>

        <div style="padding:10px 16px; flex-shrink:0;">
          <input
            type="text"
            placeholder="Search servers..."
            value={searchQuerySignal.value}
            onInput={handleSearchInput}
            style="width:100%; box-sizing:border-box; padding:6px 10px;
                   background:var(--vscode-input-background); color:var(--vscode-input-foreground);
                   border:1px solid var(--vscode-input-border); border-radius:4px; font-size:13px;"
          />
        </div>

        <div style="overflow-y:auto; padding:0 16px 16px; flex:1;">
          {isLoadingSignal.value && (
            <p style="text-align:center; color:var(--vscode-descriptionForeground); padding:24px 0;">
              Loading marketplace...
            </p>
          )}

          {!isLoadingSignal.value && filtered.length === 0 && (
            <p style="text-align:center; color:var(--vscode-descriptionForeground); padding:24px 0;">
              {searchQuerySignal.value
                ? "No servers match your search."
                : "No servers available."}
            </p>
          )}

          {!isLoadingSignal.value && filtered.length > 0 && (
            <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px;">
              {filtered.map((entry) => (
                <ServerCard key={entry.name} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
