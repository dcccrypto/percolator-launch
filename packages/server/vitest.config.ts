import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "tests/",
        "**/*.test.ts",
        "**/*.config.ts",
      ],
      lines: 90,
      functions: 90,
      branches: 85,
      statements: 90,
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
