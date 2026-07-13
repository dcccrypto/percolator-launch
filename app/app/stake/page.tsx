"use client";

import { useEffect, useState, useCallback, useSyncExternalStore, type CSSProperties } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Connection } from "@solana/web3.js";
import {
  deriveStakePool,
  deriveDepositPda,
} from "@percolatorct/sdk";
import { STAKE_POOL_SIZE_V1, decodeStakePoolV1 } from "@/hooks/useStakePool";
import { getConfig } from "@/lib/config";
import { unpackAccount, getMint } from "@solana/spl-token";
import { useStakeDepositByPool } from "@/hooks/useStakeDepositByPool";
import { useStakeWithdrawByPool } from "@/hooks/useStakeWithdrawByPool";
import { InDevelopmentBanner } from "@/components/InDevelopmentBanner";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { formatMarkPrice } from "@/lib/format";
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
  /** Decimals of the LP mint — needed to parse partial withdraw amounts */
  lpDecimals: number;
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

/**
 * Browser-safe u64 LE reader. Buffer.readBigUInt64LE relies on Node's Buffer
 * BigInt methods, which this bundle's Buffer polyfill doesn't reliably
 * provide in the browser (see the same DataView-based fix already used in
 * useStakePool.ts / useLpPositions.ts). DataView.getBigUint64 is a native
 * browser API and works on any Buffer/Uint8Array.
 */
function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, /* littleEndian= */ true);
}

/* ── Live Price ── */

/**
 * Live-ticking USD price for a pool's underlying market slab, subscribed to
 * the shared price store (the same WS feed the trade/markets pages tick off)
 * — mirrors the `LiveRowPrice` pattern in app/markets/page.tsx. Isolated as
 * its own component so ticks re-render only this price cell, not the whole
 * card/panel.
 */
function LivePoolPrice({
  slab,
  className,
  style,
}: {
  slab: string;
  className?: string;
  style?: CSSProperties;
}) {
  const subscribe = useCallback((cb: () => void) => subscribeSlab(slab, cb), [slab]);
  const getSnap = useCallback(() => getSnapshot(slab).priceUsd, [slab]);
  const priceUsd = useSyncExternalStore(subscribe, getSnap, () => null);
  return (
    <span className={className} style={style}>
      {formatMarkPrice(priceUsd)}
    </span>
  );
}

/* ── Position Detection ── */

/**
 * Fetch a single pool's staked-LP position for a wallet: LP balance (raw +
 * human, using the LP mint's real decimals — never assumed), redemption
 * cooldown status, and estimated USD value. Returns null when the pool has
 * no on-chain StakePool account yet, or the wallet holds zero LP for it.
 *
 * Shared by the multi-pool scan (`StakePage`'s effect below, feeds
 * `YourPositionPanel`) and the per-selected-pool Withdraw tab
 * (`DepositWidget`) so both read the exact same on-chain detection logic
 * instead of two hand-rolled copies that could silently drift apart. Never
 * throws — all failures resolve to `null` so a scan across many pools can't
 * be aborted by one bad account.
 */
async function fetchPoolPosition(
  pool: StakePool,
  publicKey: PublicKey,
  connection: Connection,
  stakeProgramId: PublicKey,
): Promise<UserPosition | null> {
  if (!pool.slabAddress || !pool.collateralMint) return null;
  try {
    const slabPk = new PublicKey(pool.slabAddress);
    const [poolPda] = deriveStakePool(slabPk, stakeProgramId);
    const [depositPdaAddress] = deriveDepositPda(poolPda, publicKey, stakeProgramId);

    // Fetch pool account to get lpMint. Decode using the REAL deployed
    // 352-byte v1 layout — NOT the SDK's decodeStakePool, which assumes
    // a 384-byte v2 layout that was never deployed here (see
    // STAKE_POOL_SIZE_V1 comment in useStakePool.ts).
    const poolInfo = await connection.getAccountInfo(poolPda);
    if (!poolInfo || poolInfo.data.length < STAKE_POOL_SIZE_V1) return null;
    const { lpMint } = decodeStakePoolV1(poolInfo.data);

    // Get user LP ATA balance
    const userLpAta = getAssociatedTokenAddressSync(lpMint, publicKey);
    const lpAtaInfo = await connection.getAccountInfo(userLpAta);
    if (!lpAtaInfo) return null;
    const lpAccount = unpackAccount(userLpAta, lpAtaInfo);
    if (lpAccount.amount === 0n) return null;

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
    // pool.totalLpSupply is raw (on-chain units); divide by 10^lpDecimals
    // to match lpBalance which is already human-readable.
    const lpSupplyHuman = pool.totalLpSupply / Math.pow(10, lpDecimals);
    const estimatedValue = lpSupplyHuman > 0
      ? (lpBalance / lpSupplyHuman) * pool.tvl
      : 0;

    // Fetch deposit PDA for cooldown info
    let cooldownRemaining = 0;
    let cooldownElapsed = true;
    let userDepositSlot = 0n;

    const depInfo = await connection.getAccountInfo(depositPdaAddress);
    if (depInfo && depInfo.data.length >= 81) {
      const depData = depInfo.data;
      if (depData[0] === 1) {
        userDepositSlot = readU64LE(depData, 72);
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

    return {
      poolId: pool.id,
      poolName: pool.name,
      slabAddress: pool.slabAddress,
      collateralMint: pool.collateralMint,
      lpBalance,
      lpBalanceRaw: lpAccount.amount,
      lpDecimals,
      estimatedValue,
      cooldownRemaining,
      cooldownTotal: pool.cooldownSlots,
      cooldownElapsed,
    };
  } catch (err) {
    console.error("[fetchPoolPosition] Failed for pool:", pool.slabAddress, err);
    return null;
  }
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
          {/* Two-pane hero: heading/CTA/banner on the left, metrics on the
              right (stacks to a single column below lg). */}
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_380px] lg:items-center lg:gap-12">
            {/* Left pane */}
            <div className="min-w-0">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // insurance lp
              </div>
              <h1
                className="mb-4 text-4xl font-bold tracking-tight sm:text-[36px] lg:text-[64px]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <span className="text-[var(--text)]">Stake. Earn.</span>
                <br />
                <span className="text-[var(--cyan)]">Back the Fund.</span>
              </h1>
              <p className="mb-6 max-w-[520px] text-sm leading-[1.6] text-[var(--text-secondary)]">
                Deposit collateral into insurance pools to back the Percolator insurance fund.
              </p>

              {/* CTA buttons */}
              <div className="mb-6 flex flex-wrap items-center gap-3">
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

              <div className="max-w-[640px]">
                <InDevelopmentBanner>
                  Staking backs the insurance fund and withdrawals work, but there&apos;s no yield
                  distribution on the deployed program — <span className="text-[var(--text)]">APR is
                  genuinely 0%</span>, and flushes to insurance reduce staked value. Experimental, not a
                  yield product.
                </InDevelopmentBanner>
              </div>
            </div>

            {/* Right pane: metrics */}
            <div className="w-full shrink-0 lg:w-[380px]">
              <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
                {metrics.map((m) => (
                  <div key={m.label} className="min-w-0 overflow-hidden bg-[var(--panel-bg)] p-3 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                    <p className="mb-1.5 truncate text-[9px] font-medium uppercase tracking-[0.15em] text-[#9ca3af] sm:text-[10px] sm:tracking-[0.2em]">{m.label}</p>
                    <p className={`truncate text-2xl font-bold tracking-tight tabular-nums ${m.color}`} style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                      {m.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

/* ── Your Position Panel ── */

/**
 * A single staked-LP position with its own withdraw controls. Split out from
 * YourPositionPanel (S-M1 fix) so each pool position gets its own
 * useStakeWithdrawByPool hook instance — Rules of Hooks means a single
 * component can't call the hook once per array entry, so multi-pool display
 * requires one component instance per position.
 */
function PositionCard({
  position,
  onWithdrawSuccess,
  onManage,
}: {
  position: UserPosition;
  onWithdrawSuccess?: () => void;
  /** Hands off to DepositWidget's Withdraw tab, pre-selected to this pool —
   *  see the "Manage / Withdraw Partial" button below. */
  onManage?: (poolId: string) => void;
}) {
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useStakeWithdrawByPool({
    slabAddress: position.slabAddress,
    collateralMint: position.collateralMint,
  });

  const [txStatus, setTxStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const handleWithdraw = useCallback(async () => {
    if (!position.cooldownElapsed) return;
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
            <p className="font-medium text-[var(--text)]">{position.poolName}</p>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">LP Balance</span>
            <p className="font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {position.lpBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} LP
            </p>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Est. Value</span>
            <p className="font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
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
          <ProgressBar value={cooldownPct} height={8} fillClassName="bg-gradient-to-r from-blue-500 to-[var(--cyan)]" />
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

        {/* Action buttons */}
        <div className="space-y-2">
          {/* Withdraw button — all-or-nothing, full LP balance */}
          <button
            disabled={!position.cooldownElapsed || withdrawLoading}
            onClick={handleWithdraw}
            className={`w-full rounded-md py-2.5 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
              position.cooldownElapsed && !withdrawLoading
                ? "border border-[var(--cyan)]/50 bg-[var(--cyan)]/[0.10] text-[var(--cyan)] hover:border-[var(--cyan)] hover:bg-[var(--cyan)]/[0.18]"
                : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-secondary)] cursor-not-allowed"
            }`}
          >
            {withdrawLoading
              ? "Withdrawing…"
              : position.cooldownElapsed
              ? "Withdraw LP →"
              : `Withdraw in ${position.cooldownRemaining.toLocaleString()} slots`}
          </button>

          {/* Manage / Withdraw Partial — jumps to DepositWidget's Withdraw
              tab pre-selected to this pool, for a partial (not all-or-nothing)
              withdrawal. */}
          <button
            type="button"
            onClick={() => onManage?.(position.poolId)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all duration-200 hover:border-[var(--accent)]/30 hover:text-[var(--accent)]"
          >
            Manage / Withdraw Partial
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * S-M1 fix: renders one PositionCard per pool the wallet holds a balance in.
 * Previously this component received a single `position` that StakePage's
 * scan effect stopped populating after the FIRST pool with a non-zero
 * balance — multi-pool stakers had every other position silently dropped
 * from both the UI and totalUserDeposited.
 */
function YourPositionPanel({
  positions,
  onWithdrawSuccess,
  onManage,
}: {
  positions: UserPosition[];
  onWithdrawSuccess?: () => void;
  /** Threaded through to each PositionCard's "Manage / Withdraw Partial"
   *  button — see PositionCard for what it does. */
  onManage?: (poolId: string) => void;
}) {
  const { connected } = useWalletCompat();

  if (!connected) return null;
  if (positions.length === 0) {
    return (
      <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-6 text-center">
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">No open positions</p>
        <p className="mt-1 text-[10px] text-[var(--text-secondary)]">Deposit into a pool to get started</p>
        <a
          href="#deposit"
          className="mt-3 inline-block text-[11px] font-medium text-[var(--accent)] transition-colors hover:text-[var(--text)]"
        >
          Deposit Now →
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {positions.map((position) => (
        <PositionCard key={position.poolId} position={position} onWithdrawSuccess={onWithdrawSuccess} onManage={onManage} />
      ))}
    </div>
  );
}

/* ── Deposit Widget ── */

function DepositWidget({
  pools,
  onTxSuccess,
  selectedPool,
  setSelectedPool,
  mode,
  setMode,
}: {
  pools: StakePool[];
  onTxSuccess?: () => void;
  /** Lifted to StakePage (rather than local state) so a PositionCard's
   *  "Manage / Withdraw Partial" button can jump here pre-selected to a
   *  specific pool + withdraw mode instead of leaving the user to find it
   *  themselves via the dropdown below. */
  selectedPool: string;
  setSelectedPool: (poolId: string) => void;
  mode: "deposit" | "withdraw";
  setMode: (mode: "deposit" | "withdraw") => void;
}) {
  const { connected, publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [amount, setAmount] = useState("");
  const [walletBalanceRaw, setWalletBalanceRaw] = useState<bigint | null>(null);
  const [balanceDecimals, setBalanceDecimals] = useState(6);
  const [txStatus, setTxStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawPosition, setWithdrawPosition] = useState<UserPosition | null>(null);
  const [withdrawPositionLoading, setWithdrawPositionLoading] = useState(false);
  const [withdrawRefreshKey, setWithdrawRefreshKey] = useState(0);
  const [withdrawTxStatus, setWithdrawTxStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const pool = pools.find((p) => p.id === selectedPool) ?? pools[0];
  const amountNum = parseFloat(amount) || 0;
  const withdrawAmountNum = parseFloat(withdrawAmount) || 0;

  // Bug #12: the Junior (first-loss) tranche selector was removed — DepositJunior
  // (tag 16, PERC-303) belongs to the 384-byte v2 StakePool program, which hasn't
  // been deployed to this devnet vault program (still 352-byte v1, no tag-16
  // handler). Senior deposit is the only path the deployed program supports.
  // See the warning atop useStakeDepositJunior.ts.
  const { deposit, loading: depositLoading, error: depositError } = useStakeDepositByPool({
    slabAddress: pool?.slabAddress ?? "",
    collateralMint: pool?.collateralMint ?? "",
  });

  // Withdraw for the currently SELECTED pool — same tx builder YourPositionPanel
  // uses, just parameterized by whichever pool is picked in the dropdown here
  // instead of the single globally-detected "first pool with a balance" position.
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useStakeWithdrawByPool({
    slabAddress: pool?.slabAddress ?? "",
    collateralMint: pool?.collateralMint ?? "",
  });

  // Sync selectedPool when pools list loads
  useEffect(() => {
    if (pools.length > 0 && !pools.find((p) => p.id === selectedPool)) {
      setSelectedPool(pools[0].id);
    }
  }, [pools, selectedPool, setSelectedPool]);

  // Reset both amount inputs whenever the selected pool or mode changes —
  // now that selectedPool/mode are lifted to the parent (so PositionCard's
  // "Manage" button can jump here), a stale amount from a previous pool/tab
  // must not silently carry over into a different pool's deposit/withdraw.
  useEffect(() => {
    setAmount("");
    setWithdrawAmount("");
  }, [selectedPool, mode]);

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

  // Fetch the selected pool's staked-LP position for the Withdraw tab. Reuses
  // fetchPoolPosition — the exact same on-chain detection the multi-pool scan
  // in StakePage uses (which feeds YourPositionPanel) — applied to just the
  // currently-selected pool instead of scanning all pools for the first match.
  useEffect(() => {
    if (!connected || !publicKey || !pool?.slabAddress) {
      setWithdrawPosition(null);
      return;
    }
    let cancelled = false;
    setWithdrawPositionLoading(true);
    (async () => {
      try {
        // Stake pools are owned by this deployment's vault program
        // (getConfig().vaultProgramId), NOT the SDK's default stake program id.
        const stakeProgramId = new PublicKey(
          (getConfig() as { vaultProgramId?: string }).vaultProgramId
          ?? "51CeUNpbXovK2BRADPyssuf3Q1xWGabEK9pYkp5mqVhQ"
        );
        const found = await fetchPoolPosition(pool, publicKey, connection, stakeProgramId);
        if (!cancelled) setWithdrawPosition(found);
      } catch (err) {
        console.error("[DepositWidget] Failed to fetch withdraw position:", err);
        if (!cancelled) setWithdrawPosition(null);
      } finally {
        if (!cancelled) setWithdrawPositionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connected, publicKey, pool, connection, withdrawRefreshKey]);

  // Human-readable balance (null = unknown / not fetched)
  const walletBalance: number | null = walletBalanceRaw !== null
    ? Number(walletBalanceRaw) / Math.pow(10, balanceDecimals)
    : null;

  // LP token estimate: lp_out = (amount / pool_value) * total_lp_supply
  // When pool is empty (first depositor), LP tokens = deposit amount (1:1 ratio).
  // totalLpSupply from API is raw (6 decimals), so divide to get human-readable.
  const lpSupplyHuman = pool ? pool.totalLpSupply / 1e6 : 0;
  const lpEstimate = pool
    ? pool.vaultBalance > 0 && lpSupplyHuman > 0
      ? (amountNum / pool.vaultBalance) * lpSupplyHuman
      : amountNum // First depositor: 1:1 ratio
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
      onTxSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTxStatus({ type: "error", msg });
    }
  }, [pool, amount, balanceDecimals, deposit, depositLoading, onTxSuccess]);

  const handleWithdraw = useCallback(async () => {
    if (!pool || !withdrawPosition || withdrawLoading) return;
    if (!withdrawPosition.cooldownElapsed) return;
    setWithdrawTxStatus(null);
    try {
      // String-based BigInt parsing (same approach as Deposit) to avoid float
      // precision loss, using the LP mint's real decimals from fetchPoolPosition.
      const rawAmount = parseHumanAmount(withdrawAmount, withdrawPosition.lpDecimals);
      if (rawAmount <= 0n || rawAmount > withdrawPosition.lpBalanceRaw) return;
      const sig = await withdraw(rawAmount);
      setWithdrawAmount("");
      setWithdrawTxStatus({ type: "success", msg: `Withdrawal confirmed: ${sig.slice(0, 8)}…` });
      setWithdrawRefreshKey((k) => k + 1);
      onTxSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWithdrawTxStatus({ type: "error", msg });
    }
  }, [pool, withdrawPosition, withdrawAmount, withdraw, withdrawLoading, onTxSuccess]);

  return (
    <div id="deposit" className="border border-[var(--border)]/50 bg-[var(--panel-bg)]">
      <div className="px-4 py-2 border-b border-[var(--border)]/30 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">// {mode}</span>
        {pool && (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {pool.symbol}
            <LivePoolPrice slab={pool.slabAddress} className="text-[var(--cyan)]" />
          </span>
        )}
      </div>
      <div className="p-4 space-y-4">
        {/* Deposit / Withdraw toggle */}
        <div className="flex gap-1 border border-[var(--border)] p-0.5">
          <button
            type="button"
            onClick={() => { setMode("deposit"); setTxStatus(null); setWithdrawTxStatus(null); }}
            className={`flex-1 rounded-sm py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              mode === "deposit"
                ? "bg-[var(--accent)]/[0.12] text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text)]"
            }`}
          >
            Deposit
          </button>
          <button
            type="button"
            onClick={() => { setMode("withdraw"); setTxStatus(null); setWithdrawTxStatus(null); }}
            className={`flex-1 rounded-sm py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              mode === "withdraw"
                ? "bg-[var(--cyan)]/[0.12] text-[var(--cyan)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text)]"
            }`}
          >
            Withdraw
          </button>
        </div>

        {/* Pool selector — shared between Deposit and Withdraw modes */}
        <div>
          <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Select Pool</label>
          <select
            value={selectedPool}
            onChange={(e) => { setSelectedPool(e.target.value); setTxStatus(null); setWithdrawTxStatus(null); }}
            className="w-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 text-[13px] text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]/50"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {pools.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {mode === "deposit" ? (
          <>
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
                  className="flex-1 border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)]/50 tabular-nums"
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

              {/* Percentage chips */}
              {connected && walletBalance !== null && walletBalance > 0 && (
                <div className="mt-2 flex gap-1.5">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        const val = (walletBalance * pct) / 100;
                        setAmount(val.toFixed(2));
                        setTxStatus(null);
                      }}
                      className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--bg)] py-1 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent)]"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* LP estimate */}
            {amountNum > 0 && (
              <div className="text-[12px] text-[var(--text-secondary)]">
                You will receive ≈{" "}
                <span className="font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
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
                    {pool.capTotal > 0
                      ? `${formatUsd(pool.capUsed)} / ${formatUsd(pool.capTotal)} (${Math.round(capRatio * 100)}%)`
                      : `${formatUsd(pool.capUsed)} deposited · No cap`}
                  </span>
                </div>
                <ProgressBar value={capRatio} height={6} fillClassName="bg-gradient-to-r from-[var(--accent)]/60 to-[var(--accent)]" />
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
              <button className="w-full rounded-md py-3 border border-[var(--border)] bg-[var(--bg)] text-[12px] font-semibold uppercase tracking-[0.1em] text-[var(--text-secondary)] cursor-not-allowed">
                Connect Wallet to Deposit
              </button>
            ) : (
              <button
                disabled={amountNum <= 0 || depositLoading}
                onClick={handleDeposit}
                className={`w-full rounded-md py-3 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
                  amountNum > 0 && !depositLoading
                    ? "border border-[var(--accent)]/50 bg-[var(--accent)]/[0.10] text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.18]"
                    : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-secondary)] cursor-not-allowed"
                }`}
              >
                {depositLoading ? "Depositing…" : "Deposit →"}
              </button>
            )}
          </>
        ) : (
          <>
            {/* Withdraw amount input */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Amount</label>
                {connected && withdrawPosition && (
                  <button
                    type="button"
                    onClick={() => setWithdrawAmount(formatHumanAmount(withdrawPosition.lpBalanceRaw, withdrawPosition.lpDecimals))}
                    className="text-[10px] text-[var(--text-muted)] tabular-nums transition-colors hover:text-[var(--accent)] cursor-pointer"
                    style={{ fontFamily: "var(--font-mono)" }}
                    title="Click to use full staked balance"
                  >
                    Staked: {withdrawPosition.lpBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} LP
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={withdrawAmount}
                  onChange={(e) => { setWithdrawAmount(e.target.value); setWithdrawTxStatus(null); }}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  disabled={!withdrawPosition}
                  className="flex-1 border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)]/50 tabular-nums disabled:opacity-50"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
                <button
                  type="button"
                  onClick={() => { if (withdrawPosition) setWithdrawAmount(formatHumanAmount(withdrawPosition.lpBalanceRaw, withdrawPosition.lpDecimals)); }}
                  disabled={!withdrawPosition}
                  className="border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  MAX
                </button>
              </div>

              {/* Percentage chips */}
              {connected && withdrawPosition && withdrawPosition.lpBalance > 0 && (
                <div className="mt-2 flex gap-1.5">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        const val = (withdrawPosition.lpBalance * pct) / 100;
                        setWithdrawAmount(val.toFixed(4));
                        setWithdrawTxStatus(null);
                      }}
                      className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--bg)] py-1 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--cyan)]/30 hover:text-[var(--cyan)]"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Empty / loading state */}
            {withdrawPositionLoading && (
              <p className="text-[11px] text-[var(--text-muted)]">Checking staked balance…</p>
            )}
            {!withdrawPositionLoading && connected && !withdrawPosition && (
              <p className="text-[11px] text-[var(--text-muted)]">No staked balance in this pool.</p>
            )}

            {/* Cooldown status */}
            {withdrawPosition && (
              <p className={`text-[10px] ${withdrawPosition.cooldownElapsed ? "text-[var(--text-muted)]" : "text-[var(--short)]"}`}>
                {withdrawPosition.cooldownElapsed
                  ? "Cooldown complete — ready to withdraw."
                  : `Cooldown: ~${withdrawPosition.cooldownRemaining.toLocaleString()} slots (${slotsToTime(withdrawPosition.cooldownRemaining)}) remaining.`}
              </p>
            )}

            {/* Tx feedback */}
            {withdrawTxStatus && (
              <p className={`text-[11px] ${withdrawTxStatus.type === "success" ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
                {withdrawTxStatus.msg}
              </p>
            )}
            {withdrawError && !withdrawTxStatus && (
              <p className="text-[11px] text-[var(--short)]">{withdrawError}</p>
            )}

            {/* CTA */}
            {!connected ? (
              <button className="w-full rounded-md py-3 border border-[var(--border)] bg-[var(--bg)] text-[12px] font-semibold uppercase tracking-[0.1em] text-[var(--text-secondary)] cursor-not-allowed">
                Connect Wallet to Withdraw
              </button>
            ) : (
              <button
                disabled={!withdrawPosition || !withdrawPosition.cooldownElapsed || withdrawAmountNum <= 0 || withdrawLoading}
                onClick={handleWithdraw}
                className={`w-full rounded-md py-3 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
                  withdrawPosition && withdrawPosition.cooldownElapsed && withdrawAmountNum > 0 && !withdrawLoading
                    ? "border border-[var(--cyan)]/50 bg-[var(--cyan)]/[0.10] text-[var(--cyan)] hover:border-[var(--cyan)] hover:bg-[var(--cyan)]/[0.18]"
                    : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-secondary)] cursor-not-allowed"
                }`}
              >
                {withdrawLoading
                  ? "Withdrawing…"
                  : !withdrawPosition
                  ? "Nothing to Withdraw"
                  : !withdrawPosition.cooldownElapsed
                  ? `Withdraw in ${withdrawPosition.cooldownRemaining.toLocaleString()} slots`
                  : "Withdraw →"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Pool Card ── */

function PoolCard({ pool }: { pool: StakePool }) {
  const capRatio = pool.capTotal > 0 ? pool.capUsed / pool.capTotal : 0;

  return (
    <article className="group relative border border-[var(--border)] bg-[var(--panel-bg)] p-4 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)] hover:border-[var(--border-hover)]">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] text-[12px]">
            💧
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[13px] font-semibold text-[var(--text)]">{pool.symbol}</h3>
            <p className="text-[10px] text-[var(--text-muted)]">POOL</p>
          </div>
        </div>
        <LivePoolPrice
          slab={pool.slabAddress}
          className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-[var(--text)] tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        />
      </div>

      <div className="space-y-2 text-[12px]">
        <div className="flex justify-between">
          <span className="text-[var(--text-secondary)]">TVL</span>
          <span className="font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{formatUsd(pool.tvl)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-secondary)]">APR</span>
          <span className="font-semibold text-[var(--cyan)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{pool.apr.toFixed(2)}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-secondary)]">Cap</span>
          <span className="text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {pool.capTotal > 0 ? `${Math.round(capRatio * 100)}% full` : "No cap"}
          </span>
        </div>
        <div className="flex justify-between gap-x-2">
          <span className="shrink-0 text-[var(--text-secondary)]">Cooldown</span>
          <span className="text-right text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{pool.cooldownSlots.toLocaleString()} slots ({slotsToTime(pool.cooldownSlots)})</span>
        </div>
      </div>

      {/* Cap bar */}
      <div className="mt-3">
        <ProgressBar value={capRatio} height={4} fillClassName="bg-gradient-to-r from-[var(--accent)]/60 to-[var(--accent)]" />
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

/** Subtle grid filler so an odd pool count doesn't leave a dangling empty
 *  cell in the last row of the (now capped at 2-col) pools grid — points at
 *  market creation instead of being dead space. */
function PoolPlaceholderCard() {
  return (
    <a
      href="/create"
      className="group flex flex-col items-center justify-center gap-2 border border-dashed border-[var(--border)] bg-[var(--panel-bg)]/40 p-4 text-center transition-colors duration-200 hover:border-[var(--accent)]/40 hover:bg-[var(--bg-elevated)] sm:p-5"
    >
      <span className="text-2xl text-[var(--text-muted)] transition-colors group-hover:text-[var(--accent)]">＋</span>
      <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors group-hover:text-[var(--accent)]">
        Create a market
      </p>
      <p className="text-[10px] text-[var(--text-muted)]">More pools coming →</p>
    </a>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] lg:grid-cols-2">
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
        <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">No pools available yet</p>
        <p className="mt-1 text-[10px] text-[var(--text-secondary)]">Check back soon.</p>
      </div>
    );
  }

  // Bug #850 (extended) + clipping fix: the pools column lives in a
  // lg:grid-cols-[380px_1fr] layout inside a max-w-[1100px] page, leaving only
  // ~696px for pools at lg+. The old xl:grid-cols-3 needed 3 columns to fit,
  // which overflowed that width and clipped the right column (including the
  // live price) — capped at 2 columns everywhere fixes that. A pool count
  // that isn't even still leaves a dangling empty cell in the last row, so
  // top up to the next even count with a subtle placeholder card instead of
  // leaving dead grid space.
  const fillerCount = pools.length >= 2 ? (2 - (pools.length % 2)) % 2 : 0;

  return (
    <section id="pools">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">// available pools</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] lg:grid-cols-2">
        {pools.map((pool) => (
          <PoolCard key={pool.id} pool={pool} />
        ))}
        {Array.from({ length: fillerCount }).map((_, i) => (
          <PoolPlaceholderCard key={`filler-${i}`} />
        ))}
      </div>
    </section>
  );
}

/* ── Main Page ── */

export default function StakePage() {
  const [pools, setPools] = useState<StakePool[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  // S-M1 fix: ALL positions the wallet holds across pools, not just the first
  // one found.
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [positionRefreshKey, setPositionRefreshKey] = useState(0);
  const [poolsRefreshKey, setPoolsRefreshKey] = useState(0);

  // Lifted (rather than local to DepositWidget) so a PositionCard's
  // "Manage / Withdraw Partial" button can drive both from StakePage.
  const [selectedPool, setSelectedPool] = useState("");
  const [widgetMode, setWidgetMode] = useState<"deposit" | "withdraw">("deposit");

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
  }, [poolsRefreshKey]);

  // Fetch user positions from on-chain data when wallet connected + pools loaded.
  // S-M1 fix: scan ALL pools and aggregate every position the wallet holds —
  // previously this returned after the FIRST pool with a non-zero balance
  // ("found a position, stop scanning"), so a wallet staked in 2+ pools had
  // every position after the first silently dropped from "Your Position" and
  // from totalUserDeposited. Fetches concurrently and aggregates via
  // Promise.allSettled, mirroring useLpPositions.ts.
  useEffect(() => {
    if (!connected || !publicKey || pools.length === 0) {
      setPositions([]);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        // Stake pools are owned by this deployment's vault program
        // (getConfig().vaultProgramId), NOT the SDK's default stake program id.
        const stakeProgramId = new PublicKey(
          (getConfig() as { vaultProgramId?: string }).vaultProgramId
          ?? "51CeUNpbXovK2BRADPyssuf3Q1xWGabEK9pYkp5mqVhQ"
        );
        // Check every pool for user's LP position — same detection logic the
        // Withdraw tab uses for a single selected pool (fetchPoolPosition).
        // allSettled: one bad pool/RPC hiccup must not blank out the rest.
        const results = await Promise.allSettled(
          pools.map((pool) => fetchPoolPosition(pool, publicKey, connection, stakeProgramId)),
        );
        if (cancelled) return;
        const found = results
          .filter((r): r is PromiseFulfilledResult<UserPosition | null> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((p): p is UserPosition => p !== null);
        setPositions(found);
      } catch (err) {
        console.error("[StakePage] Failed to fetch user positions:", err);
        if (!cancelled) setPositions([]);
      }
    })();

    return () => { cancelled = true; };
  }, [connected, publicKey, pools, connection, positionRefreshKey]);

  const handleTxSuccess = useCallback(() => {
    // Re-fetch both the user's LP position and pool-level TVL/cap data after
    // deposit/withdraw. Without refreshing pools, successful deposits can leave
    // pool cards showing stale TVL until the user manually reloads.
    setPositionRefreshKey((k) => k + 1);
    setPoolsRefreshKey((k) => k + 1);

    // RPC/indexer reads can lag just after confirmation, so do one follow-up
    // refresh to catch the settled vault balance without requiring a reload.
    window.setTimeout(() => setPoolsRefreshKey((k) => k + 1), 2_000);
  }, []);

  // S-M1 fix: sum across ALL positions, not just a single (possibly-missing) one.
  const totalUserDeposited = positions.length > 0
    ? positions.reduce((sum, p) => sum + p.estimatedValue, 0)
    : connected ? 0 : null;

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
                <YourPositionPanel
                  positions={positions}
                  onWithdrawSuccess={handleTxSuccess}
                  onManage={(poolId) => {
                    setSelectedPool(poolId);
                    setWidgetMode("withdraw");
                    document.getElementById("deposit")?.scrollIntoView({ behavior: "smooth" });
                  }}
                />
              </ErrorBoundary>
              <ErrorBoundary label="Deposit Widget">
                <DepositWidget
                  pools={pools}
                  onTxSuccess={handleTxSuccess}
                  selectedPool={selectedPool}
                  setSelectedPool={setSelectedPool}
                  mode={widgetMode}
                  setMode={setWidgetMode}
                />
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
