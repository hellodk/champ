import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    reporters: ["verbose", "json", "html"],
    outputFile: {
      json: "test-reports/e2e/results.json",
      html: "test-reports/e2e/index.html",
    },
    globals: true,
    setupFiles: ["test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
});
