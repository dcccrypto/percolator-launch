/**
 * App bug 2026-10-29 (product review finding 3, R1): the Earn HUB (TVL, the table's "Your Value")
 * priced a BOUND vault at registry shares + distributed fees, so a loss never showed there either.
 * This reads what the vault page's limits read model reads (useMarketLimits: market engine view +
 * the asset's vault-LP record, the vault LP portfolio, the vault state and registry PDAs) plus the
 * backing pots (useInsuranceLP: bound_vault_nav), and prices it with the SAME function the withdraw
 * preview uses (earnPanelPricing -> earn-pricing.ts, the port of tags 75/77). A stale LP
 * certificate is valued by the same cached crank simulation the page runs (earn-valuation-sim). Batched: two chunked reads for every
 * vault the hub lists, not a round trip per vault.
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
import { vaultBackingNav, vaultPotLedgerKeys, vaultPotStateFromAccounts } from "./earn-split-pot";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";
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

/** Stale certificates simulated at once (each is one simulateTransaction, cached per market for a crank cycle). */
const SIM_CONCURRENCY = 4;

/**
 * Read + price MANY bound vaults in two batched reads (market + vault state + registry, then vault LP + both pot ledgers; chunked at
 * 100 keys) plus one cached crank simulation per vault whose LP certificate is stale. Keyed by market (base58); null = not bound,
 * unreadable or unpriceable. Never throws.
 */
export async function readBoundVaultPricings(
  connection: Connection,
  programId: PublicKey,
  markets: readonly PublicKey[],
): Promise<Map<string, EarnWithdrawPricing | null>> {
  const out = new Map<string, EarnWithdrawPricing | null>();
  for (const m of markets) out.set(m.toBase58(), null);
  if (markets.length === 0) return out;
  try {
    const first = await getMultipleAccountsInfoChunked(
      connection,
      markets.flatMap((m) => [m, deriveVaultLpStatePda(programId, m, VAULT_LP_STATE_SEED), deriveVaultLpStatePda(programId, m, LP_VAULT_REGISTRY_SEED)]),
    );
    type Row = { market: PublicKey; marketData: Uint8Array; registryData: Uint8Array; engine: MarketEngineView; vaultLp: AssetVaultLp; vaultState: VaultLpStateView; registryShares: bigint; lpKey: PublicKey; own: PublicKey; sib: PublicKey };
    const rows: Row[] = [];
    markets.forEach((market, i) => {
      const [m, vs, reg] = [first[3 * i], first[3 * i + 1], first[3 * i + 2]];
      if (!m || !vs || !reg || !m.owner.equals(programId) || !reg.owner.equals(programId)) return;
      const marketData = new Uint8Array(m.data);
      const registryData = new Uint8Array(reg.data);
      const engine = decodeMarketEngineView(marketData, 0);
      const vaultLp = decodeAssetVaultLp(marketData, 0);
      const vaultState = decodeVaultLpState(new Uint8Array(vs.data));
      const registryShares = decodeLpVaultRegistryShares(registryData);
      const keys = vaultPotLedgerKeys(programId, market, registryData);
      if (!engine || !vaultLp?.bound || !vaultState || registryShares === null || !keys?.bound) return;
      rows.push({ market, marketData, registryData, engine, vaultLp, vaultState, registryShares, lpKey: new PublicKey(vaultLp.vaultLpPortfolio), own: keys.ownLedger, sib: keys.sibLedger });
    });
    if (rows.length === 0) return out;
    const second = await getMultipleAccountsInfoChunked(connection, rows.flatMap((r) => [r.lpKey, r.own, r.sib]));
    const stale: { r: Row; parts: BoundVaultParts }[] = [];
    rows.forEach((r, j) => {
      const [lpInfo, lo, ls] = [second[3 * j], second[3 * j + 1], second[3 * j + 2]];
      if (!lpInfo) return;
      const lpData = new Uint8Array(lpInfo.data);
      const risk = decodePortfolioRisk(lpData);
      // A bound vault's NAV (bound_vault_nav) does not read the non-bound NAV floor.
      const pots = vaultPotStateFromAccounts(programId, r.market, r.registryData, r.marketData, lo?.data ?? null, ls?.data ?? null, false);
      const backingNavAtoms = pots?.bound ? vaultBackingNav(pots) : null;
      if (!risk || backingNavAtoms === null) return;
      const lp = { ...risk, address: r.lpKey, posQ: 0n, legs: decodePortfolioLegs(lpData) } as NonNullable<MarketLimits["lp"]>;
      const parts: BoundVaultParts = { engine: r.engine, vaultLp: r.vaultLp, lp, vaultState: r.vaultState, registryShares: r.registryShares, backingNavAtoms };
      if (vaultLpValueAtoms(lp, r.engine).kind === "stale") stale.push({ r, parts });
      else out.set(r.market.toBase58(), boundVaultPricingFromParts(parts));
    });
    for (let k = 0; k < stale.length; k += SIM_CONCURRENCY) {
      await Promise.all(
        stale.slice(k, k + SIM_CONCURRENCY).map(async ({ r, parts }) => {
          const payer = new PublicKey(r.vaultState.juniorOwner);
          const sim = await simulateVaultLpValue(
            { programId, market: r.market, vaultLp: r.lpKey, payer, oracleTail: crankOracleTail(pythCrankAccountFromMarket(r.marketData)) },
            connectionValuationDeps(connection, payer),
          );
          if (sim) out.set(r.market.toBase58(), boundVaultPricingFromParts(parts, sim));
        }),
      );
    }
  } catch {
    // A failed batch leaves every vault unpriced (null): the callers show it as unknown, never a guess.
  }
  return out;
}

/** One bound vault ({@link readBoundVaultPricings}). */
export async function readBoundVaultPricing(connection: Connection, programId: PublicKey, market: PublicKey): Promise<EarnWithdrawPricing | null> {
  return (await readBoundVaultPricings(connection, programId, [market])).get(market.toBase58()) ?? null;
}
