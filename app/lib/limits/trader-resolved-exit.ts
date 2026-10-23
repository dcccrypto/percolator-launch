/**
 * A trader's own exit from a RESOLVED market (AUD-FC-A2): CloseResolved (30) until the portfolio is empty, the 46 top-up while a payout
 * receipt is open, then ClosePortfolio (8), in ONE wallet approval.
 *
 * The program chunks the terminal close: a portfolio can need several CloseResolved txs (the E2E pass measured up to ~12 per trader),
 * and a winner is partial until the losing side has paid in. So the list pre-signs COPIES of the repeatable steps (each tx has its own
 * compute-unit price, hence its own signature) and the driver re-reads the portfolio before every broadcast, skipping any copy that is
 * no longer needed. Unneeded copies are never broadcast. Same technique as "Finish now" (lib/limits/resolved-finish.ts), but scoped to
 * the connected wallet and OWNER-SIGNED, so it also works inside the owner-only window (before resolved_slot + force_close_delay_slots),
 * where the permissionless form that the Earn sweep uses is refused.
 *
 * Pure planning + an injected driver (no RPC here).
 */
import type { ResolvedPortfolioView } from "./decode";
import { looksEmpty } from "./resolved-exit";
import type { OwnPortfolio } from "./own-portfolio-cleanup";

/** Copies of the repeatable CloseResolved step per portfolio (E2E: up to ~12 chunks). */
export const TRADER_CLOSE_COPIES = 12;
/** Copies of the 46 top-up per portfolio (it repeats while the receipt is open and the other side settles). */
export const TRADER_TOPUP_COPIES = 2;
/** After the top-ups: a close that was progress-only again, then one more top-up (a receipt opened or stayed diluted meanwhile). */
export const TRADER_TAIL_CLOSE_COPIES = 2;
export const TRADER_TAIL_TOPUP_COPIES = 1;
/** One blockhash lives ~60-90 s and each broadcast is confirmed before the next: never ask the wallet to sign more than this. */
export const TRADER_EXIT_MAX_TXS = 24;
/** Budgets per tx (lib/limits/resolved-exit.ts EXIT_STEP_CU: CloseResolved up to ~301k measured, ClosePortfolio ~122k). */
export const TRADER_ITEM_CU = { "close-resolved": 380_000, "claim-topup": 380_000, "close-empty": 180_000 } as const;

export type TraderExitKind = "close-resolved" | "claim-topup" | "close-empty";

export interface TraderExitItem {
  kind: TraderExitKind;
  /** base58 portfolio key. */
  portfolio: string;
  /** 0-based copy index (0 for single steps). */
  copy: number;
}

const receiptOpen = (v: ResolvedPortfolioView): boolean => v.receiptPresent && !v.receiptFinalized;

/**
 * The pre-signed list for the wallet's own portfolios, in the program's order, per portfolio:
 * `30 x N` (while the receipt is closed), `46 x M` (while a receipt is open), `30 x 2` and `46 x 1` again (a receipt that opened or
 * stayed diluted mid-run), then `8`. An already-empty portfolio only needs the `8`.
 * Portfolios mid-liquidation / rebalance cannot be closed by anyone: skipped here (the caller reports them).
 */
export function traderExitItems(own: readonly OwnPortfolio[]): TraderExitItem[] {
  const live = own.filter((p) => !p.view.rebalanceLock && !p.view.liquidationLock);
  const out: TraderExitItem[] = [];
  const perPortfolio = Math.max(3, Math.floor(TRADER_EXIT_MAX_TXS / Math.max(1, live.length)));
  const tail = TRADER_TOPUP_COPIES + TRADER_TAIL_CLOSE_COPIES + TRADER_TAIL_TOPUP_COPIES + 1;
  const closeCopies = Math.max(1, Math.min(TRADER_CLOSE_COPIES, perPortfolio - tail));
  for (const p of live) {
    const key = p.key.toBase58();
    if (!looksEmpty(p.view)) {
      for (let c = 0; c < closeCopies; c++) out.push({ kind: "close-resolved", portfolio: key, copy: c });
      for (let c = 0; c < TRADER_TOPUP_COPIES; c++) out.push({ kind: "claim-topup", portfolio: key, copy: c });
      for (let c = 0; c < TRADER_TAIL_CLOSE_COPIES; c++) out.push({ kind: "close-resolved", portfolio: key, copy: closeCopies + c });
      for (let c = 0; c < TRADER_TAIL_TOPUP_COPIES; c++) out.push({ kind: "claim-topup", portfolio: key, copy: TRADER_TOPUP_COPIES + c });
    }
    out.push({ kind: "close-empty", portfolio: key, copy: 0 });
  }
  return out.slice(0, TRADER_EXIT_MAX_TXS);
}

/** Is this item still needed, given the portfolio's CURRENT state (null = the account is gone: nothing left to do)? */
export function traderItemNeeded(item: TraderExitItem, now: ResolvedPortfolioView | null): boolean {
  if (!now) return false;
  switch (item.kind) {
    case "close-resolved":
      return !looksEmpty(now) && !receiptOpen(now);
    case "claim-topup":
      return receiptOpen(now);
    case "close-empty":
      return looksEmpty(now);
  }
}

export interface TraderExitDeps<Tx> {
  /** Current state of the wallet's portfolios by key; a closed portfolio is absent or null. */
  read: () => Promise<ReadonlyMap<string, ResolvedPortfolioView | null>>;
  broadcast: (tx: Tx) => Promise<string>;
}

export interface TraderExitRun {
  broadcast: number;
  skipped: number;
  failed: number;
  signatures: string[];
  /** The pre-signed list stopped being usable (its blockhash expired). */
  stale: boolean;
  /** Portfolios of the wallet that are not closed after the run. */
  remaining: string[];
}

/**
 * Broadcast the pre-signed list in order, re-reading before each item and skipping what is not needed. A failed copy does not stop the
 * later steps; an expired blockhash stops the run (run it again: it plans from the new state).
 */
export async function runTraderExit<Tx>(items: readonly { item: TraderExitItem; tx: Tx }[], d: TraderExitDeps<Tx>): Promise<TraderExitRun> {
  const signatures: string[] = [];
  let skipped = 0;
  let failed = 0;
  let stale = false;
  let state = await d.read();
  for (const { item, tx } of items) {
    if (!traderItemNeeded(item, state.get(item.portfolio) ?? null)) {
      skipped++;
      continue;
    }
    try {
      signatures.push(await d.broadcast(tx));
    } catch (e) {
      failed++;
      if (/blockhash not found|block height exceeded|expired/i.test(e instanceof Error ? e.message : String(e))) {
        stale = true;
        break;
      }
    }
    state = await d.read();
  }
  if (stale || signatures.length > 0) state = await d.read();
  const remaining = items
    .map((i) => i.item.portfolio)
    .filter((k, n, all) => all.indexOf(k) === n)
    .filter((k) => state.get(k) != null);
  return { broadcast: signatures.length, skipped, failed, signatures, stale, remaining };
}
