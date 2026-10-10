"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { connectionQuoteDeps, quoteConvertible, type ConvertQuote } from "@/lib/convert-released-pnl";
import { parsePortfolio } from "@/lib/v22/layout";

/**
 * Released profit the program would move into capital right now (ConvertReleasedPnl, tag 28),
 * read from a simulation of the instruction itself (lib/convert-released-pnl.ts). Re-quotes
 * whenever the account's capital or pnl changes. `null` while unknown.
 */
export function useConvertibleProfit(
  slabAddress: string,
  portfolioPk: PublicKey | undefined,
  capital: bigint,
  pnl: bigint,
  hasOpenPosition: boolean,
): ConvertQuote | null {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const { programId } = useSlabState();
  const [quote, setQuote] = useState<ConvertQuote | null>(null);
  const portfolioKey = portfolioPk?.toBase58() ?? null;
  const ownerKey = publicKey?.toBase58() ?? null;
  const programKey = programId?.toBase58() ?? null;

  useEffect(() => {
    setQuote(null);
    if (!portfolioPk || !publicKey || !programId || hasOpenPosition || pnl <= 0n) {
      setQuote({ status: "none" });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await connection.getAccountInfo(portfolioPk, "confirmed");
        if (!info || cancelled) return;
        const data = new Uint8Array(info.data);
        if (!parsePortfolio(data).owner.equals(publicKey)) return;
        const q = await quoteConvertible(
          { programId, owner: publicKey, market: new PublicKey(slabAddress), portfolio: portfolioPk, portfolioData: data },
          connectionQuoteDeps(connection, publicKey),
        );
        if (!cancelled) setQuote(q);
      } catch {
        if (!cancelled) setQuote(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keys, not objects: re-quote on identity or balance changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, slabAddress, portfolioKey, ownerKey, programKey, capital, pnl, hasOpenPosition]);

  return quote;
}
