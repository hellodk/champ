/**
 * `champ browser` — diagnose the configured browser adapter.
 *
 * Champ does not download browsers. This command reports the selected
 * protocol and, for HTTP-based adapters, whether its endpoint is reachable.
 */
import {
  describeBrowserRuntime,
  readBrowserSettings,
  type BrowserRuntimeStatus,
  type BrowserSettings,
} from "../tools/browser-adapters";

export type BrowserCommand = "check" | "install";

export interface BrowserCommandIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface BrowserCommandDeps {
  settings?: BrowserSettings;
  describeRuntime?: (
    settings: BrowserSettings,
  ) => Promise<BrowserRuntimeStatus>;
}

export async function runBrowserCommand(
  command: BrowserCommand,
  io: BrowserCommandIO,
  deps: BrowserCommandDeps = {},
): Promise<number> {
  const settings = deps.settings ?? readBrowserSettings();

  if (command === "install") {
    const lines = [
      "Champ does not bundle browsers or download runtime binaries.",
    ];
    if (settings.protocol === "playwright") {
      lines.push(
        "The Playwright adapter is optional: install it yourself with `corepack pnpm add -D playwright`, then provision a browser with `corepack pnpm exec playwright install <browser>`.",
      );
    } else {
      lines.push(
        "Configure a W3C WebDriver server and set CHAMP_WEBDRIVER_URL (or CHAMP_REMOTE_BROWSER_URL for the remote adapter).",
      );
    }
    io.stdout(`${lines.join("\n")}\n`);
    return 0;
  }

  const status = deps.describeRuntime
    ? await deps.describeRuntime(settings)
    : await describeBrowserRuntime(settings);
  const line = `${status.message}\n`;
  if (status.ok) {
    io.stdout(line);
    return 0;
  }
  io.stderr(line);
  return 1;
}
