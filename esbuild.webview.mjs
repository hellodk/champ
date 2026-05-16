// esbuild.webview.mjs — builds the Preact webview bundle
import * as esbuild from "esbuild";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ["webview-ui/src/index.tsx"],
  bundle: true,
  outfile: "webview-ui/dist/components.js",
  format: "iife",
  globalName: "ChampPanels",
  platform: "browser",
  target: ["es2020"],
  alias: {
    react: "preact/compat",
    "react-dom": "preact/compat",
    "react-dom/test-utils": "preact/test-utils",
  },
  define: {
    "process.env.NODE_ENV": isProduction ? '"production"' : '"development"',
  },
  minify: isProduction,
  sourcemap: !isProduction,
  sourcesContent: false,
  logLevel: "info",
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild.webview] Watching for changes…");
} else {
  await esbuild.build(options);
  console.log("[esbuild.webview] Build complete →", options.outfile);
}
