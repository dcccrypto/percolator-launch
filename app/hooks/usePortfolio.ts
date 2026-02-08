"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  discoverMarkets,
  fetchSlab,
  parseAllAccounts,
  AccountKind,
  type DiscoveredMarket,
  type Account,
} from "@percolator/core";
import { config } from "@/lib/config";

export interface PortfolioPosition {
  slabAddress: string;
  symbol: string | null;
  account: Account;
  idx: number;
  market: DiscoveredMarket;
}

export interface PortfolioData {
  positions: PortfolioPosition[];
  totalPnl: bigint;
  totalDeposited: bigint;
  loading: boolean;
}

/**
 * Fetches all markets and finds positions for the connected wallet.
 */
export function usePortfolio(): PortfolioData {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [totalPnl, setTotalPnl] = useState<bigint>(0n);
  const [totalDeposited, setTotalDeposited] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicKey || !config.programId) {
      setPositions([]);
      setTotalPnl(0n);
      setTotalDeposited(0n);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const programId = new PublicKey(config.programId);
    const pkStr = publicKey.toBase58();

    async function load() {
      try {
        setLoading(true);
        const markets = await discoverMarkets(connection, programId);
        const allPositions: PortfolioPosition[] = [];
        let pnlSum = 0n;
        let depositSum = 0n;

        // For each market, fetch full slab to find user accounts
        for (const market of markets) {
          try {
            const slabData = await fetchSlab(connection, market.slabAddress);
            const accounts = parseAllAccounts(slabData);

            for (const { idx, account } of accounts) {
              if (account.kind === AccountKind.User && account.owner.toBase58() === pkStr) {
                allPositions.push({
                  slabAddress: market.slabAddress.toBase58(),
                  symbol: null, // Will be enriched by caller if needed
                  account,
                  idx,
                  market,
                });
                pnlSum += account.pnl;
                depositSum += account.capital;
              }
            }
          } catch {
            // Skip markets that fail to load
          }
        }

        if (!cancelled) {
          setPositions(allPositions);
          setTotalPnl(pnlSum);
          setTotalDeposited(depositSum);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [connection, publicKey]);

  return { positions, totalPnl, totalDeposited, loading };
}
