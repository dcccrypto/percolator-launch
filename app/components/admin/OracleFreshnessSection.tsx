"use client";

import { useState, useEffect, useCallback } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { useAdminActions } from "@/hooks/useAdminActions";
import type { DiscoveredMarket } from "@percolatorct/sdk";

// ─── Style tokens ──────────────────────────────────────────────────────────────
const card = "rounded-none bg-[var(--panel-bg)] border border-[var(--border)]";
const labelStyle =
  "text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]";

/** Keeper wallet — the permanent oracle authority for devnet auto-price-push */
const KEEPER_WALLET = "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x";
/** Default devnet price to push ($1.00 = 1_000_000 e6) */
const DEFAULT_PRICE_E6 = "1000000";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={labelStyle}>{children}</div>
      <div className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

interface StaleMarket {
  slab_address: string;
  symbol: string | null;
  oracle_authority: string | null;
  mark_price: number | null;
  total_accounts: number | null;
  open_interest_long: number | null;
  open_interest_short: number | null;
  last_updated_at: string | null;
}

function truncatePk(pk: string, chars = 6) {
  if (!pk || pk.length <= chars * 2) return pk;
  return `${pk.slice(0, chars)}…${pk.slice(-4)}`;
}

// ─── Row with action buttons ───────────────────────────────────────────────────

function OracleStaleRow({
  market,
  canAct,
  onPushPrice,
  onDelegateToKeeper,
  busy,
}: {
  market: StaleMarket;
  canAct: boolean;
  onPushPrice?: (m: StaleMarket) => void;
  onDelegateToKeeper?: (m: StaleMarket) => void;
  busy: boolean;
}) {
  const totalOI =
    (market.open_interest_long ?? 0) + (market.open_interest_short ?? 0);
  const hasOI = totalOI > 0;
  const users = market.total_accounts ?? 0;

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-4 py-3 border-b border-[var(--border)] last:border-0">
      {/* Market identity */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span
            className="inline-block w-[6px] h-[6px] rounded-full shrink-0"
            style={{ backgroundColor: "var(--short)" }}
          />
          <span className="text-[12px] font-mono text-white font-medium">
            {market.symbol && market.symbol.length <= 10
              ? `${market.symbol}`
              : truncatePk(market.slab_address)}
          </span>
          <span
            className="text-[9px] font-bold uppercase px-1.5 py-0.5 border"
            style={{ borderColor: "var(--short)", color: "var(--short)" }}
          >
            NO PRICE
          </span>
          {hasOI && (
            <span
              className="text-[9px] font-bold uppercase px-1.5 py-0.5 border"
              style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
            >
              USERS STUCK
            </span>
          )}
        </div>
        <div className="text-[10px] text-[var(--text-dim)] font-mono">
          {truncatePk(market.slab_address, 8)}
        </div>
        {market.oracle_authority && (
          <div className="text-[10px] text-[var(--text-dim)] flex items-center gap-1">
            <span className="text-[var(--text-dim)]">authority:</span>
            <span className="font-mono text-[var(--cyan)]">
              {truncatePk(market.oracle_authority)}
            </span>
          </div>
        )}
        {/* Action buttons for markets where connected wallet is the authority */}
        {canAct && (
          <div className="flex items-center gap-2 mt-1.5">
            <button
              onClick={() => onPushPrice?.(market)}
              disabled={busy}
              className="text-[9px] uppercase tracking-wider px-2 py-1 border border-[var(--long)] text-[var(--long)] hover:bg-[var(--long)] hover:text-black transition-colors disabled:opacity-40 font-mono"
            >
              {busy ? "…" : "push $1"}
            </button>
            <button
              onClick={() => onDelegateToKeeper?.(market)}
              disabled={busy}
              className="text-[9px] uppercase tracking-wider px-2 py-1 border border-[var(--cyan)] text-[var(--cyan)] hover:bg-[var(--cyan)] hover:text-black transition-colors disabled:opacity-40 font-mono"
            >
              {busy ? "…" : "→ keeper"}
            </button>
          </div>
        )}
      </div>

      {/* Users */}
      <div className="text-center">
        <div
          className="text-[16px] font-bold tabular-nums"
          style={{
            fontFamily: "var(--font-jetbrains-mono)",
            color: users > 0 ? "var(--warning)" : "var(--text-dim)",
          }}
        >
          {users}
        </div>
        <div className="text-[9px] uppercase tracking-wider text-[var(--text-dim)]">
          users
        </div>
      </div>

      {/* OI (raw) */}
      <div className="text-center">
        <div
          className="text-[12px] font-mono tabular-nums"
          style={{ color: hasOI ? "var(--text-secondary)" : "var(--text-dim)" }}
        >
          {hasOI
            ? (totalOI / 1e9).toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })
            : "—"}
        </div>
        <div className="text-[9px] uppercase tracking-wider text-[var(--text-dim)]">
          OI (e9)
        </div>
      </div>

      {/* Copy slab */}
      <div>
        <button
          onClick={() =>
            navigator.clipboard.writeText(market.slab_address).catch(() => {})
          }
          className="text-[9px] uppercase tracking-wider px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors font-mono"
          title="Copy slab address"
        >
          copy
        </button>
      </div>
    </div>
  );
}

// ─── Batch action result ───────────────────────────────────────────────────────

interface BatchResult {
  slab: string;
  symbol: string | null;
  status: "ok" | "err";
  detail: string;
}

/**
 * OracleFreshnessSection
 *
 * Fetches all admin-oracle markets from /api/markets and shows those with
 * mark_price = null sorted by user count desc.
 *
 * If a wallet is connected and is the oracle_authority for any stale market,
 * it shows per-market "Push $1" and "→ Keeper" action buttons, plus a
 * "Fix All My Markets" batch button.
 */
export function OracleFreshnessSection() {
  const wallet = useWalletCompat();
  const walletAddr = wallet.publicKey?.toBase58() ?? "";

  // On-chain discovered markets (needed for programId + pushPrice/setOracleAuthority)
  const { markets: discoveredMarkets } = useMarketDiscovery();
  const { pushPrice, setOracleAuthority } = useAdminActions();

  const [staleMarkets, setStaleMarkets] = useState<StaleMarket[]>([]);
  const [loadingFetch, setLoadingFetch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // Batch action state
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [singleBusy, setSingleBusy] = useState<string | null>(null); // slab_address

  const fetchStaleMarkets = useCallback(async () => {
    setLoadingFetch(true);
    setError(null);
    try {
      const res = await fetch("/api/markets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      const raw: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as { markets?: unknown[] }).markets)
        ? (data as { markets: unknown[] }).markets
        : [];

      // Filter: has oracle_authority (admin-mode) AND no mark_price
      const stale = (raw as StaleMarket[])
        .filter(
          (m) =>
            m.oracle_authority &&
            m.oracle_authority !== "" &&
            (m.mark_price === null || m.mark_price === undefined || m.mark_price === 0)
        )
        .sort((a, b) => (b.total_accounts ?? 0) - (a.total_accounts ?? 0));

      setStaleMarkets(stale);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFetch(false);
    }
  }, []);

  useEffect(() => {
    fetchStaleMarkets();
  }, [fetchStaleMarkets]);

  // Markets where connected wallet IS the oracle_authority
  const myMarkets = walletAddr
    ? staleMarkets.filter((m) => m.oracle_authority === walletAddr)
    : [];

  const withUsers = staleMarkets.filter((m) => (m.total_accounts ?? 0) > 0);
  const withoutUsers = staleMarkets.filter((m) => (m.total_accounts ?? 0) === 0);

  // Find on-chain DiscoveredMarket for a slab address (needed for actions)
  function getDiscovered(slabAddress: string): DiscoveredMarket | undefined {
    return discoveredMarkets.find(
      (dm) => dm.slabAddress.toBase58() === slabAddress
    );
  }

  async function handlePushPrice(m: StaleMarket) {
    const dm = getDiscovered(m.slab_address);
    if (!dm) {
      setBatchResults((r) => [
        ...r,
        { slab: m.slab_address, symbol: m.symbol, status: "err", detail: "Market not discovered on-chain yet, retry in 30s" },
      ]);
      return;
    }
    setSingleBusy(m.slab_address);
    try {
      // pushPrice always throws (removed on-chain in beta.29); catch below handles it.
      const sig = await pushPrice(dm, DEFAULT_PRICE_E6) as string | undefined;
      setBatchResults((r) => [
        ...r,
        { slab: m.slab_address, symbol: m.symbol, status: "ok", detail: sig?.slice(0, 20) + "…" },
      ]);
      // Optimistically remove from stale list
      setStaleMarkets((prev) => prev.filter((x) => x.slab_address !== m.slab_address));
    } catch (err) {
      setBatchResults((r) => [
        ...r,
        { slab: m.slab_address, symbol: m.symbol, status: "err", detail: err instanceof Error ? err.message.slice(0, 80) : String(err) },
      ]);
    } finally {
      setSingleBusy(null);
    }
  }

  async function handleDelegateToKeeper(m: StaleMarket) {
    const dm = getDiscovered(m.slab_address);
    if (!dm) {
      setBatchResults((r) => [
        ...r,
        { slab: m.slab_address, symbol: m.symbol, status: "err", detail: "Market not discovered on-chain yet, retry in 30s" },
      ]);
      return;
    }
    setSingleBusy(m.slab_address);
    try {
      // setOracleAuthority always throws (removed on-chain in beta.29); catch below handles it.
      const sig = await setOracleAuthority(dm, KEEPER_WALLET) as string | undefined;
      setBatchResults((r) => [
        ...r,
        { slab: m.slab_address, symbol: m.symbol, status: "ok", detail: `→ keeper: ${sig?.slice(0, 20)}…` },
      ]);
      setStaleMarkets((prev) => prev.filter((x) => x.slab_address !== m.slab_address));
    } catch (err) {
      setBatchResults((r) => [
        ...r,
        { slab: m.slab_address, symbol: m.symbol, status: "err", detail: err instanceof Error ? err.message.slice(0, 80) : String(err) },
      ]);
    } finally {
      setSingleBusy(null);
    }
  }

  async function handleBatchFixAll() {
    if (!myMarkets.length || batchRunning) return;
    setBatchRunning(true);
    setBatchResults([]);
    for (const m of myMarkets) {
      // Prefer delegation to keeper so price auto-updates going forward
      await handleDelegateToKeeper(m);
    }
    setBatchRunning(false);
    // Refresh after batch
    await fetchStaleMarkets();
  }

  return (
    <div className="mb-8">
      <SectionHeader>Oracle Freshness Check</SectionHeader>

      {/* Summary banner */}
      <div className={`${card} p-4 mb-4`}>
        <div className="flex flex-wrap gap-6 items-center justify-between">
          <div className="flex gap-6">
            <div>
              <div
                className="text-[24px] font-bold tabular-nums"
                style={{
                  fontFamily: "var(--font-jetbrains-mono)",
                  color: staleMarkets.length > 0 ? "var(--short)" : "var(--long)",
                }}
              >
                {loadingFetch ? "…" : staleMarkets.length}
              </div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
                admin markets w/o price
              </div>
            </div>
            <div>
              <div
                className="text-[24px] font-bold tabular-nums"
                style={{
                  fontFamily: "var(--font-jetbrains-mono)",
                  color: withUsers.length > 0 ? "var(--warning)" : "var(--long)",
                }}
              >
                {loadingFetch ? "…" : withUsers.length}
              </div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
                with trapped users
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {lastFetched && (
              <span className="text-[10px] text-[var(--text-dim)] font-mono">
                {lastFetched.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={fetchStaleMarkets}
              disabled={loadingFetch}
              className="text-[10px] uppercase tracking-[0.15em] px-3 py-1.5 border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
            >
              {loadingFetch ? "refreshing…" : "refresh"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 text-[11px] text-[var(--short)]">
            ✗ Failed to load: {error}
          </div>
        )}
        {!loadingFetch && !error && staleMarkets.length === 0 && (
          <div className="mt-3 text-[11px] text-[var(--long)]">
            ✓ All admin-oracle markets have a price pushed. No action needed.
          </div>
        )}
      </div>

      {/* ── MY MARKETS (wallet-aware batch fix) ──────────────────────────── */}
      {walletAddr && myMarkets.length > 0 && (
        <div className={`${card} overflow-hidden mb-4`} style={{ borderColor: "var(--long)" }}>
          <div className="border-b px-4 py-3 flex items-center justify-between gap-3" style={{ borderColor: "var(--long)" }}>
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-[6px] h-[6px] rounded-full"
                style={{ backgroundColor: "var(--long)" }}
              />
              <span className={labelStyle}>
                {myMarkets.length} of your market{myMarkets.length !== 1 ? "s" : ""} need price — fix now
              </span>
            </div>
            <button
              onClick={handleBatchFixAll}
              disabled={batchRunning || !wallet.signTransaction}
              className="text-[10px] uppercase tracking-[0.15em] px-3 py-1.5 border font-bold transition-colors disabled:opacity-40"
              style={{
                borderColor: "var(--cyan)",
                color: "var(--cyan)",
              }}
            >
              {batchRunning ? "fixing…" : `delegate all ${myMarkets.length} → keeper`}
            </button>
          </div>
          <div>
            {myMarkets.map((m) => (
              <OracleStaleRow
                key={m.slab_address}
                market={m}
                canAct={!!wallet.signTransaction}
                onPushPrice={handlePushPrice}
                onDelegateToKeeper={handleDelegateToKeeper}
                busy={batchRunning || singleBusy === m.slab_address}
              />
            ))}
          </div>
          <div className="border-t border-[var(--border)] px-4 py-3 bg-[rgba(0,255,136,0.02)]">
            <p className="text-[10px] text-[var(--text-dim)]">
              <strong className="text-[var(--long)]">Delegate → Keeper</strong> transfers oracle
              authority to {truncatePk(KEEPER_WALLET)} so prices auto-update going forward.{" "}
              <strong className="text-[var(--long)]">Push $1</strong> sets a one-time $1.00 devnet
              price immediately (authority stays with you).
            </p>
          </div>

          {/* Batch results */}
          {batchResults.length > 0 && (
            <div className="border-t border-[var(--border)] px-4 py-3 space-y-1">
              {batchResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px] font-mono">
                  <span style={{ color: r.status === "ok" ? "var(--long)" : "var(--short)" }}>
                    {r.status === "ok" ? "✓" : "✗"}
                  </span>
                  <span className="text-[var(--text-secondary)]">{r.symbol ?? truncatePk(r.slab)}</span>
                  <span className="text-[var(--text-dim)] truncate">{r.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Wallet prompt when there are stale markets but no wallet ──────── */}
      {!walletAddr && withUsers.length > 0 && (
        <div className={`${card} p-4 mb-4 border-[var(--warning)]`}>
          <p className="text-[11px] text-[var(--warning)]">
            ⚠ Connect your wallet to see and fix markets where you are the oracle authority.
          </p>
        </div>
      )}

      {/* ── Markets with trapped users — all (highest priority) ───────────── */}
      {withUsers.length > 0 && (
        <div className={`${card} overflow-hidden mb-4`}>
          <div className="border-b border-[var(--border)] px-4 py-3 flex items-center gap-2">
            <span
              className="inline-block w-[6px] h-[6px] rounded-full"
              style={{ backgroundColor: "var(--warning)" }}
            />
            <span className={labelStyle}>
              {withUsers.length} market{withUsers.length !== 1 ? "s" : ""} with users — action required
            </span>
          </div>
          <div>
            {withUsers.map((m) => (
              <OracleStaleRow
                key={m.slab_address}
                market={m}
                canAct={walletAddr === m.oracle_authority && !!wallet.signTransaction}
                onPushPrice={handlePushPrice}
                onDelegateToKeeper={handleDelegateToKeeper}
                busy={batchRunning || singleBusy === m.slab_address}
              />
            ))}
          </div>
          <div className="border-t border-[var(--border)] px-4 py-3 bg-[rgba(255,183,0,0.03)]">
            <p className="text-[10px] text-[var(--text-dim)]">
              Each market's oracle authority must connect their wallet here and click{" "}
              <strong className="text-[var(--cyan)]">→ keeper</strong> or{" "}
              <strong className="text-[var(--long)]">push $1</strong> to unblock their users.
              Keeper wallet:{" "}
              <span className="font-mono text-[var(--cyan)]">{truncatePk(KEEPER_WALLET, 8)}</span>
            </p>
          </div>
        </div>
      )}

      {/* ── Markets without users — lower priority ────────────────────────── */}
      {withoutUsers.length > 0 && (
        <div className={`${card} overflow-hidden`}>
          <div className="border-b border-[var(--border)] px-4 py-3">
            <span className={labelStyle}>
              {withoutUsers.length} uninitialised market
              {withoutUsers.length !== 1 ? "s" : ""} (no users)
            </span>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {withoutUsers.map((m) => (
              <OracleStaleRow
                key={m.slab_address}
                market={m}
                canAct={walletAddr === m.oracle_authority && !!wallet.signTransaction}
                onPushPrice={handlePushPrice}
                onDelegateToKeeper={handleDelegateToKeeper}
                busy={batchRunning || singleBusy === m.slab_address}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
