/**
 * Per-market executors for the Move flow: close, withdraw, Earn request / collect, run IN PLACE.
 *
 * The signing builders already exist as hooks bound to a market (useClosePosition, useWithdraw,
 * useInsuranceLP inside a SlabProvider). This module is the pure layer on top: it resolves a
 * `MarketBridge` for the action's slab (the UI mounts a headless host for that market), checks the
 * guards, re-reads chain state right before sending, and calls the existing builders. It never
 * encodes an instruction itself, so tag 103/104 can never be produced here, and every builder it
 * calls simulates before it asks for a signature (close via the trade sim gate, withdraw and Earn
 * via sendTx pre-simulation). A refused simulation throws and stops the run.
 *
 * Rules (tested with negative controls):
 *  - the bridge must be for the action's own slab, and that slab's program must be the v1 wrapper;
 *  - close re-reads the portfolio and sends nothing when no leg is open (idempotent resume);
 *  - withdraw never runs with an open leg, re-reads capital, withdraws exactly what it read, and
 *    falls back to capital alone if the profit-conversion leg lost a race;
 *  - Earn: request when only shares are held, collect when a request is pending, never both blind:
 *    the amount is the fresh share count, 0 sends nothing.
 */
import { assertV1Program } from "./ids";
import type { Executors } from "./run";
import type { MoveAction } from "./plan";

export interface FreshPortfolio {
  capital: bigint;
  releasedPnl: bigint;
  openLegs: number;
  /** Index + account the existing withdraw builder needs. */
  userIdx: number;
}

export interface FreshEarn {
  /** LP shares in the wallet, not yet requested. */
  shares: bigint;
  /** Shares in a pending request. */
  pendingShares: bigint;
  /** The pending request's cooldown has elapsed. */
  cooldownElapsed: boolean;
}

export interface MarketBridge {
  slab: string;
  /** The market's owner program (from the provider), null until loaded. */
  programId: string | null;
  /** Hooks loaded (slab parsed, account known); executors wait on this. */
  ready: boolean;
  readPortfolio: () => Promise<FreshPortfolio | null>;
  readEarn: () => Promise<FreshEarn | null>;
  /** useClosePosition(100) with the background sweep off (the withdraw step owns it). */
  closeAll: () => Promise<string | null>;
  /** useWithdraw. */
  withdraw: (a: { userIdx: number; amount: bigint }) => Promise<string | null>;
  /** useInsuranceLP().withdraw: tag 76 when nothing is pending, 77 once the cooldown elapsed. */
  earn: (lpAmount: bigint) => Promise<{ step: "requested" | "executed"; signature: string }>;
}

export type BridgeFor = (slab: string) => Promise<MarketBridge>;

async function bridgeOf(bridgeFor: BridgeFor, slab: string): Promise<MarketBridge> {
  const b = await bridgeFor(slab);
  if (b.slab !== slab) throw new Error("Move: executor mounted for a different market");
  if (!b.ready || !b.programId) throw new Error("Move: market not loaded");
  assertV1Program(b.programId);
  return b;
}

export function makeMarketExecutors(bridgeFor: BridgeFor): Pick<Executors, "close" | "withdraw" | "earn-request" | "earn-execute"> {
  return {
    close: async (a: MoveAction) => {
      const b = await bridgeOf(bridgeFor, a.slab);
      const pf = await b.readPortfolio();
      if (!pf || pf.openLegs === 0) return null;
      return b.closeAll();
    },
    withdraw: async (a: MoveAction) => {
      const b = await bridgeOf(bridgeFor, a.slab);
      const pf = await b.readPortfolio();
      if (!pf) return null;
      if (pf.openLegs > 0) throw new Error("Move: close the position before withdrawing");
      const total = pf.capital + pf.releasedPnl;
      if (total <= 0n) return null;
      try {
        return await b.withdraw({ userIdx: pf.userIdx, amount: total });
      } catch (e) {
        if (pf.releasedPnl > 0n && pf.capital > 0n) return b.withdraw({ userIdx: pf.userIdx, amount: pf.capital });
        throw e;
      }
    },
    "earn-request": async (a: MoveAction) => {
      const b = await bridgeOf(bridgeFor, a.slab);
      const e = await b.readEarn();
      if (!e || e.pendingShares > 0n || e.shares <= 0n) return null;
      // A vault with no cooldown requests and pays in one sim-gated tx (step "executed"); both are fine.
      return (await b.earn(e.shares)).signature;
    },
    "earn-execute": async (a: MoveAction) => {
      const b = await bridgeOf(bridgeFor, a.slab);
      const e = await b.readEarn();
      if (!e || e.pendingShares <= 0n) return null;
      if (!e.cooldownElapsed) throw new Error("Move: the waiting period is not over");
      const r = await b.earn(e.pendingShares);
      return r.signature;
    },
  };
}
