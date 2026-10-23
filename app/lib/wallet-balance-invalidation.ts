/**
 * "The connected wallet's token balance just changed" — sent by the faucets and the stake
 * deposit / withdraw hooks (useStake{Deposit,Withdraw}ByPool), read by /stake's Balance and the
 * components that gate on the wallet's collateral balance (DepositWithdrawCard's "Create
 * Account", OrderTicket's "Get Tokens to Trade"). Each of those reads the balance once in an
 * effect, and a faucet claim changed none of their deps, so a funded wallet kept reading 0
 * ("Get tokens first") until a reload.
 *
 * Same module-level pattern as lib/portfolio-invalidation.ts (which is for the on-chain
 * portfolio and triggers a full scan, so it is not reused here), with the same follow-up
 * offsets: /api/rpc caches getTokenAccountBalance for 1s, so an immediate re-read can return
 * the pre-claim balance.
 */
import { useEffect, useState } from "react";
import { PORTFOLIO_RECONCILE_MS } from "@/lib/portfolio-invalidation";

type Listener = () => void;

const listeners = new Set<Listener>();

/** Announce that the connected wallet's token balance changed. Safe with no subscribers. */
export function invalidateWalletBalance(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One broken widget must not stop the others from refreshing.
    }
  }
}

/**
 * A number that changes on every invalidateWalletBalance() and again at each follow-up offset.
 * Add it to the deps of the effect that reads the wallet balance.
 */
export function useWalletBalanceRefreshKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const bump = () => setKey((k) => k + 1);
    const listener: Listener = () => {
      bump();
      for (const ms of PORTFOLIO_RECONCILE_MS) timers.push(setTimeout(bump, ms));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      timers.forEach(clearTimeout);
    };
  }, []);
  return key;
}
