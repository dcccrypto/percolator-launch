"use client";

import { useEffect, useState } from "react";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";
import { isMockMode } from "@/lib/mock-mode";

/** An already-listed market for the same underlying token. */
export interface DuplicateMarket {
  slab: string;
  symbol: string | null;
}

export interface DuplicateMarketCheck {
  /** True while the lookup is in flight — callers gating an auto-advance
   *  should wait for it to settle so a slow lookup can't be raced past. */
  checking: boolean;
  /** Markets already listed for this token (empty = clear to launch). */
  duplicates: DuplicateMarket[];
}

const CLEAR: DuplicateMarketCheck = { checking: false, duplicates: [] };

/**
 * One market per token — client half of the guard (POST /api/markets 409s
 * authoritatively): looks up whether the pasted token CA already has a
 * listed market, so the create wizard can block step 1 BEFORE the user
 * spends SOL deploying a slab the registry will reject.
 *
 * Owned by the WIZARD, not StepTokenSelect: Quick Launch auto-advances
 * step 1 → 2 the moment the token resolves, unmounting the step — state
 * living inside the step would be thrown away before it could gate
 * anything.
 *
 * Matches on mint_address OR mainnet_ca: playground markets store the
 * pasted CA in mainnet_ca (mint_address is the shared sim-USDC collateral);
 * mainnet deployments collateralize in the token itself, so there
 * mint_address IS the token.
 *
 * Fail-open: a failed/slow/aborted lookup reports "clear" — the server-side
 * 409 is the authoritative gate, and a registry hiccup must never block a
 * legitimate launch. Disabled entirely in mock mode (demo walkthroughs
 * paste CAs of tokens that DO have curated markets).
 */
export function useDuplicateMarket(tokenCa: string | null): DuplicateMarketCheck {
  const [state, setState] = useState<DuplicateMarketCheck>(CLEAR);

  useEffect(() => {
    const ca = tokenCa?.trim() ?? "";
    if (!ca || !isValidBase58Pubkey(ca) || ca.length < 32 || isMockMode()) {
      setState(CLEAR);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    setState({ checking: true, duplicates: [] });
    (async () => {
      try {
        const res = await fetch(`/api/markets?search=${encodeURIComponent(ca)}&limit=50`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          setState(CLEAR); // fail-open — server 409 backstops
          return;
        }
        const body = (await res.json()) as { markets?: unknown };
        const rows = Array.isArray(body.markets) ? body.markets : [];
        const duplicates: DuplicateMarket[] = [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const m = row as Record<string, unknown>;
          // Exact-match the token — `search` is a fuzzy substring filter
          // over symbol/name/slab/mint/ca, so re-verify identity here.
          const mint = typeof m.mint_address === "string" ? m.mint_address : null;
          const mainnetCa = typeof m.mainnet_ca === "string" ? m.mainnet_ca : null;
          const slab = typeof m.slab_address === "string" ? m.slab_address : null;
          if (slab && (mint === ca || mainnetCa === ca)) {
            duplicates.push({ slab, symbol: typeof m.symbol === "string" ? m.symbol : null });
          }
        }
        if (!cancelled) setState({ checking: false, duplicates });
      } catch {
        if (!cancelled) setState(CLEAR); // fail-open, incl. the 8s timeout abort
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [tokenCa]);

  return state;
}
