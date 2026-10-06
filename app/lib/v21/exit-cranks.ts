/**
 * Devnet v2.1, security review R3-M1 (P2b Earn allocation): a Live NON-BOUND Earn exit is priced on
 * E3, whose claim term can sit in a "touch-order dip" (a winner is registered, its loser is not yet
 * touched). A third party must not be able to choose WHEN someone else's exit executes, and the
 * redeemer should not exit inside a dip either. Mitigation (a), off-chain, same transaction: bundle
 * permissionless cranks of the market's positioned portfolios in front of tag 77, so the losers
 * are touched before the payout is priced. The redeemer now controls the timing.
 *
 * Rules, pinned by tests:
 *  - only positioned portfolios (`active_bitmap != 0`); losers (negative PnL) first; at most
 *    MAX_EXIT_CRANKS per transaction (the rest are the keeper's job);
 *  - sim-gated: the cranks are kept only when the whole transaction still simulates clean. If they
 *    would make the exit fail, the exit is sent without them exactly as it is today;
 *  - flag-gated by the caller (Devnet v2.1) and only for non-bound Live vaults.
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { buildVaultLpCrankIx } from "@/lib/limits/vault-lp-repair";
import { KIND_PORTFOLIO } from "@/lib/limits/constants";
import { decodePortfolioRisk } from "@/lib/limits/decode";

/** Cranks per exit transaction: each is ~100-150k CU against a 1.4M budget with the 77 itself. */
export const MAX_EXIT_CRANKS = 4;
/** Compute cap for an exit that carries cranks (the real limit is sized from the simulation). */
export const EXIT_CRANK_CU_CAP = 1_000_000;
/** Portfolio provenance market group offset (hooks/useTrade.ts, lib/limits/resolved-exit-load.ts). */
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;

export interface OpenPortfolio {
  key: PublicKey;
  pnl: bigint;
  activeBitmap: bigint;
}

/** Positioned portfolios, losers first (most negative PnL first), then by key; capped. */
export function pickCrankTargets(ps: readonly OpenPortfolio[], max = MAX_EXIT_CRANKS, exclude: readonly PublicKey[] = []): PublicKey[] {
  return ps
    .filter((p) => p.activeBitmap !== 0n && !exclude.some((e) => e.equals(p.key)))
    .sort((a, b) => (a.pnl < b.pnl ? -1 : a.pnl > b.pnl ? 1 : a.key.toBase58() < b.key.toBase58() ? -1 : 1))
    .slice(0, max)
    .map((p) => p.key);
}

export async function readOpenPortfolios(
  connection: Pick<Connection, "getProgramAccounts">,
  programId: PublicKey,
  market: PublicKey,
): Promise<OpenPortfolio[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: market.toBase58() } }],
  });
  const out: OpenPortfolio[] = [];
  for (const { pubkey, account } of accounts) {
    const d = new Uint8Array(account.data);
    if (d[10] !== KIND_PORTFOLIO) continue;
    const r = decodePortfolioRisk(d);
    if (r) out.push({ key: pubkey, pnl: r.pnl, activeBitmap: r.activeBitmap });
  }
  return out;
}

export function buildExitCrankIxs(p: {
  programId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  targets: readonly PublicKey[];
  oracleTail?: Parameters<typeof buildVaultLpCrankIx>[4];
}): TransactionInstruction[] {
  return p.targets.map((t) => buildVaultLpCrankIx(p.programId, p.cranker, p.market, t, p.oracleTail ?? []));
}

export interface ExitCrankDeps {
  read: () => Promise<OpenPortfolio[]>;
  /** Simulate a transaction body as the redeemer; `err` null = clean. */
  simulate: (ixs: TransactionInstruction[]) => Promise<{ err: unknown; rpcFailed: boolean }>;
}

/**
 * The cranks to put in front of `core` (the exit instructions), or [] when there is nothing to
 * touch, the read failed, or the cranks would make the exit fail (then the exit goes out as today).
 */
export async function planExitCranks(
  deps: ExitCrankDeps,
  p: { programId: PublicKey; cranker: PublicKey; market: PublicKey; core: TransactionInstruction[]; oracleTail?: Parameters<typeof buildVaultLpCrankIx>[4]; exclude?: readonly PublicKey[] },
): Promise<TransactionInstruction[]> {
  try {
    const targets = pickCrankTargets(await deps.read(), MAX_EXIT_CRANKS, p.exclude ?? []);
    if (targets.length === 0) return [];
    const cranks = buildExitCrankIxs({ programId: p.programId, cranker: p.cranker, market: p.market, targets, oracleTail: p.oracleTail });
    const sim = await deps.simulate([...cranks, ...p.core]);
    if (sim.rpcFailed || sim.err) return [];
    return cranks;
  } catch {
    return [];
  }
}
