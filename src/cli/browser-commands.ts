/**
 * `champ browser` — first-run browser runtime detection and installation.
 */
import { spawnSync } from "child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  browserUnavailableMessage,
  detectBrowserRuntime,
} from "../tools/browser-runtime";

export type BrowserCommand = "check" | "install";

export interface BrowserCommandIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Locate the Playwright CLI without relying on an unexported subpath. */
export function playwrightCliPath(): string {
  // CJS bundles have __filename; Vitest's ESM transform does not.
  const base =
    typeof __filename === "string"
      ? __filename
      : path.join(process.cwd(), "cli.js");
  const req = createRequire(base);
  return path.join(
    path.dirname(req.resolve("playwright/package.json")),
    "cli.js",
  );
}

export async function runBrowserCommand(
  command: BrowserCommand,
  io: BrowserCommandIO,
): Promise<number> {
  const status = await detectBrowserRuntime();
  if (command === "check") {
    if (status.installed) {
      io.stdout(
        `browser runtime ready: ${status.executablePath ?? "chromium"}\n`,
      );
      return 0;
    }
    io.stderr(`${browserUnavailableMessage(status)}\n`);
    return 1;
  }

  if (status.installed) {
    io.stdout(`browser runtime already installed: ${status.executablePath}\n`);
    return 0;
  }

  let cliPath: string;
  try {
    cliPath = playwrightCliPath();
  } catch {
    io.stderr(
      "champ: playwright is not installed; run `corepack pnpm install` first.\n",
    );
    return 1;
  }
  const result = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    io.stderr(
      "champ: browser installation failed; check the Playwright output above.\n",
    );
    return 1;
  }
  io.stdout(
    "champ: Chromium installed. Run `champ browser check` to verify.\n",
  );
  return 0;
}
