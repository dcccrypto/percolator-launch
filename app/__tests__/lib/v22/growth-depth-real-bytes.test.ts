/**
 * GROWTH_DEPTH_RULES_DEPLOYED, pinned to REAL devnet account bytes (read 2026-10-17, slot 512136545, via api.devnet.solana.com):
 * the v2.2 tiered markets CHILLHOUSE-T 56pWj8zY… and swordcat-T 7fU9teqR… and their bound vault-LP portfolios (8XAMk6h8…, 79yz8cdk…).
 *
 * Both are at tier 0 (stored keeper-attested depth ~$1.8k / ~$0.9k, below the $25k first threshold) with C_m ~ 1,003 collateral
 * tokens. The deployed wrapper (aca02ba6 = c659c91d; `growth_v19::n_cap_g8_q`) caps N_cap at `min(n_cap_q(C_m, lambda_eff), kappa * depth / P)`,
 * kappa 0.5 at tier 0; the plain growth-1 formula the ticket used while the flag was false is ~9,000x larger on these two markets.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeAssetVaultLp, decodeMarketEngineView, decodePortfolioLegs, decodePortfolioRisk } from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { growthFor } from "@/hooks/useMarketLimits";
import { GROWTH_DEPTH_RULES_DEPLOYED, growthMarketView, type GrowthMarketView } from "@/lib/v21/growth-market";
import { readBandRentView } from "@/lib/v22/band-rent-state";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const DIR = path.join(__dirname, "../../fixtures/v22-growth");
const load = (n: string): Uint8Array => new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(DIR, n), "utf8")) as { data: string }).data, "base64"));
const SLOT = 512_136_545n;

// Set at load: the fixtures are decoded while the describe blocks are collected.
__setDevnetV22ForTest(true);
afterAll(() => __setDevnetV22ForTest(null));

function inputs(name: string) {
  const raw = load(`${name}.market.json`);
  const lpBytes = load(`${name}.lp.json`);
  const engine = decodeMarketEngineView(raw, 0);
  const risk = decodePortfolioRisk(lpBytes);
  const vaultLp = decodeAssetVaultLp(raw, 0);
  if (!engine || !risk) throw new Error("fixture does not decode");
  const lpQ = lpEffectiveSignedQ(lpBytes, engine, 0, engine.marketId);
  const lp = { ...risk, address: new PublicKey(vaultLp?.vaultLpPortfolio ?? new Uint8Array(32)), posQ: 0n, legs: decodePortfolioLegs(lpBytes) };
  return { raw, lpBytes, engine, risk, vaultLp, lpQ, lp };
}

const MARKETS = [
  // nCapQ = the on-chain cap in engine Q: floor(kappa(0) 0.5 * capDepth * POS_SCALE / price); legacy = floor(C_m * 1x * POS_SCALE / price)
  { name: "chillhouse-t", capDepthE6: 224_577n, nCapQ: 10_250n, legacyNCapQ: 91_564_083n },
  { name: "swordcat-t", capDepthE6: 109_409n, nCapQ: 2_915n, legacyNCapQ: 53_467_398n },
] as const;

describe("GROWTH_DEPTH_RULES_DEPLOYED against the deployed wrapper's tiered markets", () => {
  it("is on: the growth-tier commits are in the deployed build", () => {
    expect(GROWTH_DEPTH_RULES_DEPLOYED).toBe(true);
  });

  for (const m of MARKETS) {
    describe(m.name, () => {
      const i = inputs(m.name);
      const hookView = (): GrowthMarketView => {
        const v = growthFor({ engine: i.engine, vaultLp: i.vaultLp }, { lp: i.lp }, i.lpQ, i.raw, 0, SLOT);
        if (!v) throw new Error("no growth view");
        return v;
      };

      it("the market is bound, tier 0, flat, 5x launch ceiling", () => {
        const v = hookView();
        expect(i.vaultLp?.bound).toBe(true);
        expect(v.record.attestedMaxTier).toBe(3);
        expect(v.long.tier).toBe(0);
        expect(v.long.ceilingX100).toBe(500);
        expect(v.long.maxLeverageX100).toBe(500);
        expect(v.long.utilizationBps).toBe(0n);
      });

      it("the hook's quote applies the depth cap: room is the program's kappa*depth/P, not C_m*lambda/P", () => {
        const v = hookView();
        for (const q of [v.long, v.short]) {
          expect(q.capDepthE6).toBe(m.capDepthE6);
          expect(q.nCapQ).toBe(m.nCapQ);
          expect(q.headroomQ).toBe(m.nCapQ);
        }
      });

      it("the growth-1 quote (what the flag-off app promised) is far larger than the program allows", () => {
        const legacy = growthMarketView({ raw: i.raw, assetIndex: 0, engine: i.engine, lp: i.risk, lpEffectiveQ: i.lpQ, bound: true });
        expect(legacy?.long.nCapQ).toBe(m.legacyNCapQ);
        expect(legacy!.long.nCapQ! / hookView().long.nCapQ!).toBeGreaterThan(1_000n);
      });

      it("with the cluster clock unknown the hook's view is null: nothing is quoted (the stale depth would otherwise read as fresh)", () => {
        expect(growthFor({ engine: i.engine, vaultLp: i.vaultLp }, { lp: i.lp }, i.lpQ, i.raw, 0, null)).toBeNull();
      });

      it("the band comes from the account (the hook reads it the same way)", () => {
        expect(readBandRentView(i.raw, 0)?.band.bandBps).toBeGreaterThan(0);
      });
    });
  }
});
