/**
 * Assemble the P3 Earn tranche view from the limits read model: harvestable fees
 * from the slab (wrapper `lp_vault_harvestable_fee_atoms`), the vault LP's value
 * from its health certificate (wrapper `vault_lp_value_atoms`), and the vault state.
 * Pure; shared by the Earn rail (card + deposit gate) and the creator panel.
 */
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { earnTrancheView, harvestableFeeAtoms, vaultLpValueAtoms, type EarnDepositBlock, type EarnTrancheView, type VaultLpValue } from "./vault-tranche";
import { maxNowAtoms } from "./earn-withdraw";
import { earnP3Enabled } from "./flags";
import { earnSeniorPricing, type LagBoundsLp, type LagBoundsMarket } from "./earn-pricing";

export function earnViewFromLimits(
  limits: MarketLimits,
  backingNavAtoms: bigint,
  withdrawShares: bigint,
  /** Kept for call-site compatibility; pricing sides live in earnPanelPricing (earn-pricing.ts). */
  _side?: undefined,
  /** UX WP-5: the LP value from a simulated crank when the certificate is stale (never guessed). */
  simulatedLpValue?: VaultLpValue | null,
): EarnTrancheView | null {
  const vs = earnP3Enabled(limits.flags) ? limits.vaultState : null;
  const e = limits.engine;
  // The program prices against registry.total_lp_shares_outstanding (tags 75/77), never the
  // LP mint supply. Unread => no view (the gate then does not guess).
  const shares = limits.registryShares;
  if (!vs || !e || shares === null) return null;
  const direct: VaultLpValue = limits.lp ? vaultLpValueAtoms(limits.lp, e) : { kind: "stale" };
  const lpValue = direct.kind === "stale" && simulatedLpValue ? simulatedLpValue : direct;
  return earnTrancheView({
    seniorClaimAtoms: vs.seniorClaimAtoms,
    juniorFloorBps: vs.juniorFloorBps,
    seniorFeeShareBps: vs.seniorFeeShareBps,
    backingNavAtoms,
    harvestableAtoms: harvestableFeeAtoms(e),
    lpValue,
    totalShares: shares,
    withdrawShares,
  });
}

/** The share count the Earn gate uses: the registry's, exactly as the program. */
export const earnGateShares = (limits: MarketLimits): bigint | null => limits.registryShares;

/** The post-crank state a simulation returned (stale certificate): priced instead of the live one. */
export interface SimulatedEarnState {
  value: VaultLpValue;
  lp?: LagBoundsLp | null;
  market?: LagBoundsMarket | null;
}

/** The engine view as the lag-bounds market (single-asset P3: asset 0 carries eff / target). */
export function lagBoundsMarketFromEngine(e: {
  oracleEpoch: bigint;
  fundingEpoch: bigint;
  riskEpoch: bigint;
  assetSetEpoch: bigint;
  effectivePriceE6: bigint;
  targetPriceE6?: bigint;
}): LagBoundsMarket {
  return {
    oracleEpoch: e.oracleEpoch,
    fundingEpoch: e.fundingEpoch,
    riskEpoch: e.riskEpoch,
    assetSetEpoch: e.assetSetEpoch,
    priceOf: (a) => (a === 0 ? { eff: e.effectivePriceE6, tgt: e.targetPriceE6 ?? e.effectivePriceE6 } : null),
  };
}

/**
 * UX WP-4: the Earn panel's pricing, exactly as the program prices 75 / 77 (earnSeniorPricing,
 * the one port of the wrapper's worse-of rule): registry shares, the claim deposits are minted
 * against, the senior value redemptions are paid at, and what the vault can pay out now.
 * null = not a bound P3 vault.
 */
export function earnPanelPricing(
  limits: MarketLimits,
  backingNavAtoms: bigint,
  simulated?: SimulatedEarnState | VaultLpValue | null,
): { totalShares: bigint; depositSeniorValue: bigint | null; withdrawSeniorValue: bigint | null; maxNowAtoms: bigint | null } | null {
  if (!earnP3Enabled(limits.flags) || !limits.vaultLp?.bound || limits.registryShares === null || !limits.engine || !limits.vaultState) return null;
  const sim: SimulatedEarnState | null = simulated ? ("kind" in simulated ? { value: simulated } : simulated) : null;
  const view = earnViewFromLimits(limits, backingNavAtoms, 0n, undefined, sim?.value ?? null);
  if (!view) return null;
  const e = limits.engine;
  const directStale = !limits.lp || vaultLpValueAtoms(limits.lp, e).kind === "stale";
  const lp: LagBoundsLp | null = directStale ? sim?.lp ?? null : limits.lp ? { ...limits.lp, legs: limits.lp.legs ?? [] } : null;
  const market: LagBoundsMarket | null = directStale ? sim?.market ?? null : lagBoundsMarketFromEngine(e);
  const pr = earnSeniorPricing({
    resolved: e.mode === 1,
    cEff: view.seniorClaimEff,
    nav: view.backingCover,
    outstanding: limits.vaultState.seniorDrawOutstandingAtoms ?? 0n,
    lp,
    market,
    resolvedSenior: view.senior,
  });
  const lpAtoms = view.vaultValue !== null ? view.vaultValue - view.backingCover : null;
  const drawPending = (limits.vaultState.seniorDrawOutstandingAtoms ?? 0n) > 0n;
  return {
    totalShares: limits.registryShares,
    depositSeniorValue: pr.depositClaim,
    withdrawSeniorValue: pr.withdrawSeniorValue,
    maxNowAtoms: maxNowAtoms(view, lpAtoms, drawPending),
  };
}

/**
 * UX WP-5 (audit §3.6): the only real deposit pause is "covering a loss" (74). A pending-fee
 * genesis (84) and a stale valuation (85) are repaired inside the deposit tx (78 / crank bundled),
 * so they never disable the button.
 */
export function earnDepositPause(block: EarnDepositBlock | null): "senior-impaired" | null {
  return block === "senior-impaired" ? block : null;
}

/**
 * The panel pricing for ANY vault: the P3 pricing when the vault is bound, else (a two-pot vault)
 * the program's own registry shares and combined NAV, with the split-pot max-now (useInsuranceLP
 * `state.splitPot`). null only when neither is known (the panel then falls back to mint supply).
 */
export function withSplitPotPricing(
  p3: ReturnType<typeof earnPanelPricing>,
  splitPot: { totalShares: bigint; navAtoms: bigint; maxNowAtoms: bigint | null } | null,
): ReturnType<typeof earnPanelPricing> {
  if (p3) return p3;
  if (!splitPot) return null;
  return {
    totalShares: splitPot.totalShares,
    depositSeniorValue: splitPot.navAtoms,
    withdrawSeniorValue: splitPot.navAtoms,
    maxNowAtoms: splitPot.maxNowAtoms,
  };
}
