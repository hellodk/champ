// webview-ui/src/index.tsx — Preact app entry point
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";
import { MemoryPanel } from "./components/MemoryPanel";

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

const root = document.getElementById("champ-panels");
if (root) {
  render(<App />, root);
}
