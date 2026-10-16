/**
 * Pure planner for the v2.2 Earn exit: which stale portfolios to refresh inline, the plan (SDK `planEarnExitV22`),
 * and the one-line quote ("You'll receive at least $X").
 */
import type { PublicKey } from "@solana/web3.js";
import {
  planEarnExitV22,
  defaultMinPayoutV22,
  type EarnExitPlanInputV22,
  type EarnExitPlanV22,
  type MarketV22,
  type RefreshCandidateV22,
} from "./sdk";
import { parsePortfolio } from "./layout";
import { V22_COPY } from "./copy";

export interface ExitContext {
  market: MarketV22;
  redeemer: PublicKey;
  redeemerLpAta: PublicKey;
  redeemerDest: PublicKey;
  vaultToken: PublicKey;
  sourceDomain: number;
  shares: bigint;
  /** Bound vault: no inline refresh (the vault LP portfolio rides in the tail). */
  boundLpPortfolio?: PublicKey;
  oracleAccounts?: readonly PublicKey[];
  keeperOk?: boolean;
}

export function buildExitPlan(ctx: ExitContext, stale: readonly RefreshCandidateV22[]): EarnExitPlanV22 {
  const i: EarnExitPlanInputV22 = {
    market: ctx.market,
    cranker: ctx.redeemer,
    redeemer: ctx.redeemer,
    redeemerLpAta: ctx.redeemerLpAta,
    redeemerDest: ctx.redeemerDest,
    vaultToken: ctx.vaultToken,
    sourceDomain: ctx.sourceDomain,
    shares: ctx.shares,
    staleCandidates: stale,
    oracleAccounts: ctx.oracleAccounts,
    boundLpPortfolio: ctx.boundLpPortfolio,
    keeperOk: ctx.keeperOk,
  };
  return planEarnExitV22(i);
}

/**
 * Stale positioned portfolios of ONE market, from raw `getProgramAccounts` rows, in priority order
 * (liquidation-pending first, then most active legs, then key). Decoded by the account's VERSION; a row that
 * is not a decodable portfolio of this market is skipped (never guessed).
 */
export function staleCandidatesFromAccounts(rows: readonly { pubkey: PublicKey; data: Uint8Array }[], market: PublicKey): RefreshCandidateV22[] {
  const out: { key: PublicKey; legs: number; liq: boolean }[] = [];
  for (const r of rows) {
    let pf: ReturnType<typeof parsePortfolio>;
    try {
      pf = parsePortfolio(r.data);
    } catch {
      continue;
    }
    if (!pf.marketGroupId.equals(market)) continue;
    const active = pf.legs.filter((l) => l.active);
    if (active.length === 0) continue;
    if (!active.some((l) => l.stale || l.bStale)) continue;
    out.push({ key: r.pubkey, legs: active.length, liq: active.some((l) => l.bandLiqPending === true) });
  }
  out.sort((a, b) => (a.liq !== b.liq ? (a.liq ? -1 : 1) : a.legs !== b.legs ? b.legs - a.legs : a.key.toBase58() < b.key.toBase58() ? -1 : 1));
  return out.map(({ key, legs }) => ({ key, legs }));
}

/** The floor for a quote (quote minus at most 5 bps) exactly as `plan.finalize` computes it. */
export const floorFor = (quote: bigint, slippageBps = 5): bigint => defaultMinPayoutV22(quote, slippageBps);

/** "$1,234.56" style amount for a collateral amount in atoms (floored to cents of the token). */
export function formatAtoms(atoms: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const cents = (atoms * 100n) / d;
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export const quoteLine = (minPayout: bigint, decimals: number, symbol: string): string =>
  V22_COPY.earnExit.atLeast(`${formatAtoms(minPayout, decimals)} ${symbol}`);

/** The dip note shows only while positions still need refreshing (the book is not loss-current). */
export const showDipNote = (staleCount: number): boolean => staleCount > 0;

