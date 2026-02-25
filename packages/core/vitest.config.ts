import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/encode.test.ts",
      "test/instructions.test.ts",
      "test/pda.test.ts",
      "test/slab-parser.test.ts",
      "test/accounts.test.ts",
      "test/errors.test.ts",
      "test/discovery.test.ts",
      "test/price-router.test.ts",
      "src/solana/__tests__/stake.test.ts",
      "src/solana/__tests__/stake-cpi.test.ts",
    ],
  },
});
