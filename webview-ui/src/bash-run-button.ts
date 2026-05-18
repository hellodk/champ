/**
 * bash-run-button.ts
 *
 * Post-render DOM enhancement: injects a "▶ Run" button on every
 * ```bash``` or ```sh``` fenced code block in the chat webview. When
 * clicked, sends a RunInTerminalRequest to the extension host and
 * renders streaming output inline below the code block.
 *
 * NOTE: This module documents the logic that is inlined directly into
 * webview-ui/dist/main.js (which is a hand-written vanilla JS file, not
 * produced by esbuild). When modifying this file, apply the same changes
 * to the injectRunButtons() function in main.js.
 *
 * Call injectRunButtons() after any DOM mutation that adds new code blocks.
 */

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };
declare const vscode: { postMessage: (msg: unknown) => void } | undefined;

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (typeof vscode !== "undefined") return vscode;
  return acquireVsCodeApi();
}

export function injectRunButtons(): void {
  const codeBlocks = document.querySelectorAll<HTMLElement>(
    'pre > code[class*="language-bash"]:not([data-run-injected]), ' +
      'pre > code[class*="language-sh"]:not([data-run-injected])',
  );

  codeBlocks.forEach((codeEl) => {
    codeEl.setAttribute("data-run-injected", "true");
    const pre = codeEl.parentElement as HTMLPreElement | null;
    if (!pre) return;

    const btn = document.createElement("button");
    btn.textContent = "▶ Run";
    btn.title = "Run this command in the workspace terminal";
    btn.style.cssText = [
      "position:absolute",
      "top:4px",
      "right:4px",
      "font-size:11px",
      "padding:2px 8px",
      "cursor:pointer",
      "background:var(--vscode-button-background)",
      "color:var(--vscode-button-foreground)",
      "border:none",
      "border-radius:2px",
      "opacity:0.85",
    ].join(";");

    btn.addEventListener("click", () => {
      const command = codeEl.textContent ?? "";
      const executionId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const outputDiv = document.createElement("div");
      outputDiv.id = `terminal-output-${executionId}`;
      outputDiv.style.cssText = [
        "margin-top:4px",
        "padding:6px 8px",
        "background:var(--vscode-terminal-background, var(--vscode-editor-background))",
        "border:1px solid var(--vscode-panel-border)",
        "border-radius:2px",
        "font-family:var(--vscode-editor-font-family, monospace)",
        "font-size:12px",
        "white-space:pre-wrap",
        "word-break:break-all",
        "max-height:240px",
        "overflow-y:auto",
        "color:var(--vscode-terminal-foreground, var(--vscode-editor-foreground))",
      ].join(";");
      outputDiv.textContent = `$ ${command.trim()}\n`;
      pre.insertAdjacentElement("afterend", outputDiv);

      btn.disabled = true;
      btn.textContent = "Running…";

      getVsCode().postMessage({
        type: "runInTerminal",
        command: command.trim(),
        executionId,
      });
    });

    pre.style.position = "relative";
    pre.appendChild(btn);
  });
}

/**
 * Handle TerminalOutputChunkMessage sent back from the extension host.
 * Appends each chunk to the correct output div and re-enables the button
 * when done=true.
 */
export function handleTerminalChunk(msg: {
  type: string;
  executionId: string;
  chunk: string;
  done: boolean;
}): void {
  if (msg.type !== "terminalOutputChunk") return;
  const outputDiv = document.getElementById(
    `terminal-output-${msg.executionId}`,
  );
  if (!outputDiv) return;

  if (msg.chunk) {
    outputDiv.textContent += msg.chunk;
    outputDiv.scrollTop = outputDiv.scrollHeight;
  }

  if (msg.done) {
    const pre = outputDiv.previousElementSibling as HTMLPreElement | null;
    if (pre) {
      const btn = pre.querySelector<HTMLButtonElement>(
        "button[title='Run this command in the workspace terminal']",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "▶ Run";
      }
    }
  }
}
