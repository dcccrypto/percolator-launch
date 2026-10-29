/**
 * App bug 2026-10-29 (product review finding 3, R1): the Earn HUB (TVL, the table's "Your Value")
 * priced a BOUND vault at registry shares + distributed fees, so a loss never showed there either.
 * This reads what the vault page's limits read model reads (useMarketLimits: market engine view +
 * the asset's vault-LP record, the vault LP portfolio, the vault state and registry PDAs) plus the
 * backing pots (useInsuranceLP: bound_vault_nav), and prices it with the SAME function the withdraw
 * preview uses (earnPanelPricing -> earn-pricing.ts, the port of tags 75/77). A stale LP
 * certificate is valued by the same cached crank simulation the page runs (earn-valuation-sim).
 * Anything unreadable => null (the hub shows the vault as unvalued, never the proxy).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { parseAssetOracleProfileV17, parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { isWrapperAccount, marketGeometry } from "@/lib/v22/layout";
import {
  decodeAssetVaultLp,
  decodeLpVaultRegistryShares,
  decodeMarketEngineView,
  decodePortfolioLegs,
  decodePortfolioRisk,
  decodeVaultLpState,
  type AssetVaultLp,
  type MarketEngineView,
  type VaultLpStateView,
} from "./decode";
import { earnPanelPricing } from "./earn";
import type { EarnWithdrawPricing } from "./earn-display";
import { readVaultPotState, vaultBackingNav } from "./earn-split-pot";
import { connectionValuationDeps, simulateVaultLpValue, type SimulatedValue } from "./earn-valuation-sim";
import { limitsFlags } from "./flags";
import { deriveVaultLpStatePda } from "./lp-discovery";
import { LP_VAULT_REGISTRY_SEED, VAULT_LP_STATE_SEED } from "./constants";
import { pythCrankAccount } from "./oracle-tail";
import { crankOracleTail } from "./vault-lp-repair";
import { vaultLpValueAtoms } from "./vault-tranche";

const ZERO = new PublicKey(new Uint8Array(32));

/** The decoded parts a bound vault is priced from (single-asset P3 market: asset 0). */
export interface BoundVaultParts {
  engine: MarketEngineView;
  vaultLp: AssetVaultLp;
  lp: NonNullable<MarketLimits["lp"]>;
  vaultState: VaultLpStateView;
  registryShares: bigint;
  /** bound_vault_nav over both pots. */
  backingNavAtoms: bigint;
}

/** Pure: the withdraw pricing of a bound vault from its parts (+ the post-crank state when stale). */
export function boundVaultPricingFromParts(p: BoundVaultParts, sim: SimulatedValue | null = null): EarnWithdrawPricing | null {
  const limits = {
    state: "ready",
    flags: limitsFlags(),
    engine: p.engine,
    vaultLp: p.vaultLp,
    lp: p.lp,
    vaultState: p.vaultState,
    registryShares: p.registryShares,
  } as unknown as MarketLimits;
  const pr = earnPanelPricing(limits, p.backingNavAtoms, sim);
  return pr ? { totalShares: pr.totalShares, withdrawSeniorValue: pr.withdrawSeniorValue } : null;
}

/** The crank's Pyth tail from the market account itself (SlabProvider's oracle shim, no hook). */
export function pythCrankAccountFromMarket(data: Uint8Array): PublicKey | null {
  try {
    if (!isWrapperAccount(data)) return null;
    const w = parseWrapperConfigV17(data, V17_HEADER_LEN);
    const ap = parseAssetOracleProfileV17(data, marketGeometry(data, "earn-bound-pricing").slotsBase);
    const indexFeedId = w.oracleMode !== 0 ? ZERO : ap.oracleLegFeeds[0] ?? ZERO;
    return pythCrankAccount({ oracleAuthority: ap.oracleAuthority, indexFeedId }, w.oracleMode);
  } catch {
    return null;
  }
}

/** Read + price one bound vault. null = not bound, unreadable or unpriceable. Never throws. */
export async function readBoundVaultPricing(connection: Connection, programId: PublicKey, market: PublicKey): Promise<EarnWithdrawPricing | null> {
  try {
    const vaultPda = deriveVaultLpStatePda(programId, market, VAULT_LP_STATE_SEED);
    const registryPda = deriveVaultLpStatePda(programId, market, LP_VAULT_REGISTRY_SEED);
    const [m, vs, reg] = await connection.getMultipleAccountsInfo([market, vaultPda, registryPda], "confirmed");
    if (!m || !vs || !reg || !m.owner.equals(programId)) return null;
    const marketData = new Uint8Array(m.data);
    const engine = decodeMarketEngineView(marketData, 0);
    const vaultLp = decodeAssetVaultLp(marketData, 0);
    const vaultState = decodeVaultLpState(new Uint8Array(vs.data));
    const registryShares = decodeLpVaultRegistryShares(new Uint8Array(reg.data));
    if (!engine || !vaultLp?.bound || !vaultState || registryShares === null) return null;
    const lpKey = new PublicKey(vaultLp.vaultLpPortfolio);
    const [lpInfo, pots] = await Promise.all([connection.getAccountInfo(lpKey, "confirmed"), readVaultPotState(connection, programId, market)]);
    if (!lpInfo || !pots?.bound) return null;
    const lpData = new Uint8Array(lpInfo.data);
    const risk = decodePortfolioRisk(lpData);
    const backingNavAtoms = vaultBackingNav(pots);
    if (!risk || backingNavAtoms === null) return null;
    const lp = { ...risk, address: lpKey, posQ: 0n, legs: decodePortfolioLegs(lpData) } as NonNullable<MarketLimits["lp"]>;
    const parts: BoundVaultParts = { engine, vaultLp, lp, vaultState, registryShares, backingNavAtoms };
    let sim: SimulatedValue | null = null;
    if (vaultLpValueAtoms(lp, engine).kind === "stale") {
      const payer = new PublicKey(vaultState.juniorOwner);
      sim = await simulateVaultLpValue(
        { programId, market, vaultLp: lpKey, payer, oracleTail: crankOracleTail(pythCrankAccountFromMarket(marketData)) },
        connectionValuationDeps(connection, payer),
      );
      if (!sim) return null;
    }
    return boundVaultPricingFromParts(parts, sim);
  } catch {
    return null;
  }
}
