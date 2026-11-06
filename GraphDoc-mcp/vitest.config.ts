import { defineConfig } from "vitest/config";

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Fixtures are sample source for the analyzer, not test files.
    exclude: ["node_modules", "dist", "test/fixtures/**"],
  },
});
