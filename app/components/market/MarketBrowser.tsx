"use client";

import { FC, useMemo } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { formatTokenAmount, shortenAddress } from "@/lib/format";
import { computeMarketHealth, sanitizeAccountCount } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import type { DiscoveredMarket } from "@percolator/sdk";

const ALL_ZEROS = new PublicKey("11111111111111111111111111111111");

function isAdminOracle(market: DiscoveredMarket): boolean {
  const feedId = market.config.indexFeedId;
  return feedId.equals(ALL_ZEROS) || feedId.equals(PublicKey.default);
}

export const MarketBrowser: FC = () => {
  const { markets, loading, error } = useMarketDiscovery();

  const mints = useMemo(
    () => markets.map((m) => m.config.collateralMint),
    [markets],
  );
  const tokenMetaMap = useMultiTokenMeta(mints);

  if (loading) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center shadow-sm">
        <p className="text-[var(--text-secondary)]">Discovering markets...</p>
      </div>
    );
  }

  if (error) {
    const helpMsg = error === "PROGRAM_ID not configured"
      ? "Set the NEXT_PUBLIC_PROGRAM_ID environment variable to your Percolator program address."
      : error;
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center shadow-sm">
        <p className="text-[var(--short)]">Error: {helpMsg}</p>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center shadow-sm">
        <p className="text-[var(--text-secondary)]">No markets found</p>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--text-secondary)]">
              <th className="px-4 py-3 font-medium">Market</th>
              <th className="px-4 py-3 font-medium">Collateral</th>
              <th className="px-4 py-3 font-medium">Oracle</th>
              <th className="px-4 py-3 font-medium text-right">Open Interest</th>
              <th className="px-4 py-3 font-medium text-right">Insurance</th>
              <th className="px-4 py-3 font-medium">Health</th>
              <th className="px-4 py-3 font-medium text-right">Accounts</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">
            {[...markets].sort((a, b) => {
              const order: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };
              return (order[computeMarketHealth(a.engine).level] ?? 4) -
                     (order[computeMarketHealth(b.engine).level] ?? 4);
            }).map((m) => {
              const slab = m.slabAddress.toBase58();
              const mintBase58 = m.config.collateralMint.toBase58();
              const meta = tokenMetaMap.get(mintBase58);
              const symbol = meta?.symbol ?? shortenAddress(mintBase58, 4);
              const decimals = meta?.decimals ?? 6;

              return (
                <tr key={slab} className="hover:bg-[var(--accent)]/[0.04]">
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--text)]">{symbol}/USD PERP</div>
                    <div className="font-mono text-xs text-[var(--text-muted)]">{shortenAddress(slab, 6)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`https://solscan.io/token/${mintBase58}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-[var(--accent)] hover:underline"
                    >
                      {symbol}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        isAdminOracle(m)
                          ? "bg-[var(--warning)]/20 text-[var(--warning)]"
                          : "bg-[var(--long)]/[0.08] text-[var(--long)]"
                      }`}
                    >
                      {isAdminOracle(m) ? "Admin" : "Pyth"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text)]">
                    {formatTokenAmount(m.engine.totalOpenInterest, decimals)} {symbol}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text)]">
                    {formatTokenAmount(m.engine.insuranceFund.balance, decimals)} {symbol}
                  </td>
                  <td className="px-4 py-3">
                    <HealthBadge level={computeMarketHealth(m.engine).level} />
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text)]">
                    {sanitizeAccountCount(m.engine.numUsedAccounts)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/trade/${slab}`}
                      className="rounded-sm border border-[var(--accent)]/40 text-[var(--accent)] bg-transparent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--accent)]/[0.08] hover:border-[var(--accent)]/70"
                    >
                      Trade
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
