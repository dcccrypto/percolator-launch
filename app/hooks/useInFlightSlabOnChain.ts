"use client";

import { useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { loadLastInFlightMarket, type InFlightMarketState } from "@/lib/inFlightMarket";

/** While the account is not seen, look again this often (a step-0 tx that timed out client-side may still land). */
export const IN_FLIGHT_RECHECK_MS = 15_000;

/**
 * Does the in-flight market's account (the one the recovery JSON exports) exist on chain? null = could not tell.
 *
 * The in-flight entry is saved BEFORE step 0 is sent (useCreateMarket), so its presence alone says nothing: a step 0
 * the wallet never signed leaves an entry and no account (QA 2026-10-15: the Recovery panel claimed "The market account
 * is on chain" after an unsigned step 1).
 */
export async function inFlightSlabOnChain(
  connection: Pick<Connection, "getAccountInfo"> | null | undefined,
  entry: Pick<InFlightMarketState, "slabAddress"> | null,
): Promise<boolean | null> {
  if (!entry) return false;
  if (!connection || typeof connection.getAccountInfo !== "function") return null;
  try {
    return (await connection.getAccountInfo(new PublicKey(entry.slabAddress), "confirmed")) !== null;
  } catch {
    return null;
  }
}

/** True only once the in-flight market's account is seen on chain. Re-checked whenever `revision` changes. */
export function useInFlightSlabOnChain(revision: string): boolean {
  const { connection } = useConnectionCompat();
  const [onChain, setOnChain] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      const entry = loadLastInFlightMarket();
      const seen = await inFlightSlabOnChain(connection, entry);
      if (cancelled) return;
      setOnChain(seen === true);
      if (entry && seen !== true) timer = setTimeout(check, IN_FLIGHT_RECHECK_MS);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connection, revision]);
  return onChain;
}
