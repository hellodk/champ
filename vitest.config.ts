import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/extension.ts"],
    },
    setupFiles: ["test/setup.ts"],
    reporters: ["verbose", "json"],
    outputFile: {
      json: "test-reports/latest.json",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
});
