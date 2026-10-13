"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useTraderStats } from "@/hooks/useTraderStats";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { useCreatedMarkets } from "@/hooks/useCreatedMarkets";
import { useTraderPositions } from "@/hooks/useTraderPositions";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import type { PortfolioPosition } from "@/hooks/usePortfolio";
import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";
import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";
import { describeEntryPrice } from "@/lib/entry-price-display";
import { formatPnl, formatTokenAmount, formatUsdPriceE6, LIQ_PRICE_UNLIQUIDATABLE } from "@/lib/format";
import { explorerAccountUrl } from "@/lib/config";
import { computePositionLeverage, describePositionLeverage } from "@/lib/position-leverage";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { parseTraderWallet, shortWallet } from "@/lib/trader-profile";

const MONO = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" } as const;

function SectionLabel({ children, count }: { children: string; count?: number | null }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent-text)]">// {children}</h2>
      {count != null && <span className="text-[10px] text-[var(--text-secondary)]">{count}</span>}
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-[var(--border)] px-4 py-6 text-center text-[12px] text-[var(--text-secondary)]">{children}</p>
  );
}

/**
 * Public trader profile: what any wallet has done on Percolator. Read-only, and built from public
 * data only (on-chain accounts and the indexer's trade log), reusing the portfolio page's loaders.
 */
export default function TraderProfilePage() {
  const params = useParams<{ wallet: string }>();
  const wallet = parseTraderWallet(params?.wallet);
  const { publicKey } = useWalletCompat();
  const isYou = !!wallet && publicKey?.toBase58() === wallet;

  const traderStats = useTraderStats(wallet);
  const { statsMap } = useAllMarketStats();
  const created = useCreatedMarkets(wallet);
  const open = useTraderPositions(wallet);
  const mints = useMemo(() => open.positions.map((p) => p.collateralMint), [open.positions]);
  const tokenMeta = useMultiTokenMeta(mints);
  const [copied, setCopied] = useState(false);

  if (!wallet) {
    return (
      <div className="mx-auto max-w-[900px] px-4 py-20 text-center">
        <p className="text-[14px] text-[var(--text)]">That isn&apos;t a Solana wallet address.</p>
        <Link href="/leaderboard" className="mt-4 inline-block text-[12px] text-[var(--accent)] hover:underline">
          Back to the leaderboard
        </Link>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: the full address is still selectable in the title tooltip */
    }
  };

  return (
    <div className="mx-auto max-w-[900px] px-4 py-10 sm:py-14">
      {/* ── Header ───────────────────────────────────────────── */}
      <Link href="/leaderboard" className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]" style={MONO}>
        ← Leaderboard
      </Link>
      <div className="mt-4 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent-text)]">// trader</div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-[26px] font-semibold text-[var(--text)] sm:text-[30px]" style={MONO} title={wallet}>
          {shortWallet(wallet)}
        </h1>
        {isYou && (
          <span className="border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--accent)]">
            You
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]" style={MONO}>
        <button
          type="button"
          onClick={copy}
          className="border border-[var(--border)] px-3 py-1.5 text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
        >
          {copied ? "Copied ✓" : "Copy address"}
        </button>
        <a
          href={explorerAccountUrl(wallet)}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-[var(--border)] px-3 py-1.5 text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
        >
          View on explorer ↗
        </a>
        {isYou && (
          <Link
            href="/portfolio"
            className="border border-[var(--accent)]/40 px-3 py-1.5 text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
          >
            Open your portfolio →
          </Link>
        )}
      </div>

      {/* ── Stats ────────────────────────────────────────────── */}
      <section className="mt-8">
        <TradeStatsPanel
          stats={traderStats.stats}
          loading={traderStats.loading}
          error={traderStats.error}
          onRetry={traderStats.refresh}
        />
      </section>

      {/* ── Open positions ───────────────────────────────────── */}
      <section className="mt-10">
        <SectionLabel count={open.loading || open.error ? null : open.positions.length}>open positions</SectionLabel>
        {open.loading ? (
          <Quiet>Loading open positions…</Quiet>
        ) : open.error ? (
          <Quiet>{open.error}</Quiet>
        ) : open.positions.length === 0 ? (
          <Quiet>No open positions right now.</Quiet>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {open.positions.map((p, i) => (
              <PositionCard
                key={`${p.slabAddress}-${p.nftWrapped ? "w" : "o"}-${i}`}
                pos={p}
                symbol={p.symbol ?? statsMap.get(p.slabAddress)?.symbol ?? null}
                decimals={tokenMeta.get(p.collateralMint.toBase58())?.decimals ?? 6}
                collateralSymbol={collateralLabel(tokenMeta.get(p.collateralMint.toBase58())?.symbol, p.collateralMint.toBase58())}
              />
            ))}
          </div>
        )}
        <p className="mt-2 text-[10.5px] text-[var(--text-secondary)]">
          PnL here is unrealized, at the current mark. Realized PnL isn&apos;t recorded yet; it arrives with devnet v2.2.
        </p>
      </section>

      {/* ── Markets created ──────────────────────────────────── */}
      <section className="mt-10">
        <SectionLabel count={created.loading || created.error ? null : created.myMarkets.length}>markets created</SectionLabel>
        {created.loading ? (
          <Quiet>Checking which markets this wallet created…</Quiet>
        ) : created.error ? (
          <Quiet>Couldn&apos;t check created markets. Try again in a moment.</Quiet>
        ) : created.myMarkets.length === 0 ? (
          <Quiet>This wallet hasn&apos;t created a market.</Quiet>
        ) : (
          <div className="flex flex-wrap gap-2">
            {created.myMarkets.map((m) => {
              const slab = m.slabAddress.toBase58();
              const label = statsMap.get(slab)?.symbol ?? m.label;
              return (
                <Link
                  key={slab}
                  href={`/trade/${slab}`}
                  className="border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--text)] transition-colors hover:border-[var(--accent)]/50"
                  style={MONO}
                >
                  {label} ↗
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Trade history ────────────────────────────────────── */}
      <section className="mt-10">
        <SectionLabel>trade history</SectionLabel>
        <TradeHistoryTable wallet={wallet} pageSize={20} statsMap={statsMap} emptyHint="This wallet's executed trades will appear here." />
      </section>
    </div>
  );
}

/** The collateral's symbol, or "" when its metadata didn't resolve (never a truncated mint). */
function collateralLabel(symbol: string | null | undefined, mint: string): string {
  const s = sanitizeSymbol(symbol, mint);
  return s === "Token" ? "" : s;
}

/** One open position, read-only. Same display rules as the dock: unknown values show "—", never 0. */
function PositionCard({
  pos,
  symbol,
  decimals,
  collateralSymbol,
}: {
  pos: PortfolioPosition;
  symbol: string | null;
  decimals: number;
  collateralSymbol: string;
}) {
  const size = pos.effectiveSize ?? pos.account.positionSize;
  const isLong = size > 0n;
  const abs = size < 0n ? -size : size;
  const entry = describeEntryPrice({ entryE6: pos.effectiveEntryPrice, source: pos.entryPriceSource });
  const liq = pos.liquidationPriceE6;
  const liqText = liq > 0n && liq !== LIQ_PRICE_UNLIQUIDATABLE ? formatUsdPriceE6(liq) : "—";
  const pnl = pos.unrealizedPnl;
  const pnlColor = !pos.pnlKnown || pnl === 0n ? "text-[var(--text-secondary)]" : pnl > 0n ? "text-[var(--long)]" : "text-[var(--short)]";
  // Same current-leverage figure as the portfolio page: notional at the mark / (capital + pnl).
  const lev = describePositionLeverage(
    computePositionLeverage({
      sizeQ: pos.account?.positionSize ?? 0n,
      markPriceE6: pos.oraclePriceE6 > 0n ? pos.oraclePriceE6 : null,
      capital: pos.account?.capital,
      pnl: pos.account?.pnl,
      collateralDecimals: decimals,
    }),
  );

  const cell = (label: string, value: React.ReactNode, className = "text-[var(--text)]", title?: string) => (
    <div className="min-w-0">
      <div className="text-[8px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">{label}</div>
      <div className={`truncate text-[12px] ${className}`} style={MONO} title={title}>
        {value}
      </div>
    </div>
  );

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/trade/${pos.slabAddress}`} className="truncate text-[13px] font-medium text-[var(--text)] hover:text-[var(--accent)]">
          {symbol ? `${symbol}/USD` : shortWallet(pos.slabAddress)} ↗
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          {pos.nftWrapped && (
            <span className="rounded-sm bg-[var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--accent)]">NFT</span>
          )}
          <span
            className={`rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase ${isLong ? "bg-[var(--long)]/10 text-[var(--long)]" : "bg-[var(--short)]/10 text-[var(--short)]"}`}
          >
            {isLong ? "Long" : "Short"}
          </span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2">
        {cell("Size", formatTokenAmount(abs, decimals))}
        {cell("Lev", lev.text, lev.known ? "text-[var(--text)]" : "text-[var(--text-secondary)]", lev.title)}
        {cell("Entry", entry.text, entry.known ? "text-[var(--text)]" : "text-[var(--text-secondary)]", entry.title)}
        {cell("Mark", formatUsdPriceE6(pos.oraclePriceE6))}
        {cell("Liq. Price", liqText)}
        {cell(
          "Unrealized",
          pos.pnlKnown ? `${formatPnl(pnl, decimals)}${collateralSymbol ? ` ${collateralSymbol}` : ""}` : "—",
          pnlColor,
        )}
      </div>
    </div>
  );
}
