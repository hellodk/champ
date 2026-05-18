// webview-ui/src/index.tsx — Preact app entry point
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { TeamBuilderPanel } from "./components/TeamBuilderPanel";
import { RulesEditorPanel } from "./components/RulesEditorPanel";

function App(): JSX.Element {
  const isMemoryPanel = (
    window as unknown as { __CHAMP_MEMORY_PANEL__?: boolean }
  ).__CHAMP_MEMORY_PANEL__;
  if (isMemoryPanel) {
    return <MemoryPanel />;
  }
  return (
    <>
      <DiffOverlayPanel />
      <AgentGraphPanel />
      <McpMarketplacePanel />
    </>
  );
}

// Main chat view — always mounted
const root = document.getElementById("champ-panels");
if (root) {
  render(<App />, root);
}

// Team builder view — mounted by team-builder-panel.ts
function mountTeamBuilder(container: HTMLElement): void {
  render(<TeamBuilderPanel />, container);
}

// Rules editor view — mounted by rules-editor-panel.ts
function mountRulesEditor(container: HTMLElement): void {
  render(<RulesEditorPanel />, container);
}

// Expose mount functions for the separate WebviewPanel HTML scripts
declare global {
  interface Window {
    ChampPanels: {
      mountTeamBuilder: (container: HTMLElement) => void;
      mountRulesEditor: (container: HTMLElement) => void;
    };
  }
}

// The bundle is compiled as an IIFE with globalName "ChampPanels" by
// esbuild.webview.mjs — so we attach to `window.ChampPanels` directly.
Object.assign(window.ChampPanels ?? {}, { mountTeamBuilder, mountRulesEditor });
