/**
 * Browser runtime detection shared by the extension and the headless CLI.
 *
 * Playwright's npm package does not ship Chromium. A clean machine therefore
 * needs an explicit browser install; detect it before launch so the failure
 * names a command the operator can run instead of a raw Playwright stack.
 */
import * as fs from "fs";

export const BROWSER_INSTALL_COMMAND = "champ browser install";
export const BROWSER_INSTALL_HINT = "pnpm exec playwright install chromium";

export interface BrowserRuntimeStatus {
  installed: boolean;
  executablePath?: string;
  installCommand: string;
  reason?: string;
}

export interface BrowserRuntimeDeps {
  executablePath?: () => string;
  exists?: (filePath: string) => boolean;
}

export async function detectBrowserRuntime(
  deps: BrowserRuntimeDeps = {},
): Promise<BrowserRuntimeStatus> {
  const installCommand = BROWSER_INSTALL_COMMAND;
  let executablePath: string;
  try {
    if (deps.executablePath) {
      executablePath = deps.executablePath();
    } else {
      const { chromium } = await import("playwright");
      executablePath = chromium.executablePath();
    }
  } catch (err) {
    return {
      installed: false,
      installCommand,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
  if (!exists(executablePath)) {
    return {
      installed: false,
      executablePath,
      installCommand,
      reason: `Chromium executable is missing at ${executablePath}`,
    };
  }
  return { installed: true, executablePath, installCommand };
}

export function browserUnavailableMessage(
  status: BrowserRuntimeStatus,
): string {
  const detail = status.reason ? ` (${status.reason})` : "";
  return `browser is unavailable: Chromium is not installed${detail}. Run \`${status.installCommand}\` (or \`${BROWSER_INSTALL_HINT}\`) and retry.`;
}
