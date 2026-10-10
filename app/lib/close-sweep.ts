/**
 * After a FULL close, move the freed collateral back to the wallet (live report 2026-10-01,
 * Squid: closing left the USDC "stuck" as a market deposit; the trade side already bundles
 * the deposit, so the close side should hand the money back).
 *
 * Why a separate transaction (a second approval) and not the close's own tx: Withdraw takes an
 * EXACT amount (wrapper handle_withdraw: `amount` must not exceed capital, the only "take all"
 * case is amount == capital at withdraw time), and the close's realised PnL is only known once it
 * lands. Guessing it inside the close tx either leaves dust or makes the CLOSE itself fail.
 * Reading the confirmed post-close capital and withdrawing exactly that cannot break the close:
 * if the withdraw is declined or fails, the position is still closed and the money is still
 * withdrawable as before.
 */
import { parsePortfolioV17 } from "@percolatorct/sdk";
import type { PublicKey } from "@solana/web3.js";
import { parsePortfolio } from "@/lib/v22/layout";

export interface SweepRead {
  /** Fresh (uncached) read of the wallet's portfolio on this market; null = none. */
  read: () => Promise<Uint8Array | null>;
  owner: PublicKey;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The collateral a just-closed portfolio can withdraw: its capital, once a fresh read shows NO
 * active leg (the RPC cache can serve the pre-close account for ~1-2 s). null = nothing to sweep
 * (no portfolio, not owned by the wallet, a leg still open after the retries, or capital 0).
 */
export async function readSweepableCapital(p: SweepRead): Promise<bigint | null> {
  const attempts = Math.max(1, p.attempts ?? 6);
  const sleep = p.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(p.delayMs ?? 1_000);
    let data: Uint8Array | null;
    try {
      data = await p.read();
    } catch {
      continue;
    }
    if (!data) return null;
    let pf;
    try {
      pf = parsePortfolio(data);
    } catch {
      return null;
    }
    if (!pf.owner.equals(p.owner)) return null;
    if (pf.legs.some((l) => l.active)) continue; // stale pre-close read, or another leg is open
    const cap = BigInt(pf.capital as unknown as bigint | number | string);
    return cap > 0n ? cap : null;
  }
  return null;
}

/** Calm one-liners for the sweep (UX: protocol mechanics stay invisible). */
export const SWEEP_COPY = {
  // useClosePosition already toasted "Position closed." for this close.
  prompt: (amount: string) => `Approve once more to move ${amount} back to your wallet.`,
  done: (amount: string) => `${amount} is back in your wallet.`,
  kept: (amount: string) => `${amount} stays on this market. You can withdraw it any time.`,
};
