/**
 * GH#2882 (SI): a market that is close-only after an ADL, or whose counterparty has no funds, does
 * not reopen by itself: a solvent holder may keep the other side open indefinitely, and nothing in
 * the app re-funds a non-vault counterparty. The copy promised both. These phrases must not return.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");
const FILES = ["lib/limits/copy.ts", "lib/limits/user-message.ts", "lib/market-error.ts", "lib/market-health.ts"];
// The ADL close-only and depleted-counterparty promises. (The header "recovery" lock is a different
// state and keeps its own copy.)
const PROMISES = [
  /reopen on their own, usually within minutes/i,
  /reopens on its own once (one side|positions)/i,
  /no admin step/i,
  /until the market's liquidity recovers/i,
  /until the LP is re-funded/i,
  /no liquidity for new positions/i,
];

describe("lock copy makes no reopen promise it can't keep", () => {
  for (const f of FILES) {
    it(f, () => {
      const s = src(f);
      for (const p of PROMISES) expect(s, `${f}: ${p}`).not.toMatch(p);
    });
  }
});
