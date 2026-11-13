"use client";

/**
 * Installs the ONE app-level loader of market lot exponents (lib/v22/lot-registry.ts) with the app's connection. The
 * price store asks it for any slab it is asked to price while the exponent is unknown, so no page has to set it
 * (review N1). Renders nothing; does nothing with the v2.2 flag off.
 *
 * The registry is imported lazily, inside the effect: it decodes slab bytes through the v2.2 SDK ports, which pull the
 * whole @percolatorct/sdk bundle (+ spl-token, bignumber.js) — statically imported here, that sat in the root layout's
 * first-load JS on every route. Pages that price a market import the registry themselves, so there the import resolves
 * from the already-loaded module; the loader is still installed in the same effect pass as before (after the page's own
 * effects), one microtask later.
 */
import { useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export function LotExpLoaderBridge(): null {
  const { connection } = useConnectionCompat();
  useEffect(() => {
    if (!isDevnetV22Enabled()) return;
    let cancelled = false;
    let uninstall: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const install = (attempt: number): void => {
      import("@/lib/v22/lot-registry").then(({ lotExpOfStrict, observeLotExp, setLotExpLoader }) => {
        if (cancelled) return;
        setLotExpLoader(async (slab) => {
          const info = await connection.getAccountInfo(new PublicKey(slab), "confirmed");
          if (!info?.data) return null;
          const bytes = new Uint8Array(info.data);
          // r10 (#3821 LOW-3): the same bytes give the exponent AND the holding-fee flag, so a surface that only has the loader never sees one
          // without the other (an unseen market answers "may apply" and would hide the trade result on every normal market).
          observeLotExp(slab, bytes);
          return lotExpOfStrict(bytes);
        });
        uninstall = () => setLotExpLoader(null);
      }, () => {
        // Chunk failed to load: retry a few times rather than leave the app without a loader.
        if (!cancelled && attempt < 3) retry = setTimeout(() => install(attempt + 1), 2_000 * (attempt + 1));
      });
    };
    install(0);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      uninstall?.();
    };
  }, [connection]);
  return null;
}
