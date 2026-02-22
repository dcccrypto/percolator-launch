"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useMarketDiscovery } from "./useMarketDiscovery";
import { parseAllAccounts, AccountKind } from "@percolator/core";
import { fetchTokenMeta } from "@/lib/tokenMeta";
import type { DiscoveredMarket } from "@percolator/core";

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
  const { markets, loading: discoveryLoading, error } = useMarketDiscovery();

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
    const admins = markets.filter((m) => m.header.admin.toBase58() === walletStr);

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
        .filter((m) => m.header.admin.toBase58() === walletStr)
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

          const data = new Uint8Array(result.value.data);
          try {
            const accounts = parseAllAccounts(data);
            let role: "trader" | "lp" | null = null;

            for (const { account } of accounts) {
              if (account.owner.toBase58() === walletStr) {
                if (account.kind === AccountKind.User) { role = "trader"; break; }
                if (account.kind === AccountKind.LP) { role = role ?? "lp"; }
              }
            }

            if (role) {
              const market = batch[j];
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
  };
}
