"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, isV17Account, V17_HEADER_LEN } from "@percolatorct/sdk";
import { subscribeSlab, getSnapshot, applyOnChainPoll } from "@/lib/priceStore/priceStore";
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { computeLivePositionPnl } from "@/lib/trading";
import { usePortfolio, type PortfolioPosition } from "@/hooks/usePortfolio";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { formatTokenAmount } from "@/lib/format";
import { isMockMode } from "@/lib/mock-mode";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";

/** On-chain freshness floor for chips the WS feed isn't ticking: one batched
 *  getMultipleAccountsInfo across every position slab per interval. */
const ONCHAIN_POLL_MS = 4_000;
/** getMultipleAccountsInfo hard cap per request (RPC rejects >100). */
const RPC_ACCOUNT_BATCH_CAP = 100;

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

  // Same live-mark PnL/ROE chain as the portfolio cards (PositionCard) — see
  // computeLivePositionPnl's doc comment for the full unit-conversion story
  // (coin-margined native → collateral, ROE ÷ initial margin).
  const { pnl, pnlPercent: pnlPct } = computeLivePositionPnl(
    posSize,
    posEntry,
    markE6,
    pos.initialMarginBps,
    pos.account?.capital ?? 0n,
    pos.unrealizedPnl,
    pos.pnlPercent,
  );

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
 * Shown on EVERY route (a trader wanted their book visible the whole time),
 * including /trade, /portfolio and /dashboard where the same data also renders
 * in full. Renders nothing (zero height) only when the wallet is disconnected,
 * the portfolio is still on its first load, or there are no open positions.
 *
 * Perf: `usePortfolio` is a genuinely expensive hook — full market discovery,
 * a batched `getMultipleAccountsInfo`, and up to two `getProgramAccounts` scans
 * per market. Showing the strip alongside a page that already mounts its own
 * `usePortfolio()` (portfolio: 1, dashboard: 4, trade's PositionsDock: 1) does
 * NOT multiply that cost: `usePortfolio` is fronted by a wallet-keyed dedup
 * layer (`loadPortfolioShared` — 12s TTL cache + in-flight join) that collapses
 * every mounted instance into ONE scan cycle, so the strip's scan coalesces
 * with the page's rather than duplicating it.
 */
export function PositionsBar() {
  const { connected: walletConnected } = useWalletCompat();
  const mockMode = isMockMode();

  const usingMockData = mockMode && !walletConnected;
  // Deduped across the app (loadPortfolioShared) — mounting this alongside a
  // page that already runs its own usePortfolio() joins that scan rather than
  // firing a second one, so showing the strip everywhere costs one book scan.
  const portfolio = usePortfolio(walletConnected);

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
  const openPositions = useMemo(() => positions
    .filter((pos) => (pos.account?.positionSize ?? 0n) !== 0n)
    .sort((a, b) => (notionalOf(b) > notionalOf(a) ? 1 : notionalOf(b) < notionalOf(a) ? -1 : 0)), [positions]);

  // Collateral decimals per mint (all playground markets use 6-decimal
  // sim-USDC; resolved properly anyway, matching the portfolio page).
  const positionMints = useMemo(() => openPositions.map((pos) => pos.collateralMint), [openPositions]);
  const tokenMetaMap = useMultiTokenMeta(positionMints);

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
    // No poll when there's nothing to watch or the book is mock (mock slabs
    // aren't on-chain accounts).
    if (!slabKey || usingMockData) return;
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
    // Visibility-gated: this bar mounts app-wide, so a hidden tab would
    // otherwise keep batch-reading every position slab forever.
    const dispose = pollWhenVisible(poll, ONCHAIN_POLL_MS);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [connection, slabKey, usingMockData]);

  // ── Overflow affordance ──────────────────────────────────────────────────
  // The chip row scrolls horizontally when the book is wider than the viewport
  // (scrollbar is hidden for a clean strip). Without a cue, off-screen chips are
  // undiscoverable — so show a fading edge + a click-to-scroll arrow on whichever
  // side has more content. `overflow.{left,right}` track which arrows to render.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 1px slack absorbs sub-pixel rounding so the arrow doesn't flicker at the ends.
    const left = el.scrollLeft > 1;
    const right = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // Recompute on viewport resize (ResizeObserver) and whenever the set of chips
  // changes (the openPositions.length dep) — both change whether the row overflows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateOverflow, openPositions.length]);

  const scrollByArrow = useCallback((dir: -1 | 1) => {
    scrollRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });
  }, []);

  if ((!walletConnected && !mockPositions) || openPositions.length === 0) return null;

  return (
    <div
      className="sticky top-14 z-40 flex items-center border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-md"
      data-testid="positions-bar"
    >
      <span className="shrink-0 select-none border-r border-[var(--border)] px-3 py-1 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
        Positions
      </span>
      <div className="relative min-w-0 flex-1">
        {/* Left fade + scroll-back arrow — only when there's content to the left. */}
        {overflow.left && (
          <button
            type="button"
            onClick={() => scrollByArrow(-1)}
            aria-label="Scroll positions left"
            className="absolute inset-y-0 left-0 z-10 flex w-9 items-center justify-start bg-gradient-to-r from-[var(--bg)] via-[var(--bg)]/85 to-transparent pl-1 text-[13px] leading-none text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
          >
            <span aria-hidden>‹</span>
          </button>
        )}
        <div
          ref={scrollRef}
          onScroll={updateOverflow}
          className="flex items-center overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {openPositions.map((pos, i) => (
            <PositionChip
              key={`${pos.slabAddress}-${pos.idx ?? i}`}
              pos={pos}
              decimals={tokenMetaMap.get(pos.collateralMint.toBase58())?.decimals ?? 6}
            />
          ))}
        </div>
        {/* Right fade + scroll-forward arrow — only when there's more off-screen. */}
        {overflow.right && (
          <button
            type="button"
            onClick={() => scrollByArrow(1)}
            aria-label="Scroll positions right"
            className="absolute inset-y-0 right-0 z-10 flex w-9 items-center justify-end bg-gradient-to-l from-[var(--bg)] via-[var(--bg)]/85 to-transparent pr-1 text-[13px] leading-none text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
          >
            <span aria-hidden>›</span>
          </button>
        )}
      </div>
    </div>
  );
}
