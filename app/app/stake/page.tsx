"use client";

import { STAKE_COPY, cooldownDuration } from "@/lib/stake-copy";
import { useStakeCooldown } from "@/hooks/useStakeCooldown";
import { useEffect, useState, useCallback, useSyncExternalStore, type CSSProperties } from "react";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
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
import { readPoolTotalLpSupply, stakeWithdrawChipAmount, valueStakePosition, withdrawAmountError } from "@/lib/stake-position";
import { useStakeDepositByPool } from "@/hooks/useStakeDepositByPool";
import { useStakeWithdrawByPool } from "@/hooks/useStakeWithdrawByPool";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";
import { formatTokenAmount } from "@/lib/format";
import { checkDepositAmount, depositAmountMessage } from "@/lib/deposit-guard";
import { orderStakePools, stakedOrderValue } from "@/lib/stake-pool-order";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { formatMarkPrice } from "@/lib/format";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { MarketLogo } from "@/components/market/MarketLogo";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import Link from "next/link";
import { FeeBreakdown } from "@/components/FeeBreakdown";
import { ConnectWalletCta } from "@/components/wallet/ConnectWalletCta";

/* ── Types ── */

interface StakePool {
  id: string;
  name: string;
  symbol: string;
  slabAddress: string;
  logoUrl?: string | null;
  /** Underlying token mint (for the token logo) — from PLAYGROUND_SLAB_META. */
  mainnetCa?: string;
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
    logoUrl: p.logoUrl,
    mainnetCa: PLAYGROUND_SLAB_META[p.slabAddress]?.mainnet_ca,
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
 * cooldown status, and estimated USD value. Returns null ONLY for a confirmed
 * "no position": the pool has no on-chain StakePool account yet, the wallet has
 * no LP token account, or it holds zero LP.
 *
 * Shared by the multi-pool scan (`StakePage`'s effect below, feeds
 * `YourPositionPanel`) and the per-selected-pool Withdraw tab
 * (`DepositWidget`) so both read the exact same on-chain detection logic
 * instead of two hand-rolled copies that could silently drift apart.
 *
 * Throws when the position could not be read (RPC error, undecodable account)
 * (#2706). It used to swallow every failure into `null`, so a transient RPC
 * error on one pool rendered as "you have no stake in that pool" and dropped
 * the position (and its withdraw row) until reload. The multi-pool scan uses
 * Promise.allSettled, so one failing pool still can't abort the others.
 */
async function fetchPoolPosition(
  pool: StakePool,
  publicKey: PublicKey,
  connection: Connection,
  stakeProgramId: PublicKey,
): Promise<UserPosition | null> {
  if (!pool.slabAddress || !pool.collateralMint) return null;
  const slabPk = new PublicKey(pool.slabAddress);
  const [poolPda] = deriveStakePool(slabPk, stakeProgramId);
  const [depositPdaAddress] = deriveDepositPda(poolPda, publicKey, stakeProgramId);

  // Fetch pool account to get lpMint. Decode via decodeStakePoolV1 — the
  // needed offsets are identical across the retired 352-byte and deployed
  // 392-byte layouts (see STAKE_POOL_SIZE_V1 comment in useStakePool.ts).
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (!poolInfo || poolInfo.data.length < STAKE_POOL_SIZE_V1) return null;
  const poolV1 = decodeStakePoolV1(poolInfo.data);
  const { lpMint } = poolV1;

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

  // Estimated value = (user_lp / total_lp_supply) * vault_balance, from FRESH on-chain pool +
  // vault reads (lib/stake-position.ts). The cached /api/stake/pools snapshot (pool.tvl /
  // pool.totalLpSupply) predates a first deposit into a fresh pool and valued the stake at $0.
  let chainVaultAtoms: bigint | null = null;
  try {
    const vaultInfo = await connection.getAccountInfo(poolV1.vault);
    if (vaultInfo) chainVaultAtoms = unpackAccount(poolV1.vault, vaultInfo, vaultInfo.owner).amount;
  } catch {
    // fall back to the API snapshot below
  }
  const estimatedValue = valueStakePosition({
    lpRaw: lpAccount.amount,
    chainTotalLpSupplyRaw: readPoolTotalLpSupply(poolInfo.data),
    chainVaultAtoms,
    apiTotalLpSupply: pool.totalLpSupply,
    apiTvlUsd: pool.tvl,
    lpDecimals,
  });

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
}

/* ── Header + Stats Strip ──────────────────────────────────────────────────
   Compact terminal header (mirrors EarnHeader) — a `// insurance lp` eyebrow,
   a concise title, a one-line description, the honest in-development note, and
   a four-cell stats strip. No display hero, no marketing CTA. */

function StakeHeader({
  pools,
  totalUserDeposited,
  loading,
}: {
  pools: StakePool[];
  totalUserDeposited: number | null;
  loading: boolean;
}) {
  const { connected } = useWalletCompat();
  const totalStaked = pools.reduce((s, p) => s + p.tvl, 0);
  const activePools = pools.length;
  const avgApr = pools.length > 0
    ? pools.reduce((s, p) => s + p.apr, 0) / pools.length
    : 0;

  const yourDeposits =
    !connected
      ? "—"
      : totalUserDeposited === null
        ? "…"
        : totalUserDeposited > 0
          ? formatUsd(totalUserDeposited)
          : "$—";

  const stats: { label: string; value: string; muted?: boolean }[] = [
    { label: "Total Staked", value: loading ? "…" : formatUsd(totalStaked) },
    { label: "Your Deposits", value: yourDeposits, muted: !connected || totalUserDeposited === null || (totalUserDeposited ?? 0) <= 0 },
    { label: "Active Pools", value: loading ? "…" : String(activePools) },
    { label: "Avg APR", value: avgApr > 0 ? `${avgApr.toFixed(1)}%` : "0%", muted: avgApr <= 0 },
  ];

  return (
    <div className="relative">
      {/* Background grid fade — same idiom as EarnHeader */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-6">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
          // insurance stake
        </div>

        <h1
          className="text-2xl font-medium tracking-[-0.01em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          <span className="font-normal text-[var(--text-secondary)]">Fee </span>staking
        </h1>
        <p className="mt-2 max-w-lg text-[13px] text-[var(--text-secondary)]">
          Stake into a market&apos;s pool to receive a share of that market&apos;s trading fees —
          fully on-chain and transparent.
        </p>
        {/* E2E B4 (2026-09-30): stakers ARE paid. The insurance fee leg accrues to the wrapper's
            insurance reserve and the keeper (b004a0c) pushes it into the bound stake pool:
            wrapper tag 87 WithdrawInsuranceReserveToStake -> stake tag 12 AccrueFees, which takes
            insurance pools (pool_mode 0; see lib/pre-resolve.ts decideStakeLeg). Measured: stakers
            C3 +5.86 USDC, U3 +7.01 USDC. The old zero-yield caption was false. */}
        <p className="mt-1.5 max-w-lg text-[11px] text-[var(--text-muted)]">
          Stakers are paid the insurance share of every trading fee, moved into the stake pool
          automatically. The pool admin can move staked funds into the market&apos;s insurance
          fund, where trading losses can use them, so your stake can lose value. This has not
          happened so far.
        </p>
        {/* The 0% above reads as an oversight without the other shares beside
            it — "16% to insurance" is the number it gets mistaken for. #2565. */}
        <div className="mt-3 max-w-lg border border-[var(--border)] bg-[var(--panel-bg)] p-3">
          <FeeBreakdown highlight="staker" showStaker />
        </div>

        {/* Stats strip */}
        <div
          className="mt-5 grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4"
          aria-label="Fee staking statistics"
        >
          {stats.map((s) => (
            <div key={s.label} className="min-w-0 bg-[var(--panel-bg)] p-4 sm:p-5">
              <div className="mb-1 truncate text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                {s.label}
              </div>
              <div
                className={`truncate text-2xl font-bold tabular-nums ${s.muted ? "text-[var(--text-muted)]" : "text-[var(--text)]"}`}
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
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
  // Live countdown; at 0 re-read the position so "Withdraw All" enables without a refresh.
  const cooldown = useStakeCooldown(position, onWithdrawSuccess);

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
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">{position.poolName}</span>
        <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--accent-text)]">Staked</span>
      </div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Your stake</div>
            <div className="text-sm font-mono tabular-nums text-[var(--text)]">
              {position.lpBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Est. Value</div>
            <div className="text-sm font-mono tabular-nums text-[var(--text)]">
              {formatUsd(position.estimatedValue)}
            </div>
          </div>
        </div>

        {/* Cooldown */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Cooldown</span>
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {position.cooldownElapsed
                ? STAKE_COPY.ready
                : cooldown.label
              }
            </span>
          </div>
          <ProgressBar value={cooldownPct} height={6} fillClassName="bg-gradient-to-r from-blue-500 to-[var(--cyan)]" />
        </div>

        {/* Tx feedback */}
        {txStatus && (
          <p data-testid={txStatus.type === "success" ? "stake-success" : "stake-error"} className={`text-[11px] ${txStatus.type === "success" ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
            {txStatus.msg}
          </p>
        )}
        {withdrawError && !txStatus && (
          <p data-testid="stake-error" data-kind="withdraw" className="text-[11px] text-[var(--short)]">{withdrawError}</p>
        )}

        {/* Action buttons */}
        <div className="space-y-2">
          {/* Withdraw button — all-or-nothing, full LP balance */}
          <button
            disabled={!position.cooldownElapsed || withdrawLoading}
            onClick={handleWithdraw}
            className={`w-full rounded-sm py-2 text-[11px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
              position.cooldownElapsed && !withdrawLoading
                ? "border border-[var(--cyan)]/50 bg-[var(--cyan)]/[0.10] text-[var(--cyan)] hover:border-[var(--cyan)] hover:bg-[var(--cyan)]/[0.18]"
                : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-secondary)] cursor-not-allowed"
            }`}
          >
            {withdrawLoading
              ? "Withdrawing…"
              : position.cooldownElapsed
              ? "Withdraw All →"
              : cooldown.label}
          </button>

          {/* Manage / Withdraw Partial — jumps to DepositWidget's Withdraw
              tab pre-selected to this pool, for a partial (not all-or-nothing)
              withdrawal. */}
          <button
            type="button"
            onClick={() => onManage?.(position.poolId)}
            className="w-full rounded-sm border border-[var(--border)] bg-[var(--bg)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all duration-200 hover:border-[var(--accent)]/30 hover:text-[var(--accent-text)]"
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
  unreadable = 0,
  onRetry,
  pending = false,
}: {
  positions: UserPosition[];
  /** The connected wallet's positions haven't been read yet (pools loading or the
   *  scan in flight): neither "no positions" nor an error is known. */
  pending?: boolean;
  /** Pools whose position could not be read (#2706) — 0 means every pool was
   *  read, so an empty list really is "no positions". -1 = the pool list
   *  itself failed, so no pool could be checked. */
  unreadable?: number;
  onRetry?: () => void;
  onWithdrawSuccess?: () => void;
  /** Threaded through to each PositionCard's "Manage / Withdraw Partial"
   *  button — see PositionCard for what it does. */
  onManage?: (poolId: string) => void;
}) {
  const { connected } = useWalletCompat();

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
          // your positions
        </span>
        {connected && positions.length > 0 && (
          <span className="text-[10px] text-[var(--text-secondary)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {positions.length}
          </span>
        )}
      </div>

      {connected && !pending && unreadable !== 0 && (
        <div role="alert" data-testid="stake-positions-error" className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-3 text-[11px] text-[var(--text-secondary)]">
          {unreadable < 0
            ? "Couldn't load your positions."
            : `Couldn't read your position in ${unreadable} pool${unreadable === 1 ? "" : "s"}.`}{" "}
          <button type="button" onClick={onRetry} className="text-[var(--accent-text)] transition-colors hover:text-[var(--accent)]">
            Try again
          </button>
        </div>
      )}

      {!connected ? (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-3 text-[11px] text-[var(--text-secondary)]">
          Connect a wallet to see your staked positions.
        </div>
      ) : pending ? (
        <div data-testid="stake-positions-pending" className="border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-3 text-[11px] text-[var(--text-secondary)]">
          Checking your positions…
        </div>
      ) : positions.length === 0 && unreadable !== 0 ? null : positions.length === 0 ? (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-3 text-[11px] text-[var(--text-secondary)]">
          No open positions. Select a pool and deposit to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {positions.map((position) => (
            <PositionCard key={position.poolId} position={position} onWithdrawSuccess={onWithdrawSuccess} onManage={onManage} />
          ))}
        </div>
      )}
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
  // Live countdown for the Withdraw tab; at 0 re-read the position (the chain decides).
  const withdrawCooldown = useStakeCooldown(withdrawPosition, () => setWithdrawRefreshKey((k) => k + 1));
  const [withdrawTxStatus, setWithdrawTxStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const pool = pools.find((p) => p.id === selectedPool) ?? pools[0];
  const amountNum = parseFloat(amount) || 0;
  // Exact deposit amount in base units (null = unparseable / too many decimals)
  // for the wallet-balance check; the float `amountNum` is display-only.
  let depositRaw: bigint | null = 0n;
  if (amount) {
    try { depositRaw = parseHumanAmount(amount, balanceDecimals); } catch { depositRaw = null; }
  }
  const depositStatus = depositRaw === null ? "empty" : checkDepositAmount(depositRaw, walletBalanceRaw);
  const depositAmountError = depositAmountMessage(depositStatus, walletBalanceRaw, balanceDecimals, "USDC");
  const withdrawAmountNum = parseFloat(withdrawAmount) || 0;
  // handleWithdraw refuses more than the staked balance; say so here instead of a button that does nothing.
  // Never throws (extra decimals would make parseHumanAmount throw mid-render).
  const withdrawAmountIssue = withdrawPosition ? withdrawAmountError(withdrawAmount, withdrawPosition.lpBalanceRaw, withdrawPosition.lpDecimals) : null;
  const withdrawExceeds = withdrawAmountIssue !== null;

  // Bug #12: the Junior (first-loss) tranche selector was removed — DepositJunior
  // (tag 16, PERC-303) belongs to the v2 StakePool program. The fresh devnet
  // program (GCHhcgw…) now uses the 392-byte v2 layout, so tranches may be
  // supported, but the tag-16 handler is unverified live — keep Senior-only
  // until confirmed. See the warning atop useStakeDepositJunior.ts.
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
      setWithdrawPositionLoading(false);
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
          ?? DEVNET_PROGRAM_IDS.stake
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
      if (walletBalanceRaw !== null && rawAmount > walletBalanceRaw) {
        setTxStatus({ type: "error", msg: depositAmountMessage("exceeds", walletBalanceRaw, balanceDecimals, "USDC") ?? "Exceeds your wallet balance" });
        return;
      }
      const sig = await deposit(rawAmount);
      setAmount("");
      setTxStatus({ type: "success", msg: `Deposit confirmed: ${sig.slice(0, 8)}…` });

      // Refresh the selected pool's withdraw position immediately after a deposit
      // so the Withdraw tab can enable manual amount entry and MAX without waiting
      // for a full pool/position reload.
      setWithdrawRefreshKey((k) => k + 1);
      onTxSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTxStatus({ type: "error", msg });
    }
  }, [pool, amount, balanceDecimals, walletBalanceRaw, deposit, depositLoading, onTxSuccess]);

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
    <div id="deposit" className="border border-[var(--border)] bg-[var(--panel-bg)] hud-corners">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)]/60 px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">// {mode}</span>
        {pool && (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {pool.symbol}
            <LivePoolPrice slab={pool.slabAddress} className="text-[var(--cyan)]" />
          </span>
        )}
      </div>
      <div className="space-y-4 p-4">
        {/* Deposit / Withdraw toggle */}
        <div className="flex gap-1 border border-[var(--border)] p-0.5">
          <button
            type="button"
            onClick={() => { setMode("deposit"); setTxStatus(null); setWithdrawTxStatus(null); }}
            data-testid="stake-tab-deposit"
            className={`flex-1 rounded-sm py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              mode === "deposit"
                ? "bg-[var(--accent)]/[0.12] text-[var(--accent-text)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text)]"
            }`}
          >
            Deposit
          </button>
          <button
            type="button"
            onClick={() => { setMode("withdraw"); setTxStatus(null); setWithdrawTxStatus(null); }}
            data-testid="stake-tab-withdraw"
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
                    onClick={() => { if (walletBalanceRaw !== null) setAmount(formatTokenAmount(walletBalanceRaw, balanceDecimals)); }}
                    className="text-[10px] text-[var(--text-muted)] tabular-nums transition-colors hover:text-[var(--accent-text)] cursor-pointer"
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
                  data-testid="stake-deposit-input"
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
                  onClick={() => { if (walletBalanceRaw !== null && walletBalanceRaw > 0n) setAmount(formatTokenAmount(walletBalanceRaw, balanceDecimals)); }}
                  className="border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent-text)]"
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
                        // Exact base-unit math, rounded DOWN — toFixed(2) rounds
                        // to nearest, so "100%" of 10.006 became 10.01 (> balance).
                        if (walletBalanceRaw === null) return;
                        setAmount(formatTokenAmount((walletBalanceRaw * BigInt(pct)) / 100n, balanceDecimals));
                        setTxStatus(null);
                      }}
                      className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--bg)] py-1 text-[10px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent-text)]"
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            {depositStatus === "exceeds" && (
              <p role="alert" data-testid="stake-deposit-amount-error" className="text-[11px] text-[var(--short)]">
                {depositAmountError}
              </p>
            )}

            {/* LP estimate */}
            {amountNum > 0 && (
              <div className="text-[12px] text-[var(--text-secondary)]">
                You will receive ≈{" "}
                <span className="font-medium text-[var(--text)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                  {lpEstimate.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
                </span>
              </div>
            )}

            {/* Pool cap bar */}
            {pool && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Pool cap</span>
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
                {STAKE_COPY.period(pool.cooldownSlots)}
              </p>
            )}

            {/* Tx feedback */}
            {txStatus && (
              <p data-testid={txStatus.type === "success" ? "stake-success" : "stake-error"} className={`text-[11px] ${txStatus.type === "success" ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
                {txStatus.msg}
              </p>
            )}
            {depositError && !txStatus && (
              <p data-testid="stake-error" data-kind="deposit" className="text-[11px] text-[var(--short)]">{depositError}</p>
            )}

            {/* CTA */}
            {!connected ? (
              <ConnectWalletCta label="Connect Wallet to Deposit" testId="stake-connect-deposit" />
            ) : (
              <button
                data-testid="stake-deposit-submit"
                disabled={amountNum <= 0 || depositLoading || depositStatus === "exceeds"}
                onClick={handleDeposit}
                className={`w-full rounded-sm py-3 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
                  amountNum > 0 && !depositLoading && depositStatus !== "exceeds"
                    ? "border border-[var(--accent)]/50 bg-[var(--accent)]/[0.10] text-[var(--accent-text)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.18]"
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
                    className="text-[10px] text-[var(--text-muted)] tabular-nums transition-colors hover:text-[var(--accent-text)] cursor-pointer"
                    style={{ fontFamily: "var(--font-mono)" }}
                    title="Click to use full staked balance"
                  >
                    Staked: {withdrawPosition.lpBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  data-testid="stake-withdraw-input"
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
                  className="border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-50"
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
                        setWithdrawAmount(stakeWithdrawChipAmount(withdrawPosition.lpBalanceRaw, pct, withdrawPosition.lpDecimals));
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

            {withdrawAmountIssue && (
              <p role="alert" data-testid="stake-withdraw-amount-error" className="text-[11px] text-[var(--short)]">
                {withdrawAmountIssue}
              </p>
            )}

            {/* Cooldown status */}
            {withdrawPosition && (
              <p className={`text-[10px] ${withdrawPosition.cooldownElapsed ? "text-[var(--text-muted)]" : "text-[var(--short)]"}`}>
                {withdrawPosition.cooldownElapsed
                  ? "Cooldown complete — ready to withdraw."
                  : `${withdrawCooldown.label}.`}
              </p>
            )}

            {/* Tx feedback */}
            {withdrawTxStatus && (
              <p data-testid={withdrawTxStatus.type === "success" ? "stake-success" : "stake-error"} data-kind="withdraw" className={`text-[11px] ${withdrawTxStatus.type === "success" ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
                {withdrawTxStatus.msg}
              </p>
            )}
            {withdrawError && !withdrawTxStatus && (
              <p data-testid="stake-error" data-kind="withdraw" className="text-[11px] text-[var(--short)]">{withdrawError}</p>
            )}

            {/* CTA */}
            {!connected ? (
              <ConnectWalletCta label="Connect Wallet to Withdraw" testId="stake-connect-withdraw" />
            ) : (
              <button
                data-testid="stake-withdraw-submit"
                disabled={!withdrawPosition || !withdrawPosition.cooldownElapsed || withdrawAmountNum <= 0 || withdrawExceeds || withdrawLoading}
                onClick={handleWithdraw}
                className={`w-full rounded-sm py-3 text-[12px] font-semibold uppercase tracking-[0.1em] transition-all duration-200 ${
                  withdrawPosition && withdrawPosition.cooldownElapsed && withdrawAmountNum > 0 && !withdrawExceeds && !withdrawLoading
                    ? "border border-[var(--cyan)]/50 bg-[var(--cyan)]/[0.10] text-[var(--cyan)] hover:border-[var(--cyan)] hover:bg-[var(--cyan)]/[0.18]"
                    : "border border-[var(--border)] bg-[var(--bg)] text-[var(--text-secondary)] cursor-not-allowed"
                }`}
              >
                {withdrawLoading
                  ? "Withdrawing…"
                  : !withdrawPosition
                  ? "Nothing to Withdraw"
                  : !withdrawPosition.cooldownElapsed
                  ? withdrawCooldown.label
                  : "Withdraw →"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Pool Table ── */

/**
 * Shared CSS-grid column template for the insurance-pool table — used by both
 * the column-header row and every PoolRow so they stay aligned. Mirrors the
 * terminal-table idiom (TradeHistoryTable / the LP-vault table).
 *
 * Columns: Pool · TVL · Cooldown · Your Stake · APR.
 */
const STAKE_GRID_COLS =
  "grid grid-cols-[minmax(120px,1.6fr)_84px_84px_92px_64px] items-center gap-x-3";

/**
 * A single selectable insurance-pool row. Selecting it loads this pool into the
 * deposit rail on the right — the "obvious deposit flow." A mouse click anywhere
 * on the row selects it. For the keyboard and screen readers the figures are one
 * real button, kept apart from the symbol link: a link nested in role="button" was
 * hidden from screen readers, and Enter on it selected the pool instead of opening
 * the chart. Below md the button's 44px tap-target minimum (globals.css) sets the
 * row height, so the row drops its vertical padding there.
 */
function PoolRow({
  pool,
  position,
  connected,
  selected,
  onSelect,
  positionsPending = false,
}: {
  pool: StakePool;
  position?: UserPosition;
  connected: boolean;
  selected: boolean;
  onSelect: (poolId: string) => void;
  positionsPending?: boolean;
}) {
  const yourStake = position
    ? formatUsd(position.estimatedValue)
    : connected
      ? positionsPending ? "…" : "$—"
      : "—";

  return (
    <div
      onClick={() => onSelect(pool.id)}
      className={`${STAKE_GRID_COLS} w-full cursor-pointer border-b border-[var(--border)] border-l-2 px-3 py-0 text-left transition-colors md:py-2.5 duration-100 ${
        selected
          ? "border-l-[var(--accent)] bg-[var(--accent)]/[0.06]"
          : "border-l-transparent hover:bg-[var(--bg-elevated)]"
      }`}
    >
      {/* Pool / market — symbol links to the market's chart; the rest of the row selects the pool to stake */}
      <div className="flex min-w-0 items-center gap-2">
        <MarketLogo mainnetCa={pool.mainnetCa} logoUrl={pool.logoUrl} symbol={pool.symbol} pixelOverride={22} decorative />
        <Link
          href={`/trade/${pool.slabAddress}`}
          onClick={(e) => e.stopPropagation()}
          title={`Open ${pool.symbol} chart`}
          className="min-w-0 truncate text-[12px] font-medium text-[var(--text)] transition-colors hover:text-[var(--accent)] hover:underline"
        >
          {pool.symbol}
        </Link>
      </div>

      {/* Clicks bubble to the row's onClick. */}
      <button type="button" aria-pressed={selected} className="col-span-4 grid cursor-pointer grid-cols-subgrid items-center text-right">
        <span className="sr-only">Select {pool.symbol} pool:</span>

        {/* TVL */}
        <span className="text-right text-[12px] tabular-nums text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
          {formatUsd(pool.tvl)}
        </span>

        {/* Cooldown */}
        <span className="text-right text-[12px] tabular-nums text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          {cooldownDuration(pool.cooldownSlots)}
        </span>

        {/* Your stake */}
        <span
          className={`text-right text-[12px] tabular-nums ${position ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]"}`}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {yourStake}
        </span>

        {/* APR */}
        <span
          className={`text-right text-[12px] tabular-nums ${pool.apr > 0 ? "text-[var(--cyan)]" : "text-[var(--text-muted)]"}`}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {pool.apr > 0 ? `${pool.apr.toFixed(1)}%` : "0%"}
        </span>
      </button>
    </div>
  );
}

/* ── Pool Table Section ── */

function PoolTable({
  pools,
  loading,
  positions,
  connected,
  selectedPool,
  onSelect,
  loadError,
  onRetry,
  positionsPending = false,
}: {
  pools: StakePool[];
  loading: boolean;
  positions: UserPosition[];
  /** The wallet's positions haven't been read yet: show "…", not "$—", per row. */
  positionsPending?: boolean;
  connected: boolean;
  selectedPool: string;
  onSelect: (poolId: string) => void;
  /** The pools fetch failed and nothing was loaded (#2706): show the failure,
   *  never the "no pools yet" empty state. */
  loadError?: boolean;
  onRetry?: () => void;
}) {
  const positionByPoolId = new Map(positions.map((p) => [p.poolId, p]));

  // Search + "my stakes first" ordering (pure helper in lib/stake-pool-order.ts).
  // A pool the wallet has staked in (lpBalanceRaw > 0) sorts above the rest by
  // staked value; everything else keeps its incoming order. Declared before the
  // early loading/empty returns below so the hook order stays stable.
  const [query, setQuery] = useState("");
  const visiblePools = orderStakePools(pools, query, (id) => {
    const pos = positionByPoolId.get(id);
    return pos ? stakedOrderValue(pos.lpBalanceRaw, pos.estimatedValue) : 0;
  });

  const header = (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
        <span className="text-[var(--text-secondary)]">Insurance </span>Pools
      </h2>
      <span className="text-[11px] text-[var(--text-secondary)] tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
        {loading ? "…" : `${pools.length} pool${pools.length !== 1 ? "s" : ""}`}
      </span>
    </div>
  );

  const columnHeader = (
    <div className={`${STAKE_GRID_COLS} border-b border-[var(--border)] bg-[var(--bg-elevated)]/50 px-3 py-2`}>
      <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Pool</span>
      <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">TVL</span>
      <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Cooldown</span>
      <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">Your Stake</span>
      <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">APR</span>
    </div>
  );

  if (loading) {
    return (
      <section id="pools">
        {header}
        <div className="overflow-x-auto border border-[var(--border)] bg-[var(--panel-bg)]">
          <div className="min-w-[520px]">
            {columnHeader}
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`${STAKE_GRID_COLS} border-b border-[var(--border)] px-3 py-2.5`}>
                <div className="flex items-center gap-2">
                  <ShimmerSkeleton className="h-[22px] w-[22px]" />
                  <ShimmerSkeleton className="h-3.5 w-16" />
                </div>
                <ShimmerSkeleton className="ml-auto h-3.5 w-12" />
                <ShimmerSkeleton className="ml-auto h-3.5 w-10" />
                <ShimmerSkeleton className="ml-auto h-3.5 w-12" />
                <ShimmerSkeleton className="ml-auto h-3.5 w-8" />
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (pools.length === 0 && loadError) {
    return (
      <section id="pools">
        {header}
        <div role="alert" data-testid="stake-pools-error" className="border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-4 text-[11px] text-[var(--text-secondary)]">
          Couldn&apos;t load insurance pools.{" "}
          <button type="button" onClick={onRetry} className="text-[var(--accent-text)] transition-colors hover:text-[var(--accent)]">
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (pools.length === 0) {
    return (
      <section id="pools">
        {header}
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-4 text-[11px] text-[var(--text-secondary)]">
          No insurance pools available yet. Check back soon, or{" "}
          <a href="/create" className="text-[var(--accent-text)] transition-colors hover:text-[var(--accent)]">create a market →</a>
        </div>
      </section>
    );
  }

  return (
    <section id="pools">
      {header}
      {/* Search — filter by symbol/name so a specific market stays quick to
          find as the pool count grows. */}
      <div className="mb-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pools…"
          aria-label="Search insurance pools"
          className="w-full border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-2 text-[12px] text-[var(--text)] placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none"
        />
      </div>
      <div className="overflow-x-auto border border-[var(--border)] bg-[var(--panel-bg)]">
        <div className="min-w-[520px]">
          {columnHeader}
          {/* Cap the list at ~8 rows then scroll, so the section stays a fixed
              height no matter how many pools exist (keeps the page from growing
              unbounded). The column header above stays put. */}
          <div className="max-h-[360px] overflow-y-auto">
            {visiblePools.map((pool) => (
              <PoolRow
                key={pool.id}
                pool={pool}
                position={positionByPoolId.get(pool.id)}
                connected={connected}
                selected={pool.id === selectedPool}
                onSelect={onSelect}
                positionsPending={positionsPending}
              />
            ))}
            {visiblePools.length === 0 && (
              <div className="px-3 py-4 text-[11px] text-[var(--text-secondary)]">
                No pools match “{query.trim()}”.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Sidebar: how staking works + what it backs + risk ─────────────────────
   Mirrors EarnVaultView's sidebar idiom (Step rows + coverage list + a risk
   notice) so the Stake tab reads as a sibling of the LP Vault tab. */

function SidebarStep({ num, title, desc }: { num: number; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-[var(--accent)]/20 bg-[var(--accent)]/10 text-[10px] font-bold text-[var(--accent-text)]">
        {num}
      </div>
      <div>
        <div className="text-[12px] font-medium text-[var(--text)]">{title}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">{desc}</div>
      </div>
    </div>
  );
}

function CoverageItem({ icon, label, description }: { icon: string; label: string; description: string }) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-0.5 text-xs">{icon}</span>
      <div>
        <div className="text-[12px] font-medium text-[var(--text)]">{label}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">{description}</div>
      </div>
    </div>
  );
}

/* Slim secondary strip — explanatory content kept BELOW the functional
   table+rail, as a row of small cards (mirrors EarnVaultView's info strip). */
function StakeSidebar() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* What staking backs */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden="true" className="text-xs">🛡️</span>
          <h3 className="text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
            If the pool admin moves stake into insurance
          </h3>
        </div>
        <div className="space-y-2">
          <CoverageItem icon="⚡" label="Liquidation Shortfall" description="Moved stake can cover losses when liquidations don't fully cover a position" />
          <CoverageItem icon="🔄" label="Socialized Loss Buffer" description="Absorbs bad debt before it reaches the market's liquidity and Earn deposits" />
          <CoverageItem icon="🏗️" label="Protocol Solvency" description="Pre-funds the market's insurance fund via an admin flush" />
        </div>
      </div>

      {/* How staking works */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
        <h3 className="mb-3 text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
          How It Works
        </h3>
        <div className="space-y-2">
          <SidebarStep num={1} title="Deposit" desc="Stake sim-USDC into a market's insurance pool" />
          <SidebarStep num={2} title="Back the fund" desc="Your deposit becomes first-loss backing" />
          <SidebarStep num={3} title="Withdraw" desc={STAKE_COPY.sidebar} />
        </div>
      </div>

      {/* Risk notice */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
        <div className="mb-2 text-[10px] uppercase tracking-[0.15em] text-[var(--warning)]">⚠ Risk Notice</div>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Staked funds are first-loss insurance capital. Admin flushes permanently reduce your
          redeemable value, and the fee income shown as APR depends on trading volume. Only stake
          what you can afford to lose.
        </p>
      </div>
    </div>
  );
}

/* ── Main Page ── */

export default function StakePage() {
  const [pools, setPools] = useState<StakePool[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  // #2706: a failed pools fetch is a failure, not "no pools". Cleared by the
  // next successful fetch.
  const [poolsError, setPoolsError] = useState(false);
  // #2706: how many pools' positions could not be read on the last scan.
  const [positionsUnreadable, setPositionsUnreadable] = useState(0);
  // S-M1 fix: ALL positions the wallet holds across pools, not just the first
  // one found.
  const [positions, setPositions] = useState<UserPosition[]>([]);
  // The wallet the last finished scan read. Until it matches the connected wallet,
  // positions are unknown: shown as "Checking…", never as "No open positions" or as
  // the previous wallet's positions. A refresh after a tx keeps the shown positions.
  const [scannedFor, setScannedFor] = useState<string | null>(null);
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
        if (!cancelled) {
          setPools((json.pools ?? []).map(apiPoolToStakePool));
          setPoolsError(false);
        }
      } catch (err) {
        console.error("[StakePage] Failed to fetch pools:", err);
        // Keep any previously loaded pools (a background refresh after a tx
        // failing must not blank the table); flag the failure.
        if (!cancelled) setPoolsError(true);
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
      setPositionsUnreadable(0);
      setScannedFor(null);
      return;
    }
    let cancelled = false;
    const wallet = publicKey.toBase58();

    (async () => {
      try {
        // Stake pools are owned by this deployment's vault program
        // (getConfig().vaultProgramId), NOT the SDK's default stake program id.
        const stakeProgramId = new PublicKey(
          (getConfig() as { vaultProgramId?: string }).vaultProgramId
          ?? DEVNET_PROGRAM_IDS.stake
        );
        // Check every pool for user's LP position — same detection logic the
        // Withdraw tab uses for a single selected pool (fetchPoolPosition).
        // allSettled: one bad pool/RPC hiccup must not blank out the rest.
        // fetchPoolPosition rejects when a pool could not be read (#2706), so a
        // rejection is counted and surfaced, never treated as "no position".
        const results = await Promise.allSettled(
          pools.map((pool) => fetchPoolPosition(pool, publicKey, connection, stakeProgramId)),
        );
        if (cancelled) return;
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            console.error("[StakePage] Failed to read position for pool:", pools[i]?.slabAddress, r.reason);
          }
        });
        const found = results
          .filter((r): r is PromiseFulfilledResult<UserPosition | null> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((p): p is UserPosition => p !== null);
        setPositions(found);
        setPositionsUnreadable(results.filter((r) => r.status === "rejected").length);
        setScannedFor(wallet);
      } catch (err) {
        console.error("[StakePage] Failed to fetch user positions:", err);
        if (!cancelled) {
          setPositions([]);
          setPositionsUnreadable(pools.length);
          setScannedFor(wallet);
        }
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

  // Pools still loading, or a scan for this wallet not finished yet. A genuinely empty
  // pool list (loaded, nothing to scan) is not pending.
  const walletKey = publicKey?.toBase58() ?? null;
  const positionsPending =
    connected && walletKey !== null && (poolsLoading || (pools.length > 0 && scannedFor !== walletKey));
  const shownPositions = positionsPending ? [] : positions;

  // S-M1 fix: sum across ALL positions, not just a single (possibly-missing) one.
  // #2706: if any pool could not be read (or the pool list failed), the total
  // is unknown — show it as unknown rather than an under-count or "$—".
  const totalUserDeposited =
    connected && (positionsPending || positionsUnreadable > 0 || (poolsError && pools.length === 0))
      ? null
      : positions.length > 0
        ? positions.reduce((sum, p) => sum + p.estimatedValue, 0)
        : connected ? 0 : null;

  const retryPools = useCallback(() => {
    setPoolsLoading(true);
    setPoolsRefreshKey((k) => k + 1);
  }, []);
  const retryPositions = useCallback(() => setPositionRefreshKey((k) => k + 1), []);

  const selectPoolAndScroll = useCallback((poolId: string, mode: "deposit" | "withdraw") => {
    setSelectedPool(poolId);
    setWidgetMode(mode);
    document.getElementById("deposit")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  return (
    // No min-h-screen: this page renders both standalone at /stake AND as a tab
    // inside the Earn hub (app/earn), which supplies the outer layout. Content
    // flows naturally at both mount points.
    <div className="relative animate-fade-in overflow-x-hidden">
      {/* Compact header + stats strip (mirrors EarnHeader) */}
      <ErrorBoundary label="Stake Header">
        {/* A failed pools fetch must not read as "0 pools / $0 staked" (#2706). */}
        <StakeHeader pools={pools} totalUserDeposited={totalUserDeposited} loading={poolsLoading || (poolsError && pools.length === 0)} />
      </ErrorBoundary>

      {/* Main content */}
      <div className="mx-auto max-w-[1400px] px-4 pb-24 lg:px-6 lg:pb-16">
        {/* MAIN (pool table) + RIGHT RAIL (deposit/withdraw + your positions) —
            mirrors the trade terminal's main + OrderTicket shape. */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
          {/* MAIN — scannable pool table */}
          <div className="min-w-0">
            <ErrorBoundary label="Pool Table">
              <PoolTable
                pools={pools}
                loading={poolsLoading}
                positions={shownPositions}
                positionsPending={positionsPending}
                connected={connected}
                selectedPool={selectedPool}
                onSelect={(poolId) => selectPoolAndScroll(poolId, "deposit")}
                loadError={poolsError}
                onRetry={retryPools}
              />
            </ErrorBoundary>
          </div>

          {/* RIGHT RAIL — deposit/withdraw bound to the selected pool, then positions */}
          <div className="space-y-3 lg:sticky lg:top-4">
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
            <ErrorBoundary label="Your Positions">
              <YourPositionPanel
                positions={shownPositions}
                pending={positionsPending}
                onWithdrawSuccess={handleTxSuccess}
                onManage={(poolId) => selectPoolAndScroll(poolId, "withdraw")}
                unreadable={poolsError && pools.length === 0 ? -1 : positionsUnreadable}
                onRetry={poolsError && pools.length === 0 ? retryPools : retryPositions}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* SECONDARY — what staking backs / how it works / risk */}
        <div className="mt-8">
          <StakeSidebar />
        </div>
      </div>
    </div>
  );
}
