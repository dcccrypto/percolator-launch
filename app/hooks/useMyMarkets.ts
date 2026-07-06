"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useMarketDiscovery } from "./useMarketDiscovery";
import {
  parseAllAccounts,
  parsePortfolioV17,
  isV17Account,
  AccountKind,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import { fetchTokenMeta } from "@/lib/tokenMeta";

// v17 portfolios are standalone program-owned accounts — mirrors
// findV17Portfolio in useDeposit.ts/useUserAccount.ts. market_group_id at
// offset 16; mutable owner (SDK PF_OWNER_OFF) at offset 116. NOTE: offset 80
// is provenanceOwner — IMMUTABLE — filtering on it would still match a
// wrapped (NFT-escrowed) portfolio (commit 3ae16309).
const V17_PORTFOLIO_MAGIC_MM = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF_MM = 16;
const V17_PF_OWNER_OFF_MM = 116;

export interface MyMarket extends DiscoveredMarket {
  /** Formatted label for display (token symbol or truncated address) */
  label: string;
  /** Why this market appears in "my markets" */
  role: "admin" | "trader" | "lp";
}

/**
 * Returns markets where the connected wallet is:
 *  - the admin (market creator)
 *  - has a User (trader) account
 *  - has an LP account
 *
 * Discovery returns header-only slices. For non-admin markets we do
 * a second-pass fetch of the full slab to check account ownership.
 * Capped at 30 markets to avoid excessive RPC usage.
 */
export function useMyMarkets() {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { markets, loading: discoveryLoading, error, refetch: discoveryRefetch } = useMarketDiscovery();

  // Token label cache: mint → symbol (persists across re-renders)
  const tokenLabelCache = useRef<Map<string, string>>(new Map());

  const resolveLabel = useCallback(async (m: DiscoveredMarket): Promise<string> => {
    const mint = m.config?.collateralMint;
    if (!mint) return m.slabAddress.toBase58().slice(0, 8) + "…";
    const mintStr = mint.toBase58();
    const cached = tokenLabelCache.current.get(mintStr);
    if (cached) return cached;
    try {
      const meta = await fetchTokenMeta(connection, mint);
      const label = meta.symbol || meta.name || mintStr.slice(0, 8) + "…";
      tokenLabelCache.current.set(mintStr, label);
      return label;
    } catch {
      return mintStr.slice(0, 8) + "…";
    }
  }, [connection]);

  // Admin markets are instant (from header data)
  const [adminMarkets, setAdminMarkets] = useState<MyMarket[]>([]);

  useEffect(() => {
    if (!publicKey || !markets.length) {
      setAdminMarkets([]);
      return;
    }
    let cancelled = false;
    const walletStr = publicKey.toBase58();
    // v17 markets carry an empty header ({}); the market authority lives in
    // configV17.marketauth. Falling back to header.admin keeps v12 working.
    // Optional chaining prevents the TypeError that otherwise blanked the whole
    // admin dashboard for anyone with a v17 market.
    const admins = markets.filter(
      (m) => (m.configV17?.marketauth ?? m.header?.admin)?.toBase58() === walletStr,
    );

    Promise.all(admins.map(async (m) => ({
      ...m,
      label: await resolveLabel(m),
      role: "admin" as const,
    }))).then((results) => {
      if (!cancelled) setAdminMarkets(results);
    });

    return () => { cancelled = true; };
  }, [publicKey, markets, resolveLabel]);

  // Second pass: fetch full slab data to find trader/LP accounts
  const [tradedMarkets, setTradedMarkets] = useState<MyMarket[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  // Track which market set we've already scanned to avoid re-blanking on poll
  const lastScannedKey = useRef<string>("");

  useEffect(() => {
    if (!publicKey || !markets.length || discoveryLoading) {
      // Don't clear tradedMarkets on re-poll — keep showing stale data
      return;
    }

    const walletStr = publicKey.toBase58();
    const adminAddrs = new Set(
      markets
        .filter((m) => (m.configV17?.marketauth ?? m.header?.admin)?.toBase58() === walletStr)
        .map((m) => m.slabAddress.toBase58())
    );
    const nonAdminMarkets = markets.filter((m) => !adminAddrs.has(m.slabAddress.toBase58()));

    const toCheck = nonAdminMarkets.slice(0, 30);

    // Build a key from market addresses to detect actual changes vs poll refreshes
    const scanKey = toCheck.map((m) => m.slabAddress.toBase58()).sort().join(",");
    if (scanKey === lastScannedKey.current && tradedMarkets.length > 0) {
      // Same markets, already scanned — skip to avoid blank flash
      return;
    }

    if (toCheck.length === 0) {
      setTradedMarkets([]);
      lastScannedKey.current = scanKey;
      return;
    }

    let cancelled = false;
    setAccountsLoading(true);

    async function checkAccounts() {
      const found: MyMarket[] = [];

      for (let i = 0; i < toCheck.length; i += 5) {
        if (cancelled) break;
        const batch = toCheck.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map((m) => connection.getAccountInfo(m.slabAddress))
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status !== "fulfilled" || !result.value) continue;

          const accountInfo = result.value;
          const data = new Uint8Array(accountInfo.data);
          const market = batch[j];
          try {
            let role: "trader" | "lp" | null = null;

            if (isV17Account(data)) {
              // v17: portfolios are standalone program-owned accounts, NOT
              // embedded in the slab — parseAllAccounts finds nothing here.
              // Scan getProgramAccounts for this wallet's portfolio on this
              // market, filtered by the mutable owner (offset 116), same
              // approach as usePortfolio.ts.
              const v17ProgramId = accountInfo.owner;
              const portfolioResults = await connection.getProgramAccounts(v17ProgramId, {
                filters: [
                  { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_MM.toString("base64"), encoding: "base64" } },
                  { memcmp: { offset: V17_PF_MARKET_OFF_MM, bytes: market.slabAddress.toBase58() } },
                  { memcmp: { offset: V17_PF_OWNER_OFF_MM, bytes: walletStr } },
                ],
              });
              for (const { account: portAcct } of portfolioResults) {
                const portData = portAcct.data instanceof Buffer ? portAcct.data : Buffer.from(portAcct.data);
                const portfolio = parsePortfolioV17(portData);
                // Defense-in-depth: re-verify the mutable owner actually matches
                // after fetch — memcmp filters are advisory server-side.
                if (portfolio.owner.toBase58() === walletStr) { role = "trader"; break; }
              }
              // v17 has no embedded LP account to detect here — LP positions
              // are tracked via LP-token balances (see useLpPositions.ts), not
              // a slab-scanned role.
            } else {
              // v12.x legacy path: accounts embedded in the slab.
              const accounts = parseAllAccounts(data);
              for (const { account } of accounts) {
                if (account.owner.toBase58() === walletStr) {
                  if (account.kind === AccountKind.User) { role = "trader"; break; }
                  if (account.kind === AccountKind.LP) { role = role ?? "lp"; }
                }
              }
            }

            if (role) {
              found.push({
                ...market,
                label: await resolveLabel(market),
                role,
              });
            }
          } catch {
            // Skip unparseable slabs
          }
        }
      }

      if (!cancelled) {
        setTradedMarkets(found);
        setAccountsLoading(false);
        lastScannedKey.current = scanKey;
      }
    }

    checkAccounts();
    return () => { cancelled = true; };
  }, [publicKey, markets, discoveryLoading, connection, resolveLabel]);

  // Merge admin + traded markets (admin first)
  const myMarkets = useMemo(() => {
    const seen = new Set(adminMarkets.map((m) => m.slabAddress.toBase58()));
    const unique = [...adminMarkets];
    for (const m of tradedMarkets) {
      if (!seen.has(m.slabAddress.toBase58())) {
        unique.push(m);
        seen.add(m.slabAddress.toBase58());
      }
    }
    return unique;
  }, [adminMarkets, tradedMarkets]);

  return {
    myMarkets,
    loading: discoveryLoading || accountsLoading,
    error,
    connected: !!publicKey,
    /** Trigger a fresh discovery fetch (bypasses SWR dedup window). */
    refetch: discoveryRefetch,
  };
}
