"use client";

import { useEffect, useRef, useState } from "react";
import { MARKET_REGISTERED_EVENT } from "@/lib/keeper-register-client";
import { usePrivySessionHeaders, type PrivySessionHeaders } from "@/hooks/usePrivySafe";

/**
 * #3320: is the connected creator's OWN wallet at the per-creator live-price ceiling?
 * Client shape from @0x-SquidSol's #3325 (a status that is "unknown" until read and on ANY failure,
 * re-read when the wallet changes and when a market registers on this page), rebuilt on
 * GET /api/playground/keeper-capacity, which answers only `{ atLimit }` and only for a wallet
 * linked to the caller's verified Privy session (the hook sends that session's headers).
 *
 * Fails OPEN: no Privy session, a 401/403/429/503, a network error or a malformed body all read as
 * "unknown", and nothing blocks on unknown, so a failed pre-check launches exactly as before.
 */
export type LivePriceLimit = "unknown" | "ok" | "atLimit";

export function parseLimit(body: unknown): LivePriceLimit {
  const b = body as { atLimit?: unknown } | null;
  if (!b || typeof b.atLimit !== "boolean") return "unknown";
  return b.atLimit ? "atLimit" : "ok";
}

/** Read the limit once. Never throws; every failure is "unknown". */
export async function fetchLivePriceLimit(
  wallet: string,
  sessionHeaders: PrivySessionHeaders | null,
  doFetch: typeof fetch = fetch,
): Promise<LivePriceLimit> {
  try {
    const headers = sessionHeaders ? await sessionHeaders() : null;
    if (!headers) return "unknown";
    const r = await doFetch(`/api/playground/keeper-capacity?wallet=${encodeURIComponent(wallet)}`, {
      cache: "no-store",
      headers,
    });
    return r.ok ? parseLimit(await r.json()) : "unknown";
  } catch {
    return "unknown";
  }
}

export function useLivePriceLimit(wallet: string | null, enabled = true): LivePriceLimit {
  const sessionHeaders = usePrivySessionHeaders();
  const [limit, setLimit] = useState<LivePriceLimit>("unknown");
  const reqId = useRef(0);

  useEffect(() => {
    setLimit("unknown");
    if (!wallet || !enabled) return;
    const read = () => {
      const id = ++reqId.current;
      void fetchLivePriceLimit(wallet, sessionHeaders).then((next) => {
        if (id === reqId.current) setLimit(next);
      });
    };
    read();
    window.addEventListener(MARKET_REGISTERED_EVENT, read);
    window.addEventListener("focus", read);
    return () => {
      reqId.current++; // drop an in-flight read for a wallet we've left
      window.removeEventListener(MARKET_REGISTERED_EVENT, read);
      window.removeEventListener("focus", read);
    };
  }, [wallet, enabled, sessionHeaders]);

  return limit;
}

/** Does the per-creator ceiling block a NEW launch? Only a known limit, only for a market the keeper
 *  prices, and never while continuing a launch that already started. */
export function blocksNewLaunch(limit: LivePriceLimit, a: { keeperPriced: boolean; resuming: boolean }): boolean {
  return a.keeperPriced && !a.resuming && limit === "atLimit";
}
