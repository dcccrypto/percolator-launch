/**
 * Trade-account pieces shared by the browser hook (hooks/useTrade.ts) and the server trade builder
 * (lib/v22/trade-build.ts). Moved out of the hook unchanged so both build the same instruction.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { resolveMarketLp } from "@/lib/market-lp";
import { assertCanonicalMatcher } from "@/lib/programAllowlist";

export interface V17TradeAccounts {
  accountA: PublicKey;
  accountB: PublicKey;
  matcherProg: PublicKey;
  matcherCtx: PublicKey;
  matcherDelegate: PublicKey;
}

/** The LP side of a trade (accountB + its matcher), without the taker (UX WP-6 first trade). */
export async function resolveLpTradeAccounts(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<Omit<V17TradeAccounts, "accountA">> {
  // accountB is the market's LP chosen by ON-CHAIN IDENTITY (lib/market-lp.ts): the bound
  // P3 vault LP, else the portfolio owned by asset 0's asset_admin, else the launch
  // portfolio; and its matcher ctx must be bound to it (ctx.lp_pda == the derived
  // delegate). NEVER "the first portfolio with an enabled matcher": anyone can enable a
  // matcher on their own portfolio and would become every user's counterparty.
  // Curated markets may pin the address in PLAYGROUND_SLAB_META (a cheap first try that
  // must still pass every rule).
  const known = PLAYGROUND_SLAB_META[slabPk.toBase58()]?.lp_portfolio_address;
  let knownPk: PublicKey | null = null;
  try {
    knownPk = known ? new PublicKey(known) : null;
  } catch {
    knownPk = null;
  }
  let lp;
  try {
    lp = await resolveMarketLp(connection, programId, slabPk, knownPk);
  } catch (scanErr) {
    throw new Error(
      `Failed to scan LP portfolio accounts on-chain: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
    );
  }
  if (!lp) {
    throw new Error(
      "No LP portfolio with an active matcher config found for this market. " +
      "The LP must call SetMatcherConfig before trading.",
    );
  }
  // SEC: matcherProg/matcherCtx come from the LP portfolio's on-chain matcher config —
  // attacker-controlled for an attacker-created market. The trade ix places matcherProg as
  // the executable CPI target [4] and matcherCtx as a writable account [5], so pin the
  // matcher to the canonical one before we build a signable tx around it. Runs on every
  // resolution, so cached values have passed this gate too.
  assertCanonicalMatcher(lp.matcherProg);
  return {
    accountB: lp.pubkey,
    matcherProg: lp.matcherProg,
    matcherCtx: lp.matcherCtx,
    // Bound to the ctx by resolveMarketLp (== deriveMatcherDelegate(..., lp.owner, ...)).
    matcherDelegate: lp.matcherDelegate,
  };
}

/**
 * Council GO1106: an order that only shrinks the taker's open asset-0 position (opposite sign, no larger than it).
 * Single-leg orders only; anything unknown is treated as NOT reducing (the old crank plan).
 */
export function isReducingOrder(beforeQ: bigint | null, size: bigint, legCount: number): boolean {
  if (beforeQ === null || beforeQ === 0n || size === 0n || legCount > 1) return false;
  if ((beforeQ > 0n) === (size > 0n)) return false;
  const absSize = size < 0n ? -size : size;
  const absBefore = beforeQ < 0n ? -beforeQ : beforeQ;
  return absSize <= absBefore;
}
