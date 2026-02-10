"use client";

import { useMemo, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useMarketDiscovery } from "./useMarketDiscovery";
import { parseAllAccounts, AccountKind } from "@percolator/core";
import type { DiscoveredMarket } from "@percolator/core";

export interface MyMarket extends DiscoveredMarket {
  /** Formatted label for display */
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
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { markets, loading: discoveryLoading, error } = useMarketDiscovery();

  // Admin markets are instant (from header data)
  const adminMarkets = useMemo<MyMarket[]>(() => {
    if (!publicKey || !markets.length) return [];
    const walletStr = publicKey.toBase58();
    return markets
      .filter((m) => m.header.admin.toBase58() === walletStr)
      .map((m) => ({
        ...m,
        label: m.slabAddress.toBase58().slice(0, 8) + "…",
        role: "admin" as const,
      }));
  }, [publicKey, markets]);

  // Second pass: fetch full slab data to find trader/LP accounts
  const [tradedMarkets, setTradedMarkets] = useState<MyMarket[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);

  useEffect(() => {
    if (!publicKey || !markets.length || discoveryLoading) {
      setTradedMarkets([]);
      return;
    }

    const walletStr = publicKey.toBase58();
    // Derive admin addresses directly to avoid dep on adminMarkets (infinite loop risk)
    const adminAddrs = new Set(
      markets
        .filter((m) => m.header.admin.toBase58() === walletStr)
        .map((m) => m.slabAddress.toBase58())
    );
    const nonAdminMarkets = markets.filter((m) => !adminAddrs.has(m.slabAddress.toBase58()));

    // Only check a limited number to avoid hammering RPC
    const toCheck = nonAdminMarkets.slice(0, 30);
    if (toCheck.length === 0) {
      setTradedMarkets([]);
      return;
    }

    let cancelled = false;
    setAccountsLoading(true);

    async function checkAccounts() {
      const found: MyMarket[] = [];

      // Fetch full slab data in batches of 5
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
                label: market.slabAddress.toBase58().slice(0, 8) + "…",
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
      }
    }

    checkAccounts();
    return () => { cancelled = true; };
  }, [publicKey, markets, discoveryLoading, connection]);

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
