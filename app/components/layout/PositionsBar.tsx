"use client";

import Link from "next/link";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, isV17Account, V17_HEADER_LEN } from "@percolatorct/sdk";
import { subscribeSlab, getSnapshot, applyOnChainPoll } from "@/lib/priceStore/priceStore";
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { computeMarkPnl, computeMarkPnlCollateral, computePnlPercent, computePositionInitialMargin } from "@/lib/trading";
import { usePortfolio, type PortfolioPosition } from "@/hooks/usePortfolio";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { formatTokenAmount } from "@/lib/format";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";

/** On-chain freshness floor for chips the WS feed isn't ticking: one batched
 *  getMultipleAccountsInfo across every position slab per interval. */
const ONCHAIN_POLL_MS = 4_000;
/** getMultipleAccountsInfo hard cap per request (RPC rejects >100). */
const RPC_ACCOUNT_BATCH_CAP = 100;

// The portfolio page already renders every position in full (and mounts its
// own usePortfolio), and the dashboard mounts FOUR separate usePortfolio
// instances (StatsBar/PnlChart/PositionSummary/DashboardHeader) — showing
// the strip on either page doubles/quintuples chrome and RPC scans for no
// information gain. Perf-review fix: this list gates the usePortfolio HOOK
// itself (via `enabled`), not just the render below — see the `hidden`
// derivation and its use as `usePortfolio(!hidden && ...)`.
//
// "/trade" is hidden too: the trade page's PositionsDock now renders its own
// OtherMarketPositions list (all-markets, via its own usePortfolio call) in
// the Positions tab, so the strip is redundant chrome there. usePortfolio has
// no cross-instance dedup — without this, every /trade page would run TWO
// concurrent wallet-wide portfolio scans (market discovery + batched
// getMultipleAccountsInfo + up to two getProgramAccounts/market, each on its
// own 30s poll) for the same data.
const HIDDEN_ROUTES = ["/portfolio", "/dashboard", "/trade"];

/** One position chip: ticker + live PnL, colored by sign, linking to the market. */
function PositionChip({ pos, decimals }: { pos: PortfolioPosition; decimals: number }) {
  // Live mark from the shared WS price store (same feed as the trade page);
  // falls back to the portfolio poll's oracle price until the first tick.
  const subscribe = useCallback((cb: () => void) => subscribeSlab(pos.slabAddress, cb), [pos.slabAddress]);
  const getSnap = useCallback(() => getSnapshot(pos.slabAddress).priceE6, [pos.slabAddress]);
  const livePriceE6 = useSyncExternalStore(subscribe, getSnap, () => null);

  const posSize = pos.account?.positionSize ?? 0n;
  const posEntry = pos.effectiveEntryPrice;
  const markE6 = livePriceE6 != null && livePriceE6 > 0n ? livePriceE6 : pos.oraclePriceE6;

  // Same collateral-unit conversion as usePortfolio / the portfolio cards:
  // computeMarkPnl is coin-margined native units, NOT collateral — convert
  // via computeMarkPnlCollateral. Falls back to the hook's own (already
  // collateral-converted) unrealizedPnl when entry/mark are unavailable.
  const pnl = (() => {
    if (posSize === 0n || posEntry <= 0n || markE6 <= 0n) return pos.unrealizedPnl;
    try {
      return computeMarkPnlCollateral(computeMarkPnl(posSize, posEntry, markE6), markE6);
    } catch {
      return pos.unrealizedPnl;
    }
  })();

  // Live ROE — same basis as the portfolio cards: PnL ÷ the position's own
  // locked initial margin, capital fallback, hook's pnlPercent last resort.
  const pnlPct = (() => {
    try {
      const im = computePositionInitialMargin(posSize, posEntry, pos.initialMarginBps);
      if (im > 0n) return computePnlPercent(pnl, im);
      const capital = pos.account?.capital ?? 0n;
      return capital > 0n ? computePnlPercent(pnl, capital) : pos.pnlPercent;
    } catch {
      return pos.pnlPercent;
    }
  })();

  const symbol = pos.symbol ?? `${pos.slabAddress.slice(0, 4)}…`;
  const colorClass =
    pnl > 0n ? "text-[var(--long)]" : pnl < 0n ? "text-[var(--short)]" : "text-[var(--text)]";
  const sign = pnl > 0n ? "+" : pnl < 0n ? "-" : "";
  const abs = pnl < 0n ? -pnl : pnl;

  return (
    <Link
      href={`/trade/${pos.slabAddress}`}
      className="group flex shrink-0 items-center gap-1.5 px-3 py-1 transition-colors hover:bg-[var(--bg-elevated)]"
      style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
    >
      <span
        className={`h-1 w-1 rounded-full ${posSize > 0n ? "bg-[var(--long)]" : "bg-[var(--short)]"}`}
        aria-hidden
      />
      <span className="text-[11px] font-semibold text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text)]">
        {symbol.replace(/-PERP$/i, "")}
      </span>
      <span className={`text-[11px] font-bold ${colorClass}`}>
        {sign}{formatTokenAmount(abs, decimals)}
      </span>
      {/* ROE — smaller + dimmed so the dollar figure stays the loud number;
          no extra sign (color + the main value already carry direction). */}
      <span className={`text-[10px] font-medium opacity-60 ${colorClass}`}>
        {Math.abs(pnlPct).toFixed(1)}%
      </span>
    </Link>
  );
}

/**
 * Site-wide open-positions strip, rendered directly under the sticky header.
 * One chip per open position — ticker + live PnL (green/red/white by sign) —
 * so a trader navigating anywhere on the site can watch their book and jump
 * straight to a market that's moving against them.
 *
 * Renders nothing (zero height) when the wallet is disconnected, the route
 * is one that already runs its own portfolio scan (see HIDDEN_ROUTES), the
 * portfolio is still on its first load, or there are no open positions.
 *
 * Perf: `usePortfolio` is a genuinely expensive hook — full market
 * discovery, a batched `getMultipleAccountsInfo`, and up to two
 * `getProgramAccounts` scans per market, on a 30s auto-refresh interval.
 * Gating only the RENDER (returning null below) while still calling the
 * hook unconditionally would mount that full cost on EVERY route for any
 * connected wallet, plus a redundant second scan on /portfolio (whose page
 * already mounts its own `usePortfolio()`). `enabled` below gates the HOOK
 * itself instead, so the strip has zero RPC footprint anywhere it isn't
 * actually shown.
 */
export function PositionsBar() {
  const pathname = usePathname();
  const { connected: walletConnected } = useWalletCompat();
  const mockMode = isMockMode();

  const hidden =
    pathname != null && HIDDEN_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));

  // Mock-mode positions never touch the network (see getMockPortfolioPositions),
  // so there's nothing to gate there — only the real hook's fetch/poll needs
  // `enabled` to track "would this strip actually show anything right now".
  const usingMockData = mockMode && !walletConnected;
  const portfolio = usePortfolio(!hidden && walletConnected);

  const mockPositions = usingMockData ? getMockPortfolioPositions() : null;
  const positions = mockPositions ?? portfolio.positions;
  // Largest book exposure first (left → right). Notional (|size| × oracle
  // price) rather than raw size so positions are comparable across markets
  // (1000 WIF ≠ 1000 SOL). Sorted on the poll's oracle price, not the live
  // mark, so chips don't reshuffle on every price tick.
  const notionalOf = (pos: PortfolioPosition): bigint => {
    const size = pos.account?.positionSize ?? 0n;
    const abs = size < 0n ? -size : size;
    return pos.oraclePriceE6 > 0n ? (abs * pos.oraclePriceE6) / 1_000_000n : abs;
  };
  const openPositions = positions
    .filter((pos) => (pos.account?.positionSize ?? 0n) !== 0n)
    .sort((a, b) => (notionalOf(b) > notionalOf(a) ? 1 : notionalOf(b) < notionalOf(a) ? -1 : 0));

  // Collateral decimals per mint (all playground markets use 6-decimal
  // sim-USDC; resolved properly anyway, matching the portfolio page).
  const tokenMetaMap = useMultiTokenMeta(openPositions.map((pos) => pos.collateralMint));

  // Freshness floor for markets the WS feed isn't ticking: read every
  // position slab's markEwmaE6 (the exact field usePortfolio publishes as
  // oraclePriceE6) in ONE batched RPC call every ONCHAIN_POLL_MS, and hand
  // it to the store. `applyOnChainPoll` refuses to touch any slab with a
  // recent live WS tick, so streaming feeds always outrank this poll — it
  // only ever REPLACES data that is already staler than itself.
  //
  // Keyed on an ADDRESS-SORTED slab list, not `openPositions` (which is
  // sorted by notional). Notional is derived from `oraclePriceE6` and
  // shifts on every portfolio refresh — two positions trading places in
  // relative size would otherwise change this key's string every poll tick
  // and needlessly tear down + restart the interval (and refire the poll
  // immediately) even though the underlying SET of watched slabs didn't
  // change. Sorting by address instead gives a key that's stable across
  // re-renders unless positions are actually opened/closed.
  const { connection } = useConnectionCompat();
  const slabKey = openPositions
    .map((pos) => pos.slabAddress)
    .sort()
    .join(",");
  useEffect(() => {
    // No poll when the bar isn't showing (hidden route), disconnected, or
    // the book is mock (mock slabs aren't on-chain accounts) — zero RPC
    // when invisible.
    if (!slabKey || usingMockData || hidden) return;
    const slabAddrs = slabKey.split(",").slice(0, RPC_ACCOUNT_BATCH_CAP);
    let keys: PublicKey[];
    try {
      keys = slabAddrs.map((s) => new PublicKey(s));
    } catch {
      return; // defensive: a malformed address would throw on every tick
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const infos = await connection.getMultipleAccountsInfo(keys);
        if (cancelled) return;
        infos.forEach((info, i) => {
          if (!info?.data || !isV17Account(info.data)) return;
          try {
            const e6 = sanitizePriceE6(parseWrapperConfigV17(info.data, V17_HEADER_LEN).markEwmaE6);
            if (e6 > 0n) applyOnChainPoll(slabAddrs[i], e6);
          } catch {
            /* unparseable slab — skip, keep the rest of the batch */
          }
        });
      } catch {
        /* transient RPC failure — next interval retries */
      }
    };
    poll();
    const id = setInterval(poll, ONCHAIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, slabKey, usingMockData, hidden]);

  if (hidden || (!walletConnected && !mockPositions) || openPositions.length === 0) return null;

  return (
    <div
      className="sticky top-14 z-40 flex items-center overflow-x-auto border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-md [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="positions-bar"
    >
      <span className="shrink-0 select-none border-r border-[var(--border)] px-3 py-1 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
        Positions
      </span>
      {openPositions.map((pos, i) => (
        <PositionChip
          key={`${pos.slabAddress}-${pos.idx ?? i}`}
          pos={pos}
          decimals={tokenMetaMap.get(pos.collateralMint.toBase58())?.decimals ?? 6}
        />
      ))}
    </div>
  );
}
