// scripts/copy-assets.mjs — copies static webview assets into webview-ui/dist/
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copied ${path.relative(root, src)} → ${path.relative(root, dest)}`);
}

// 1. Hand-written source files (in webview-ui/static/, tracked in git)
cp(
  path.join(root, "webview-ui/static/main.js"),
  path.join(root, "webview-ui/dist/main.js"),
);
cp(
  path.join(root, "webview-ui/static/main.css"),
  path.join(root, "webview-ui/dist/main.css"),
);

// 2. VS Code codicons (from node_modules)
cp(
  path.join(root, "node_modules/@vscode/codicons/dist/codicon.css"),
  path.join(root, "webview-ui/dist/codicons/codicon.css"),
);
cp(
  path.join(root, "node_modules/@vscode/codicons/dist/codicon.ttf"),
  path.join(root, "webview-ui/dist/codicons/codicon.ttf"),
);

// 3. highlight.js dark theme CSS (from node_modules — github-dark-dimmed)
cp(
  path.join(root, "node_modules/highlight.js/styles/github-dark-dimmed.min.css"),
  path.join(root, "webview-ui/dist/highlight-dark.min.css"),
);

// 4. Bundle highlight.js into a single IIFE for the webview
await esbuild.build({
  entryPoints: [path.join(root, "node_modules/highlight.js/es/index.js")],
  bundle: true,
  outfile: path.join(root, "webview-ui/dist/highlight.min.js"),
  format: "iife",
  globalName: "hljs",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  logLevel: "info",
});
console.log("  bundled highlight.js → webview-ui/dist/highlight.min.js");

console.log("[copy-assets] Done.");
