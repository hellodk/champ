/**
 * End-to-end browser runtime check: a clean production-only install of the
 * published artifact must be able to launch Chromium, not merely declare the
 * dependency in package.json.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
  const report = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
      { cwd: ROOT, encoding: "utf8" },
    ),
  ) as Array<{ filename: string }>;
  tarball = path.join(packDir, report[0].filename);
}, TIMEOUT);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clean production browser runtime", () => {
  it(
    "bundles the browser runtime into the VSIX extension artifact",
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
    },
    TIMEOUT,
  );

  it(
    "launches Chromium from a production-only install",
    () => {
      const installDir = path.join(tmp, "install");
      fs.mkdirSync(installDir, { recursive: true });
      execFileSync(
        "npm",
        [
          "install",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        { cwd: installDir, encoding: "utf8", stdio: "pipe", timeout: TIMEOUT },
      );

      const script = [
        "const { chromium } = require('playwright');",
        "(async () => {",
        "  const browser = await chromium.launch({ headless: true });",
        "  const page = await browser.newPage();",
        "  await page.setContent('<title>champ-runtime-ok</title>');",
        "  const title = await page.title();",
        "  await browser.close();",
        "  if (title !== 'champ-runtime-ok') process.exit(2);",
        "})().catch((err) => { console.error(err.message); process.exit(1); });",
      ].join("\n");
      const scriptPath = path.join(installDir, "launch.js");
      fs.writeFileSync(scriptPath, script);

      const output = execFileSync(process.execPath, [scriptPath], {
        cwd: installDir,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(output).toBe("");
    },
    TIMEOUT,
  );
});
