/**
 * Raydium is withheld from new market creation (2026-07-29).
 *
 * WHY: the keeper cannot yet publish a correct USD price for a Raydium CLMM
 * pool paired against SOL. Raydium orders its mints by PUBKEY and prices
 * "mint1 per mint0", so WSOL lands on either side depending on the other
 * token's address — one orientation needs a multiply by SOL/USD, the other an
 * invert. A wrong price does not just mis-draw the chart: the opening price
 * permanently sizes the LP trade caps written once at market creation, which
 * is exactly how market 5sDvEs2… ended up with a $9.57 per-trade cap.
 *
 * These tests pin the blocklist so it cannot be silently widened or dropped.
 */
import { describe, it, expect } from "vitest";
import { SUPPORTED_DEX_IDS, BLOCKED_DEX_IDS } from "@/lib/dex-constants";
import { normalizeDexType } from "@/lib/dex-type";

describe("DEX blocklist", () => {
  it("does not offer raydium for new markets", () => {
    expect(SUPPORTED_DEX_IDS.has("raydium")).toBe(false);
  });

  it("still offers the DEXes the keeper prices correctly", () => {
    expect(SUPPORTED_DEX_IDS.has("pumpswap")).toBe(true);
    expect(SUPPORTED_DEX_IDS.has("meteora")).toBe(true);
  });

  it("carries a creator-facing reason for every blocked DEX", () => {
    for (const [dexId, reason] of Object.entries(BLOCKED_DEX_IDS)) {
      expect(SUPPORTED_DEX_IDS.has(dexId)).toBe(false); // never both
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("explains raydium specifically, so the wizard never shows a bare 'no price'", () => {
    expect(BLOCKED_DEX_IDS.raydium).toBeDefined();
    expect(BLOCKED_DEX_IDS.raydium.toLowerCase()).toContain("raydium");
  });

  it("still normalizes raydium aliases — the block is a policy, not a parser gap", () => {
    // The route must be able to RECOGNISE a raydium pool in order to reject it,
    // so normalizeDexType must keep mapping these rather than returning null.
    expect(normalizeDexType("raydium")).toBe("raydium-clmm");
    expect(normalizeDexType("raydium-clmm")).toBe("raydium-clmm");
    expect(normalizeDexType("raydium-amm")).toBe("raydium-clmm");
  });
});
