/**
 * Shared in-memory buffer for the last terminal command output.
 * Written by both the run_terminal_cmd agent tool and the webview Run button.
 * Read by the @Terminal context reference.
 */
const MAX_BYTES = 50_000;
let buffer = "";

export const terminalOutputBuffer = {
  write(output: string): void {
    buffer = (buffer + output).slice(-MAX_BYTES);
  },
  read(lines = 30): string {
    if (!buffer) return "";
    return buffer.split("\n").slice(-lines).join("\n");
  },
  clear(): void {
    buffer = "";
  },
};
