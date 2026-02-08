import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/encode.test.ts",
      "test/instructions.test.ts",
      "test/pda.test.ts",
      "test/slab-parser.test.ts",
    ],
  },
});
