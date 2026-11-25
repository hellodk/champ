/**
 * End-to-end vendor-neutral packaging check: a production-only install must
 * run the default WebDriver path without a Playwright package or Chromium
 * binary being present.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCli } from "../helpers/cli-harness";

const ROOT = path.resolve(__dirname, "../..");
const TIMEOUT = 300_000;
let tmp = "";
let tarball = "";

beforeAll(async () => {
  await buildCli();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "champ-browser-pack-"));
  const packDir = path.join(tmp, "packed");
  fs.mkdirSync(packDir, { recursive: true });
  const packOutput = execFileSync(
    "corepack",
    ["pnpm", "pack", "--json", "--pack-destination", packDir],
    { cwd: ROOT, encoding: "utf8" },
  );
  // pnpm prints lifecycle logs before the JSON report.
  const report = JSON.parse(packOutput.slice(packOutput.indexOf("{"))) as {
    filename: string;
  };
  tarball = report.filename;
}, TIMEOUT);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clean production browser packaging", () => {
  it(
    "does not bundle browser runtime modules into the extension artifact",
    () => {
      execFileSync(process.execPath, ["esbuild.mjs"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: TIMEOUT,
      });
      const bundle = fs.readFileSync(
        path.join(ROOT, "dist/extension.js"),
        "utf8",
      );
      expect(bundle).not.toContain('require("playwright-core")');
      expect(bundle).not.toContain('require("playwright")');
    },
    TIMEOUT,
  );

  it(
    "runs default browser diagnostics without a browser binary",
    () => {
      const installDir = path.join(tmp, "install");
      fs.mkdirSync(installDir, { recursive: true });
      execFileSync(
        "corepack",
        ["pnpm", "install", "--prod", "--ignore-scripts", tarball],
        { cwd: installDir, encoding: "utf8", stdio: "pipe", timeout: TIMEOUT },
      );

      const cliPath = path.join(
        installDir,
        "node_modules",
        "champ",
        "dist",
        "cli.js",
      );
      const result = spawnSync(
        process.execPath,
        [cliPath, "browser", "check"],
        {
          cwd: installDir,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            CHAMP_WEBDRIVER_URL: "http://127.0.0.1:1",
          },
        },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(output).toContain("W3C WebDriver");
      expect(output).not.toContain("Cannot find module 'playwright'");
      expect(result.status).toBe(1);
    },
    TIMEOUT,
  );
});
