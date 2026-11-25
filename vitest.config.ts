import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      "test/unit/**/*.test.tsx",
      "test/eval/**/*.test.ts",
      "src/**/__tests__/**/*.test.ts",
      "scripts/__tests__/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist"],
    globals: true,
    environment: "node",
    environmentMatchGlobs: [["test/unit/webview/**", "jsdom"]],
    coverage: {
      provider: "v8",
      reportsDirectory: "test-reports/unit",
      reporter: ["text", ["json", { file: "coverage.json" }]],
      include: ["src/**/*.ts"],
      exclude: ["src/extension.ts"],
    },
    setupFiles: ["test/setup.ts"],
    reporters: [
      "verbose",
      ["json", { outputFile: "test-reports/latest.json" }],
      ["junit", { outputFile: "test-reports/unit/results.xml" }],
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
});
