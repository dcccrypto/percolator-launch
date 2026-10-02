/**
 * GH#2882: "Paused (lp-depleted)" read "no liquidity for new positions", and the ticket promised the
 * market would recover. What refills a depleted counterparty depends on the market: a bound P3
 * vault LP is funded from its Earn vault; any other market only by a deposit into its own
 * counterparty, which Earn and staking deposits never reach. decodeMarketHealth carries that as
 * lpIsVault, read from asset 0's P3 record inside the slice /api/markets/health fetches.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { ASSET_VAULT_LP_FIELD_OFF_P3, ASSET_VAULT_LP_FLAG_BOUND_P3, assetVaultLpAccountOffsetP3 } from "@percolatorct/sdk";
import { decodeMarketHealth, healthBadges, MARKET_HEALTH_SLICE_LEN } from "@/lib/market-health";

const SLOT = 505_580_400n;
const real = () =>
  new Uint8Array(Buffer.from(readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", "collect-market-v18-lapsed.b64"), "utf8").trim(), "base64"));

// A valid bound record: the bound flag AND a vault-LP portfolio key (the SDK, like the program,
// rejects one without the other).
function bound(): Uint8Array {
  const d = real();
  const off = assetVaultLpAccountOffsetP3(0);
  d.set(new PublicKey("HbzHDZP4kC1qfYuR1bngzrVbKZJoq4nnMbMaSdjSvqv7").toBytes(), off + ASSET_VAULT_LP_FIELD_OFF_P3.vaultLpPortfolio);
  d[off + ASSET_VAULT_LP_FIELD_OFF_P3.flags] = ASSET_VAULT_LP_FLAG_BOUND_P3;
  return d;
}

const depletedDetail = (data: Uint8Array) =>
  healthBadges(decodeMarketHealth(data.slice(0, MARKET_HEALTH_SLICE_LEN), SLOT, 0n)).find((b) => b.id === "lp-depleted")?.detail;

describe("decodeMarketHealth.lpIsVault", () => {
  it("the P3 record is inside the health slice", () => {
    expect(assetVaultLpAccountOffsetP3(0) + 128).toBeLessThanOrEqual(MARKET_HEALTH_SLICE_LEN);
  });

  it("false on an unbound market, true once asset 0 is bound (read from the slice alone)", () => {
    expect(decodeMarketHealth(real().slice(0, MARKET_HEALTH_SLICE_LEN), SLOT, 0n).lpIsVault).toBe(false);
    expect(decodeMarketHealth(bound().slice(0, MARKET_HEALTH_SLICE_LEN), SLOT, 0n).lpIsVault).toBe(true);
  });

  it("the depleted badge says what refills it, by market type, and promises nothing else", () => {
    expect(depletedDetail(real())).toBe(
      "The market has no funds left to take the other side of new trades. Opening resumes once it is funded again; deposits to Earn or staking don't reopen it. Closing works normally.",
    );
    expect(depletedDetail(bound())).toBe(
      "The market has no funds left to take the other side of new trades. Opening resumes when the Earn vault has funds to back them. Closing works normally.",
    );
  });
});
