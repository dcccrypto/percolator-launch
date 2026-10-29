"use client";

/**
 * D2 gate: positions of the connected wallet that were reduced without its own order (incl. the LP stop). One owner scan of the
 * wallet's portfolios (addresses only: a zero-length data slice), then `/api/trader/:wallet/reduce-events`. v2.2 only: with the flag
 * off nothing is read. A failed scan or read answers `available: false`, never an empty "nothing happened".
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { portfolioGpaFilters } from "@/lib/v22/layout";
import { PORTFOLIO_OWNER_OFF } from "@/lib/v22/retired-holdings";
import { fetchReduceEvents, type ReduceEventView } from "@/lib/v22/reduce-events";

/** Wrapper account magic `"PERCV16\0"` (little-endian), as in useRetiredHoldings. */
const WRAPPER_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

export interface ReduceEventsState {
  loading: boolean;
  available: boolean;
  events: ReduceEventView[];
}

export function useReduceEvents(): ReduceEventsState {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const [state, setState] = useState<ReduceEventsState>({ loading: false, available: true, events: [] });

  useEffect(() => {
    setState({ loading: false, available: true, events: [] });
    if (!publicKey || !isDevnetV22Enabled()) return;
    let cancelled = false;
    setState({ loading: true, available: true, events: [] });
    (async () => {
      try {
        const programId = new PublicKey(getConfig().programId);
        const accounts = await connection.getProgramAccounts(programId, {
          dataSlice: { offset: 0, length: 0 },
          filters: [
            { memcmp: { offset: 0, bytes: WRAPPER_MAGIC.toString("base64"), encoding: "base64" } },
            { memcmp: { offset: PORTFOLIO_OWNER_OFF, bytes: publicKey.toBase58() } },
            ...portfolioGpaFilters(),
          ],
        });
        const portfolios = accounts.map((a) => a.pubkey.toBase58());
        const out = portfolios.length === 0
          ? { available: true, events: [] }
          : await fetchReduceEvents(publicKey.toBase58(), portfolios, async (url) => {
              const r = await fetch(url);
              return r.ok ? r.json() : null;
            });
        if (!cancelled) setState({ loading: false, ...out });
      } catch {
        if (!cancelled) setState({ loading: false, available: false, events: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey]);

  return state;
}
