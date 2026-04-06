import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    globals: true,
    environment: "node",
    testTimeout: 30000,
    setupFiles: ["test/setup.ts"],
    reporters: ["verbose", "json"],
    outputFile: {
      json: "test-reports/integration-latest.json",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
});
