// Minimal shims so webview IIFE helpers can be imported in jsdom.
// acquireVsCodeApi is injected by VS Code at runtime; stub it here.
(globalThis as any).acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => ({}),
  setState: () => {},
});
