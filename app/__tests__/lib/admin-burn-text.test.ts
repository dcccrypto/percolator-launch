import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_BURN_COPY as fromText } from "@/lib/admin-burn-text";
import { ADMIN_BURN_COPY as fromCopy } from "@/lib/admin-burn-copy";
import { tokenUsdOfLotUsd as fromDisplay } from "@/lib/v22/lot-display";
import { tokenUsdOfLotUsd as fromLot } from "@/lib/v22/lot";

describe("home page keeps the SDK out of its first load", () => {
  it("admin-burn-copy re-exports the same copy object", () => {
    expect(fromCopy).toBe(fromText);
    expect(fromText.chipBurned).toBe("Creator key burned");
    expect(fromText.chipActive).toBe("Creator key held");
    expect(fromText.landing).toBe(
      "Creators can give up their admin key for good after launch. Then the creator can no longer claim creator fees or reassign the market's price-feed, insurance and backing keys. Those keys, the market authority and the program's upgrade key are not affected.",
    );
  });

  it("lot.ts re-exports the same tokenUsdOfLotUsd", () => {
    expect(fromLot).toBe(fromDisplay);
    expect(fromDisplay(5, 0)).toBe(5);
    expect(fromDisplay(5, 2)).toBe(0.05);
  });

  it("the text-only modules import nothing", () => {
    for (const f of ["lib/admin-burn-text.ts", "lib/v22/lot-display.ts"]) {
      const src = readFileSync(resolve(__dirname, "../..", f), "utf8");
      expect(src).not.toMatch(/^\s*(import|export\s.*from)\s/m);
    }
  });
});
