/**
 * The growth view of a market from what is already read (market bytes + the LP's decoded portfolio).
 * Moved verbatim out of hooks/useMarketLimits.ts (a "use client" module) so server code (the bot API quote) can use it;
 * the hook re-exports it, behaviour unchanged.
 */
import type { PublicKey } from "@solana/web3.js";
import type { AssetVaultLp, MarketEngineView, PortfolioRiskView } from "@/lib/limits/decode";
import { growthMarketView, GROWTH_DEPTH_RULES_DEPLOYED, growthControllerInputs, type GrowthMarketView } from "@/lib/v21/growth-market";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import type { LevGuardV22 } from "@/lib/v22/sdk";
import { getConfig } from "@/lib/config";

/** The LP's portfolio as the growth view needs it (the hook's `LpView` is a superset). */
export interface GrowthLpView extends PortfolioRiskView {
  address: PublicKey;
  posQ: bigint;
}

export function growthFor(
  slabPart: { engine: MarketEngineView | null; vaultLp: AssetVaultLp | null } | null,
  accPart: { lp: GrowthLpView | null; guard?: { account: LevGuardV22 | null } | null } | null,
  lpRealQ: bigint | null,
  raw: Uint8Array | null,
  assetIndex: number,
  nowSlot: bigint | null,
): GrowthMarketView | null {
  const engine = slabPart?.engine;
  const lp = accPart?.lp;
  if (!engine || !lp || !raw) return null;
  const vault = slabPart?.vaultLp;
  const lpKey = lp.address.toBytes();
  const bound =
    !!vault?.bound && vault.vaultLpPortfolio.length === lpKey.length && lpKey.every((b, k) => b === vault.vaultLpPortfolio[k]);
  return growthMarketView({
    raw,
    assetIndex,
    engine,
    lp: { capital: lp.capital, pnl: lp.pnl, feeCredits: lp.feeCredits },
    lpEffectiveQ: lpRealQ,
    bound,
    // v2.2 depth rules (lambda_eff, kappa cap, stored ratchet) where the DEPLOYED wrapper applies them (6kpg2wi7 since the 10-15
    // growth-tier upgrade, GROWTH_DEPTH_RULES_DEPLOYED): the ticket's room, fee and leverage must be the numbers the program computes
    // for the clip and the gate (QA LEV-8). Unknown clock = conservative reading.
    // Controller round + continuous leverage (wrapper 21b8ccfd, contlev3): the stress inputs and the volatility config come from the same bytes.
    ...(isDevnetV22Enabled() && GROWTH_DEPTH_RULES_DEPLOYED ? { v22: { ...growthControllerInputs(raw, assetIndex, engine), nowSlot } } : {}),
    // App bug 2026-10-29: the leverage guard, read with the LP every poll (v2.2 only).
    ...(accPart?.guard ? { guard: { account: accPart.guard.account, mainnet: getConfig().network === "mainnet" } } : {}),
  });
}
