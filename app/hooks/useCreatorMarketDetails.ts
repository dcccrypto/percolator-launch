"use client";

/**
 * Per-market `/api/markets/[slab]` detail for every market a creator owns —
 * the NUMBERS behind /my-markets (liquidity, insurance, OI, claimable creator
 * fees), fetched once here and not again when a row's drawer expands (see
 * CreatorMarketRow's "lazy" doc comment).
 *
 * Extracted from app/my-markets/page.tsx so the resolution behaviour below is
 * testable without mounting the page. The three things worth testing are all
 * timing, and none of them are visible to a source-level assertion: a row must
 * not wait for its siblings, a permanently failing market must still clear the
 * spinner, and a previous wallet's in-flight response must not land in the
 * current list.
 *
 * IDENTITY IS NOT HERE, deliberately. Ticker/name/logo resolve on a much faster
 * clock (hooks/useMarketIdentities.ts: the session cache synchronously, then one
 * ~150ms bulk directory call) because this route awaits an on-chain LP scan
 * before it answers — 517-1022ms per market, measured. Keeping the two maps
 * separate is load-bearing: the page's `resolvedCount` asks "are this market's
 * numbers in?", so an identity-only placeholder in this map answers yes and
 * publishes a $0.00 liquidity aggregate as a FINISHED figure.
 */

import { useEffect, useMemo, useState } from "react";
import { toCreatorMarketDetail, type CreatorMarketDetail } from "@/components/my-markets/types";
import { setMarketIdentity } from "@/lib/marketIdentityCache";
import { applyResolved } from "@/lib/incremental-details";

export function useCreatorMarketDetails(slabs: string[]) {
  const slabsKey = useMemo(() => [...slabs].sort().join(","), [slabs]);
  const [details, setDetails] = useState<Record<string, CreatorMarketDetail>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const list = slabsKey ? slabsKey.split(",") : [];
    if (list.length === 0) {
      setDetails({});
      // Clear the flag too: the early return used to leave it true forever when
      // a creator's last market disappeared while a run was in flight.
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    // Publish each market as ITS OWN fetch lands. A single
    // Promise.all(...).then(setDetails) held every row blank until the SLOWEST
    // market settled — measured 1022ms against 517ms for the fastest four, and
    // one failing market made every other row wait out its full timeout.
    let outstanding = list.length;
    const settle = () => {
      outstanding -= 1;
      // Per-run state: `outstanding` and `cancelled` are both closed over by
      // this run, so a superseded run's settles can never clear the new run's
      // flag. Without this the spinner sticks forever on a failed market.
      if (outstanding <= 0 && !cancelled) setLoading(false);
    };

    for (const slab of list) {
      void (async () => {
        try {
          const res = await fetch(`/api/markets/${slab}`);
          if (!res.ok) return null;
          const body = (await res.json()) as { market?: Record<string, unknown> };
          if (!body.market) return null;
          return toCreatorMarketDetail(body.market);
        } catch {
          return null;
        }
      })()
        .then((d) => {
          // THIS is the guard that drops a previous wallet's in-flight
          // responses — not the allow-list below. `slab` is drawn from `list`,
          // so `applyResolved`'s allow-list check is tautologically true at
          // this call site; it is a library invariant for other callers, not
          // the staleness defence for this one.
          if (cancelled) return;
          // A null result keeps whatever is already shown, so a transient 500
          // cannot revert a row that has already resolved.
          setDetails((prev) => applyResolved(prev, { slab, detail: d }, list));
          if (d) {
            // Feed the cross-navigation identity cache as each market resolves
            // so /trade/[slab] never flashes a placeholder name for a market
            // this creator just clicked into from their own dashboard.
            setMarketIdentity(slab, {
              symbol: d.symbol ?? undefined,
              name: d.name ?? undefined,
              logo_url: d.logo_url ?? undefined,
              mainnet_ca: d.mainnet_ca ?? null,
            });
          }
        })
        .finally(settle);
    }
    return () => { cancelled = true; };
  }, [slabsKey]);

  return { details, detailsLoading: loading };
}
