// webview-ui/src/index.tsx — Preact app entry point
import { render } from "preact";
import { DiffOverlayPanel } from "./components/DiffOverlayPanel";
import { AgentGraphPanel } from "./components/AgentGraphPanel";
import { McpMarketplacePanel } from "./components/McpMarketplacePanel";

function App(): JSX.Element {
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
