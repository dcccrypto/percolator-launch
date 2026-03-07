"use client";

import { useEffect, useState, useCallback } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  deriveStakePool,
  deriveDepositPda,
  STAKE_POOL_SIZE,
  decodeStakePool,
} from "@percolator/sdk";
import { unpackAccount, getMint } from "@solana/spl-token";
import { useStakeDepositByPool } from "@/hooks/useStakeDepositByPool";
import { useStakeWithdrawByPool } from "@/hooks/useStakeWithdrawByPool";
import { parseHumanAmount } from "@/lib/parseAmount";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

/* ── Types ── */

interface StakePool {
  id: string;
  name: string;
  symbol: string;
  slabAddress: string;
  /** SPL mint for pool collateral (USDC). Used to query wallet ATA balance. */
  collateralMint?: string;
  tvl: number;
  apr: number;
  capUsed: number;
  capTotal: number;
  cooldownSlots: number;
  totalLpSupply: number;
  vaultBalance: number;
}

interface UserPosition {
  poolId: string;
  poolName: string;
  slabAddress: string;
  collateralMint: string;
  /** User's LP token balance (in tokens, not raw) */
  lpBalance: number;
  lpBalanceRaw: bigint;
  estimatedValue: number;
  cooldownRemaining: number;
  cooldownTotal: number;
  cooldownElapsed: boolean;
}

/** Shape returned by /api/stake/pools */
interface ApiPool {
  poolAddress: string;
  slabAddress: string;
  collateralMint: string;
  lpMint: string;
  vault: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  tvl: number;
  tvlRaw: string;
  poolValue: number;
  apr: number;
  capTotal: number;
  capTotalRaw: string;
  capUsed: number;
  capUsedRaw: string;
  cooldownSlots: number;
  totalLpSupply: number;
  vaultBalance: number;
  poolMode: number;
  adminTransferred: boolean;
}

/** Convert API pool shape to the page-local StakePool type. */
function apiPoolToStakePool(p: ApiPool): StakePool {
  return {
    id: p.poolAddress,
    name: p.name,
    symbol: p.symbol,
    slabAddress: p.slabAddress,
    collateralMint: p.collateralMint,
    tvl: p.tvl,
    apr: p.apr,
    capUsed: p.capUsed,
    capTotal: p.capTotal,
    cooldownSlots: p.cooldownSlots,
    totalLpSupply: p.totalLpSupply,
    vaultBalance: p.vaultBalance,
  };
}

/* ── Helpers ── */

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function slotsToTime(slots: number): string {
  const seconds = Math.round(slots * 0.4);
  if (seconds < 60) return `~${seconds}s`;
  return `~${Math.round(seconds / 60)} min`;
}

/* ── Hero Section ── */

function StakeHero({ pools, totalUserDeposited }: { pools: StakePool[]; totalUserDeposited: number | null }) {
  const { connected } = useWalletCompat();
  const totalStaked = pools.reduce((s, p) => s + p.tvl, 0);
  const activePools = pools.length;
  const avgApr = pools.length > 0
    ? pools.reduce((s, p) => s + p.apr, 0) / pools.length
    : 0;

  const yourDepositsLabel = !connected
    ? "Connect wallet"
    : totalUserDeposited === null
    ? "Loading..."
    : totalUserDeposited > 0
    ? formatUsd(totalUserDeposited)
    : "$—";

  const metrics = [
    { label: "Total Staked", value: formatUsd(totalStaked), color: "text-[var(--accent)]" },
    {
      label: "Your Deposits",
      value: yourDepositsLabel,
      color: connected && totalUserDeposited !== null ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)] text-[11px]",
    },
    { label: "Active Pools", value: String(activePools), color: "text-[var(--accent)]" },
    { label: "Avg APR", value: avgApr > 0 ? `${avgApr.toFixed(1)}%` : "—%", color: "text-[var(--cyan)]" },
  ];

  return (
    <section className="relative overflow-hidden py-12 lg:py-16">
      <div className="mx-auto max-w-[1100px] px-6">
        <ScrollReveal>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // insurance lp
          </div>
          <h1
            className="mb-4 text-3xl font-medium tracking-[-0.02em] sm:text-4xl lg:text-[56px]"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            <span className="text-white">Stake. Earn.</span>
            <br />
            <span className="text-[var(--cyan)]">Back the Fund.</span>
          </h1>
          <p className="mb-8 max-w-[520px] text-base leading-[1.6] text-[var(--text-secondary)]">
            Deposit collateral into insurance pools to earn LP rewards and back the Percolator insurance fund.
          </p>

          {/* CTA buttons */}
          <div className="mb-10 flex flex-wrap items-center gap-3">
            <a
              href="#deposit"
              className="group inline-flex items-center gap-2 rounded-md bg-violet-700 px-6 py-3 text-sm font-semibold text-white transition-all duration-200 hover:bg-violet-600"
            >
              Deposit Now
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:translate-y-0.5">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </a>
            <a
              href="#pools"
              className="inline-flex items-center gap-1 text-[14px] font-medium text-[var(--cyan)] border-b border-[var(--cyan)]/40 pb-px transition-colors hover:border-[var(--cyan)]/70"
            >
              Learn More <span aria-hidden="true">→</span>
            </a>
          </div>

          {/* Metrics row */}
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] md:grid-cols-4">
            {metrics.map((m) => (
              <div key={m.label} className="min-w-0 overflow-hidden bg-[var(--panel-bg)] p-3 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                <p className="mb-1.5 truncate text-[9px] font-medium uppercase tracking-[0.15em] text-[#9ca3af] sm:text-[10px] sm:tracking-[0.2em]">{m.label}</p>
                <p className={`truncate text-base font-semibold tracking-tight tabular-nums sm:text-xl ${m.color}`} style={{ fontFamily: "var(--font-heading)" }}>
                  {m.value}
                </p>
              </div>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

/* ── Your Position Panel ── */

function YourPositionPanel({
  position,
  onWithdrawSuccess,
}: {
  position: UserPosition | null;
  onWithdrawSuccess?: () => void;
}) {
  const { connected } = useWalletCompat();

  const { withdraw, loading: withdrawLoading, error: withdrawError } = useStakeWithdrawByPool({
    slabAddress: position?.slabAddress ?? "",
    collateralMint: position?.collateralMint ?? "",
  });

  const [txStatus, setTxStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const handleWithdraw = useCallback(async () => {
    if (!position || !position.cooldownElapsed) return;
    setTxStatus(null);
    try {
      const sig = await withdraw(position.lpBalanceRaw);
      setTxStatus({ type: "success", msg: `Withdrawal confirmed: ${sig.slice(0, 8)}…` });
      onWithdrawSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTxStatus({ type: "error", msg });
    }
  }, [withdraw, position, onWithdrawSuccess]);

  if (!connected) return null;
  if (!position) {
    return (
      <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-6 text-center">
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">No open positions</p>
        <p className="mt-1 text-[10px] text-[var(--text-dim)]">Deposit into a pool to get started</p>
        <a
          href="#deposit"
          className="mt-3 inline-block text-[11px] font-medium text-[var(--accent)] transition-colors hover:text-white"
        >
          Deposit Now →
        </a>
      </div>
    );
  }

  const cooldownPct = position.cooldownTotal > 0
    ? 1 - position.cooldownRemaining / position.cooldownTotal
    : 1;

  return (
    <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)]">
      <div className="px-4 py-2 border-b border-[var(--border)]/30">
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">// your position</span>
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <div>
            <span className="text-[var(--text-secondary)]">Pool</span>
            <p className="font-medium text-white">{position.poolName}</p>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">LP Balance</span>
            <p className="font-medium text-white tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {position.lpBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} LP
            </p>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Est. Value</span>
            <p className="font-medium text-white tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {formatUsd(position.estimatedValue)}
            </p>
          </div>
        </div>

        {/* Cooldown */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-[var(--text-secondary)]">Cooldown</span>
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {position.cooldownElapsed
                ? "Complete ✓"
                : `~${position.cooldownRemaining.toLocaleString()} slots (${slotsToTime(position.cooldownRemaining)})`
              }
            </span>
          </div>
          <ProgressBar value={cooldownPct} height={8} />
        </div>

        {/* Tx feedback */}
        {txStatus && (
          <p className={`text-[11px] ${txStatus.type === "success" ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
            {txStatus.msg}
          </p>
        )}
        {withdrawError && !txStatus && (
          <p className="text-[11px] text-[var(--short)]">{withdrawError}</p>
        )}

        {/* Withdraw button */}
        <button
          disabled={!position.cooldownElapsed || withdrawLoading}
          onClick={handleWithdraw}
          className={`w-full rounded-md py-2.5 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
            position.cooldownElapsed && !withdrawLoading
              ? "border border-[var(--cyan)]/50 bg-[var(--cyan)]/[0.10] text-[var(--cyan)] hover:border-[var(--cyan)] hover:bg-[var(--cyan)]/[0.18]"
              : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] cursor-not-allowed"
          }`}
        >
          {withdrawLoading
            ? "Withdrawing…"
            : position.cooldownElapsed
            ? "Withdraw LP →"
            : `Withdraw in ${position.cooldownRemaining.toLocaleString()} slots`}
        </button>
      </div>
    </div>
  );
}

/* ── Deposit Widget ── */

function DepositWidget({
  pools,
  onDepositSuccess,
}: {
  pools: StakePool[];
  onDepositSuccess?: () => void;
}) {
  const { connected, publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [selectedPool, setSelectedPool] = useState(pools[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [walletBalanceRaw, setWalletBalanceRaw] = useState<bigint | null>(null);
  const [balanceDecimals, setBalanceDecimals] = useState(6);
  const [txStatus, setTxStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const pool = pools.find((p) => p.id === selectedPool) ?? pools[0];
  const amountNum = parseFloat(amount) || 0;

  const { deposit, loading: depositLoading, error: depositError } = useStakeDepositByPool({
    slabAddress: pool?.slabAddress ?? "",
    collateralMint: pool?.collateralMint ?? "",
  });

  // Sync selectedPool when pools list loads
  useEffect(() => {
    if (pools.length > 0 && !pools.find((p) => p.id === selectedPool)) {
      setSelectedPool(pools[0].id);
    }
  }, [pools, selectedPool]);

  // Fetch real SPL token balance for the selected pool's collateral mint
  useEffect(() => {
    if (!publicKey || !pool?.collateralMint) { setWalletBalanceRaw(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const mint = new PublicKey(pool.collateralMint!);
        const ata = getAssociatedTokenAddressSync(mint, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        if (!cancelled) {
          setWalletBalanceRaw(BigInt(info.value.amount));
          setBalanceDecimals(info.value.decimals ?? 6);
        }
      } catch { if (!cancelled) setWalletBalanceRaw(null); }
    })();
    return () => { cancelled = true; };
  }, [publicKey, pool?.collateralMint, connection]);

  // Human-readable balance (null = unknown / not fetched)
  const walletBalance: number | null = walletBalanceRaw !== null
    ? Number(walletBalanceRaw) / Math.pow(10, balanceDecimals)
    : null;

  // LP token estimate: lp_out = (amount / pool_value) * total_lp_supply
  const lpEstimate = pool && pool.vaultBalance > 0
    ? (amountNum / pool.vaultBalance) * pool.totalLpSupply
    : 0;

  const capRatio = pool && pool.capTotal > 0 ? pool.capUsed / pool.capTotal : 0;

  const handleDeposit = useCallback(async () => {
    if (!pool || depositLoading) return;
    setTxStatus(null);
    try {
      // Use string-based BigInt parsing to avoid float precision loss at large amounts.
      const rawAmount = parseHumanAmount(amount, balanceDecimals);
      if (rawAmount <= 0n) return;
      const sig = await deposit(rawAmount);
      setAmount("");
      setTxStatus({ type: "success", msg: `Deposit confirmed: ${sig.slice(0, 8)}…` });
      onDepositSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTxStatus({ type: "error", msg });
    }
  }, [pool, amount, balanceDecimals, deposit, depositLoading, onDepositSuccess]);

  return (
    <div id="deposit" className="border border-[var(--border)]/50 bg-[var(--panel-bg)]">
      <div className="px-4 py-2 border-b border-[var(--border)]/30">
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">// deposit</span>
      </div>
      <div className="p-4 space-y-4">
        {/* Pool selector */}
        <div>
          <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Select Pool</label>
          <select
            value={selectedPool}
            onChange={(e) => { setSelectedPool(e.target.value); setTxStatus(null); }}
            className="w-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 text-[13px] text-white outline-none transition-colors focus:border-[var(--accent)]/50"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {pools.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Amount input */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Amount</label>
            {connected && walletBalance !== null && (
              <button
                type="button"
                onClick={() => setAmount(String(walletBalance))}
                className="text-[10px] text-[var(--text-muted)] tabular-nums transition-colors hover:text-[var(--accent)] cursor-pointer"
                style={{ fontFamily: "var(--font-mono)" }}
                title="Click to use max balance"
              >
                Balance: {walletBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setTxStatus(null); }}
              placeholder="0.00"
              min="0"
              step="any"
              className="flex-1 border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 text-[13px] text-white placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)]/50 tabular-nums"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <button
              type="button"
              onClick={() => { if (walletBalance !== null && walletBalance > 0) setAmount(String(walletBalance)); }}
              className="border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent)]"
            >
              MAX
            </button>
          </div>
        </div>

        {/* LP estimate */}
        {amountNum > 0 && (
          <div className="text-[12px] text-[var(--text-secondary)]">
            You will receive ≈{" "}
            <span className="font-medium text-white tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {lpEstimate.toLocaleString(undefined, { maximumFractionDigits: 4 })} LP
            </span>
          </div>
        )}

        {/* Pool cap bar */}
        {pool && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-[var(--text-secondary)]">Pool cap</span>
              <span className="text-[10px] text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                {formatUsd(pool.capUsed)} / {formatUsd(pool.capTotal)} ({Math.round(capRatio * 100)}%)
              </span>
            </div>
            <ProgressBar value={capRatio} height={6} />
          </div>
        )}

        {/* Cooldown info */}
        {pool && (
          <p className="text-[10px] text-[var(--text-muted)]">
            Cooldown period: ~{pool.cooldownSlots.toLocaleString()} slots ({slotsToTime(pool.cooldownSlots)} before withdrawal)
          </p>
        )}

        {/* Tx feedback */}
        {txStatus && (
          <p className={`text-[11px] ${txStatus.type === "success" ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
            {txStatus.msg}
          </p>
        )}
        {depositError && !txStatus && (
          <p className="text-[11px] text-[var(--short)]">{depositError}</p>
        )}

        {/* CTA */}
        {!connected ? (
          <button className="w-full rounded-md py-3 border border-[var(--border)] bg-[var(--bg)] text-[12px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)] cursor-not-allowed">
            Connect Wallet to Deposit
          </button>
        ) : (
          <button
            disabled={amountNum <= 0 || depositLoading}
            onClick={handleDeposit}
            className={`w-full rounded-md py-3 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
              amountNum > 0 && !depositLoading
                ? "border border-[var(--accent)]/50 bg-[var(--accent)]/[0.10] text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.18]"
                : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] cursor-not-allowed"
            }`}
          >
            {depositLoading ? "Depositing…" : "Deposit →"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Pool Card ── */

function PoolCard({ pool }: { pool: StakePool }) {
  const capRatio = pool.capTotal > 0 ? pool.capUsed / pool.capTotal : 0;

  return (
    <article className="group relative border border-[var(--border)] bg-[var(--panel-bg)] p-4 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)] hover:border-[var(--border-hover)] min-w-[280px]">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] text-[12px]">
            💧
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-white">{pool.symbol}</h3>
            <p className="text-[10px] text-[var(--text-muted)]">POOL</p>
          </div>
        </div>
      </div>

      <div className="space-y-2 text-[12px]">
        <div className="flex justify-between">
          <span className="text-[var(--text-secondary)]">TVL</span>
          <span className="font-medium text-white tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{formatUsd(pool.tvl)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-secondary)]">APR</span>
          <span className="font-semibold text-[var(--cyan)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{pool.apr.toFixed(1)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-secondary)]">Cap</span>
          <span className="text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{Math.round(capRatio * 100)}% full</span>
        </div>
        <div className="flex justify-between gap-x-2">
          <span className="shrink-0 text-[var(--text-secondary)]">Cooldown</span>
          <span className="text-right text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{pool.cooldownSlots.toLocaleString()} slots ({slotsToTime(pool.cooldownSlots)})</span>
        </div>
      </div>

      {/* Cap bar */}
      <div className="mt-3">
        <ProgressBar value={capRatio} height={4} />
      </div>

      {/* Deposit ghost button */}
      <a
        href="#deposit"
        className="mt-4 flex w-full items-center justify-center gap-1.5 border border-[var(--accent)]/30 bg-transparent py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/[0.06]"
      >
        Deposit
      </a>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-[var(--accent)]/0 transition-all duration-300 group-hover:bg-[var(--accent)]/30" />
    </article>
  );
}

/* ── Pool List Section ── */

function PoolList({ pools, loading }: { pools: StakePool[]; loading: boolean }) {
  if (loading) {
    return (
      <section id="pools">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">// available pools</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] lg:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-[var(--panel-bg)] p-4 sm:p-5 space-y-3">
              <div className="flex items-center gap-2.5 mb-4">
                <ShimmerSkeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-1.5">
                  <ShimmerSkeleton className="h-3 w-20" />
                  <ShimmerSkeleton className="h-2.5 w-10" />
                </div>
              </div>
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="flex justify-between">
                  <ShimmerSkeleton className="h-3 w-16" />
                  <ShimmerSkeleton className="h-3 w-20" />
                </div>
              ))}
              <ShimmerSkeleton className="h-1 w-full mt-3" />
              <ShimmerSkeleton className="h-8 w-full mt-2" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (pools.length === 0) {
    return (
      <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
        <div className="mb-3 text-2xl text-[var(--text-muted)]">💧</div>
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">No pools available yet</p>
        <p className="mt-1 text-[10px] text-[var(--text-dim)]">Check back soon.</p>
      </div>
    );
  }

  return (
    <section id="pools">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">// available pools</span>
      </div>
      {/* Bug #850: only use xl:grid-cols-3 when there are ≥ 3 pools; with fewer, stay at lg:grid-cols-2
           to avoid ghost empty card slots filling the grid background */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] lg:grid-cols-2 ${pools.length >= 3 ? "xl:grid-cols-3" : ""}`}>
        {pools.map((pool) => (
          <PoolCard key={pool.id} pool={pool} />
        ))}
      </div>
    </section>
  );
}

/* ── Main Page ── */

export default function StakePage() {
  const [pools, setPools] = useState<StakePool[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [position, setPosition] = useState<UserPosition | null>(null);
  const [positionRefreshKey, setPositionRefreshKey] = useState(0);

  const { connected, publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();

  // Fetch live pool data from API
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/stake/pools");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { pools: ApiPool[] };
        if (!cancelled) setPools((json.pools ?? []).map(apiPoolToStakePool));
      } catch (err) {
        console.error("[StakePage] Failed to fetch pools:", err);
      } finally {
        if (!cancelled) setPoolsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch user position from on-chain data when wallet connected + pools loaded
  useEffect(() => {
    if (!connected || !publicKey || pools.length === 0) {
      setPosition(null);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        // Check each pool for user's LP position
        for (const pool of pools) {
          if (!pool.slabAddress || !pool.collateralMint) continue;
          try {
            const slabPk = new PublicKey(pool.slabAddress);
            const [poolPda] = deriveStakePool(slabPk);
            const [depositPdaAddress] = deriveDepositPda(poolPda, publicKey);

            // Fetch pool account to get lpMint using canonical StakePool layout
            const poolInfo = await connection.getAccountInfo(poolPda);
            if (!poolInfo || poolInfo.data.length < STAKE_POOL_SIZE) continue;
            const { lpMint } = decodeStakePool(Buffer.from(poolInfo.data));

            // Get user LP ATA balance
            const userLpAta = getAssociatedTokenAddressSync(lpMint, publicKey);
            const lpAtaInfo = await connection.getAccountInfo(userLpAta);
            if (!lpAtaInfo) continue;
            const lpAccount = unpackAccount(userLpAta, lpAtaInfo);
            if (lpAccount.amount === 0n) continue;

            // Derive decimals from on-chain LP mint rather than assuming 6.
            // Wrapped in its own try/catch: a transient RPC error must not gate
            // position discovery — lpAccount.amount already confirmed the position exists.
            let lpDecimals = 6; // safe default
            try {
              const lpMintInfo = await getMint(connection, lpMint);
              lpDecimals = lpMintInfo.decimals;
            } catch {
              // RPC failure: fall back to default decimals; position is still shown
            }
            const lpBalance = Number(lpAccount.amount) / Math.pow(10, lpDecimals);

            // Calculate estimated value: (user_lp / total_lp_supply) * vault_balance
            const estimatedValue = pool.totalLpSupply > 0
              ? (lpBalance / pool.totalLpSupply) * pool.tvl
              : 0;

            // Fetch deposit PDA for cooldown info
            let cooldownRemaining = 0;
            let cooldownElapsed = true;
            let userDepositSlot = 0n;

            const depInfo = await connection.getAccountInfo(depositPdaAddress);
            if (depInfo && depInfo.data.length >= 81) {
              const depData = Buffer.from(depInfo.data);
              if (depData[0] === 1) {
                userDepositSlot = depData.readBigUInt64LE(65);
              }
            }

            if (userDepositSlot > 0n && pool.cooldownSlots > 0) {
              try {
                const currentSlot = BigInt(await connection.getSlot());
                const slotsElapsed = currentSlot - userDepositSlot;
                const cooldownTotal = BigInt(pool.cooldownSlots);
                if (slotsElapsed < cooldownTotal) {
                  cooldownElapsed = false;
                  cooldownRemaining = Number(cooldownTotal - slotsElapsed);
                }
              } catch {
                cooldownElapsed = false;
              }
            }

            if (!cancelled) {
              setPosition({
                poolId: pool.id,
                poolName: pool.name,
                slabAddress: pool.slabAddress,
                collateralMint: pool.collateralMint!,
                lpBalance,
                lpBalanceRaw: lpAccount.amount,
                estimatedValue,
                cooldownRemaining,
                cooldownTotal: pool.cooldownSlots,
                cooldownElapsed,
              });
            }
            return; // found a position, stop scanning
          } catch {
            // skip pool on error
          }
        }
        // No position found across all pools
        if (!cancelled) setPosition(null);
      } catch (err) {
        console.error("[StakePage] Failed to fetch user position:", err);
        if (!cancelled) setPosition(null);
      }
    })();

    return () => { cancelled = true; };
  }, [connected, publicKey, pools, connection, positionRefreshKey]);

  const handleTxSuccess = useCallback(() => {
    // Re-fetch position after deposit/withdraw
    setPositionRefreshKey((k) => k + 1);
  }, []);

  const totalUserDeposited = position ? position.estimatedValue : connected ? 0 : null;

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* Hero */}
      <ErrorBoundary label="Stake Hero">
        <StakeHero pools={pools} totalUserDeposited={totalUserDeposited} />
      </ErrorBoundary>

      {/* Main content */}
      <div className="mx-auto max-w-[1100px] px-6 pb-16">
        <ScrollReveal>
          {/* Mobile: single-column stack (position → deposit → pools) */}
          {/* Desktop lg+: 2-column — sidebar [380px] on left, pools on right */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
            {/* Left column: Position + Deposit — full-width on mobile, sidebar on lg+ */}
            {/* pb-24 on mobile ensures deposit widget clears the fixed bottom nav (56px) */}
            <div className="space-y-4 pb-24 lg:pb-0">
              <ErrorBoundary label="Your Position">
                <YourPositionPanel position={position} onWithdrawSuccess={handleTxSuccess} />
              </ErrorBoundary>
              <ErrorBoundary label="Deposit Widget">
                <DepositWidget pools={pools} onDepositSuccess={handleTxSuccess} />
              </ErrorBoundary>
            </div>

            {/* Right column: Pool list — stacks below on mobile, sidebar on lg+ */}
            {/* pb-24 on mobile clears the fixed bottom nav (56px + safe-area) */}
            <div className="min-w-0 pb-24 lg:pb-0">
              <ErrorBoundary label="Pool List">
                <PoolList pools={pools} loading={poolsLoading} />
              </ErrorBoundary>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
