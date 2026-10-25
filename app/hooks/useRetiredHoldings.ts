"use client";

/**
 * useRetiredHoldings — funds that market discovery would otherwise make invisible.
 *
 * 2026-07-31 audit finding: every portfolio surface derives its market universe from /api/markets, which filters blocklisted slabs, so a
 * user with deposits in a RETIRED market saw "no positions" and a total that silently excluded their money (the CATE depositors'
 * ~$990). Retirement hides markets from DISCOVERY, never people's own funds from them.
 *
 * v2.2: a market now leaves the happy path when it RESOLVES (settled by its admin, or by anyone once its price stopped), not only when
 * it is blocklisted. This hook bypasses market discovery: ONE getProgramAccounts scan for every portfolio the connected wallet owns
 * (magic @0, mutable owner @116, and with v2.2 on the account length and VERSION), one batched read of those markets' headers, and it
 * keeps the portfolios whose market is Resolved (engine mode) or blocklisted and that still hold value
 * (lib/v22/retired-holdings.ts). The result feeds the "settled markets holding your funds" section; it never mixes into the normal flows.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { isBlockedSlab } from "@/lib/blocklist";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { portfolioGpaFilters } from "@/lib/v22/layout";
import {
  MARKET_MODE_SLICE_LEN,
  PORTFOLIO_OWNER_OFF,
  classifyRetiredHolding,
  portfolioMarket,
  readMarketForHoldings,
  type RetiredHolding,
} from "@/lib/v22/retired-holdings";

export type { RetiredHolding };

/** Wrapper account magic `"PERCV16\0"` (little-endian), the same on v2.1 and v2.2. */
const WRAPPER_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

const BATCH = 100;

export function useRetiredHoldings(): { holdings: RetiredHolding[]; loading: boolean } {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const [holdings, setHoldings] = useState<RetiredHolding[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setHoldings([]);
    if (!publicKey) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const programId = new PublicKey(getConfig().programId);
        const v22 = isDevnetV22Enabled();
        const accounts = await connection.getProgramAccounts(programId, {
          filters: [
            { memcmp: { offset: 0, bytes: WRAPPER_MAGIC.toString("base64"), encoding: "base64" } },
            { memcmp: { offset: PORTFOLIO_OWNER_OFF, bytes: publicKey.toBase58() } },
            ...(v22 ? portfolioGpaFilters() : []),
          ],
        });
        const rows: { slab: string; data: Uint8Array }[] = [];
        for (const { account } of accounts) {
          const data = new Uint8Array(account.data);
          const slab = portfolioMarket(data);
          if (slab) rows.push({ slab, data });
        }
        // Resolved markets are found from their engine mode: read the header of each distinct market once (a prefix, not the slab).
        const modes = new Map<string, ReturnType<typeof readMarketForHoldings>>();
        if (v22) {
          const slabs = [...new Set(rows.map((r) => r.slab))];
          for (let i = 0; i < slabs.length; i += BATCH) {
            const batch = slabs.slice(i, i + BATCH);
            const infos = await connection.getMultipleAccountsInfo(
              batch.map((s) => new PublicKey(s)),
              { commitment: "confirmed", dataSlice: { offset: 0, length: MARKET_MODE_SLICE_LEN } },
            );
            batch.forEach((s, j) => {
              const info = infos[j];
              modes.set(s, info ? readMarketForHoldings(new Uint8Array(info.data)) : null);
            });
          }
        }
        const found: RetiredHolding[] = [];
        for (const { slab, data } of rows) {
          const h = classifyRetiredHolding({ portfolio: data, slabAddress: slab, market: modes.get(slab) ?? null, blocked: isBlockedSlab(slab) });
          if (h) found.push(h);
        }
        if (!cancelled) setHoldings(found);
      } catch {
        // Scan failed (RPC hiccup): show nothing rather than an error — the section is additive; the rest of the portfolio page is unaffected.
        if (!cancelled) setHoldings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey]);

  return { holdings, loading };
}
