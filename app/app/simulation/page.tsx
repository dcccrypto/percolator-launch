"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Transaction,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SendTransactionError,
  Connection,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getAssociatedTokenAddress,
  getMintLen,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeInitVamm,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeSetOraclePriceCap,
  encodeUpdateConfig,
  encodeKeeperCrank,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_UPDATE_CONFIG,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  SLAB_TIERS,
  deriveLpPda,
} from "@percolator/core";
import { ScenarioSelector } from "@/components/simulation/ScenarioSelector";
import { SimulationControls } from "@/components/simulation/SimulationControls";
import { SlabProvider } from "@/components/providers/SlabProvider";
import { UsdToggleProvider } from "@/components/providers/UsdToggleProvider";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { railwayUrl } from "@/lib/railway";

/* ── On-chain trade page components (all read from SlabProvider context) ── */
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { MarketStatsCard } from "@/components/trade/MarketStatsCard";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { SystemCapitalCard } from "@/components/trade/SystemCapitalCard";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";
import { FundingRateCard } from "@/components/trade/FundingRateCard";
import { FundingRateChart } from "@/components/trade/FundingRateChart";
import { TradingChart } from "@/components/trade/TradingChart";
import { OpenInterestCard } from "@/components/market/OpenInterestCard";
import { InsuranceDashboard } from "@/components/market/InsuranceDashboard";
import { BotLeaderboard } from "@/components/simulation/BotLeaderboard";
import { LiveLiquidationFeed } from "@/components/simulation/LiveLiquidationFeed";
import { AccountsCard } from "@/components/trade/AccountsCard";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

/* ─── Constants ─── */
const PROGRAM_ID = new PublicKey("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MIN_SOL = 1;
const MIN_LAMPORTS = MIN_SOL * LAMPORTS_PER_SOL;
const MINT_AMOUNT = 10_000_000_000n;
const LP_FEE = 1_000_000n;
const INITIAL_PRICE_E6 = 1_000_000n;
const MATCHER_CTX_SIZE = 320;
const MINT_RENT = 1_461_600;
const SLAB_RENT = 438_034_560;
const MATCHER_CTX_RENT = 3_118_080;

const RPC_URL = `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`;

/* ─── Types ─── */
interface SimState {
  running: boolean;
  slabAddress: string | null;
  price: number;
  scenario: string | null;
  model: string;
  uptime: number;
  totalTrades?: number;
  liquidations?: number;
  fundingRate?: number;
  openInterest?: number;
}

interface TokenPreview {
  name: string;
  symbol: string;
  description: string;
  decimals: number;
}

interface PricePoint {
  time: number;
  price: number;
}

interface SessionStats {
  startTime: number;
  endTime: number;
  highPrice: number;
  lowPrice: number;
  startPrice: number;
  endPrice: number;
  dataPoints: number;
  scenario: string | null;
  totalTrades: number;
  liquidations: number;
  fundingRate: number;
  openInterest: number;
  peakOpenInterest: number;
  insuranceBalance: number;
  insuranceHealth: number;
  forceCloses: number;
}

/* ─── Shareable Image Generator ─── */
function generateShareImage(
  stats: SessionStats,
  priceData: PricePoint[],
  tokenSymbol: string,
  tokenName: string,
): string {
  const W = 1200, H = 630;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Background
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  // Border
  ctx.strokeStyle = "#1a1a2e";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Accent line top
  ctx.fillStyle = "#00e5ff";
  ctx.fillRect(0, 0, W, 3);

  // Header
  ctx.fillStyle = "#00e5ff";
  ctx.font = "bold 11px monospace";
  ctx.letterSpacing = "3px";
  ctx.fillText("// PERCOLATOR SIMULATION", 40, 45);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = "#e0e0e0";
  ctx.font = "bold 36px monospace";
  ctx.fillText(`${tokenSymbol}/USD`, 40, 90);

  ctx.fillStyle = "#888";
  ctx.font = "14px monospace";
  ctx.fillText(tokenName, 40, 115);

  // Price chart
  if (priceData.length > 1) {
    const chartX = 40, chartY = 140, chartW = W - 80, chartH = 240;
    const prices = priceData.map(d => d.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = chartY + (i / 4) * chartH;
      ctx.beginPath(); ctx.moveTo(chartX, y); ctx.lineTo(chartX + chartW, y); ctx.stroke();
      ctx.fillStyle = "#555";
      ctx.font = "10px monospace";
      const label = (max - (i / 4) * range).toFixed(4);
      ctx.fillText(`$${label}`, chartX + chartW + 5, y + 4);
    }

    const isUp = prices[prices.length - 1] >= prices[0];
    ctx.strokeStyle = isUp ? "#00e676" : "#ff1744";
    ctx.lineWidth = 2;
    ctx.beginPath();
    priceData.forEach((d, i) => {
      const x = chartX + (i / (priceData.length - 1)) * chartW;
      const y = chartY + chartH - ((d.price - min) / range) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, chartY, 0, chartY + chartH);
    gradient.addColorStop(0, isUp ? "rgba(0,230,118,0.15)" : "rgba(255,23,68,0.15)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    priceData.forEach((d, i) => {
      const x = chartX + (i / (priceData.length - 1)) * chartW;
      const y = chartY + chartH - ((d.price - min) / range) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(chartX + chartW, chartY + chartH);
    ctx.lineTo(chartX, chartY + chartH);
    ctx.closePath();
    ctx.fill();
  }

  // Stats rows — now with on-chain data
  const statsY = 420;
  const pctChange = stats.startPrice > 0 ? ((stats.endPrice - stats.startPrice) / stats.startPrice * 100) : 0;
  const duration = Math.floor((stats.endTime - stats.startTime) / 1000);
  const durStr = duration > 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`;

  const statItems = [
    { label: "CHANGE", value: `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(2)}%`, color: pctChange >= 0 ? "#00e676" : "#ff1744" },
    { label: "HIGH", value: `$${stats.highPrice.toFixed(4)}`, color: "#00e676" },
    { label: "LOW", value: `$${stats.lowPrice.toFixed(4)}`, color: "#ff1744" },
    { label: "DURATION", value: durStr, color: "#e0e0e0" },
    { label: "TRADES", value: stats.totalTrades.toString(), color: "#e0e0e0" },
    { label: "LIQUIDATIONS", value: stats.liquidations.toString(), color: stats.liquidations > 0 ? "#ff1744" : "#e0e0e0" },
  ];

  const colW = (W - 80) / statItems.length;
  statItems.forEach((s, i) => {
    const x = 40 + i * colW;
    ctx.fillStyle = "#555";
    ctx.font = "bold 9px monospace";
    ctx.fillText(s.label, x, statsY);
    ctx.fillStyle = s.color;
    ctx.font = "bold 18px monospace";
    ctx.fillText(s.value, x, statsY + 24);
  });

  // Second stats row
  const statsY2 = 475;
  const fmtCompact = (n: number) => n > 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n > 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
  const statItems2 = [
    { label: "FUNDING RATE", value: `${stats.fundingRate >= 0 ? "+" : ""}${(stats.fundingRate * 100).toFixed(4)}%`, color: stats.fundingRate >= 0 ? "#00e676" : "#ff1744" },
    { label: "PEAK OI", value: fmtCompact(stats.peakOpenInterest), color: "#00e5ff" },
    { label: "INSURANCE", value: fmtCompact(stats.insuranceBalance), color: stats.insuranceHealth > 5 ? "#00e676" : stats.insuranceHealth > 1 ? "#e0e0e0" : "#ff1744" },
    { label: "FORCE CLOSES", value: stats.forceCloses.toString(), color: stats.forceCloses > 0 ? "#ff1744" : "#e0e0e0" },
    { label: "SCENARIO", value: stats.scenario || "none", color: "#00e5ff" },
  ];

  const colW2 = (W - 80) / statItems2.length;
  statItems2.forEach((s, i) => {
    const x = 40 + i * colW2;
    ctx.fillStyle = "#555";
    ctx.font = "bold 9px monospace";
    ctx.fillText(s.label, x, statsY2);
    ctx.fillStyle = s.color;
    ctx.font = "bold 16px monospace";
    ctx.fillText(s.value, x, statsY2 + 22);
  });

  // Footer
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, H - 60, W, 60);
  ctx.fillStyle = "#00e5ff";
  ctx.font = "bold 11px monospace";
  ctx.fillText("PERCOLATOR", 40, H - 30);
  ctx.fillStyle = "#555";
  ctx.font = "11px monospace";
  ctx.fillText("Permissionless Perpetual Futures on Solana", 180, H - 30);
  ctx.fillStyle = "#333";
  ctx.font = "10px monospace";
  ctx.fillText("percolatorlaunch.com", W - 260, H - 30);

  // Pyth badge
  ctx.fillStyle = "#6B3FA0";
  ctx.fillRect(40, H - 100, 120, 22);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 10px monospace";
  ctx.fillText("POWERED BY PYTH", 48, H - 84);

  return canvas.toDataURL("image/png");
}

type Phase = "deposit" | "building" | "running" | "ended";

/* ─── Helpers ─── */
function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

async function extractError(err: unknown): Promise<string> {
  if (err instanceof SendTransactionError) {
    try {
      const logs = await (err as SendTransactionError & { getLogs: (c?: unknown) => Promise<string[]> }).getLogs(undefined);
      if (logs?.length) {
        const fails = logs.filter((l: string) => l.includes("failed") || l.includes("Error"));
        if (fails.length) return `${err.message} | ${fails.join("; ")}`;
        return `${err.message} | ${logs.slice(-5).join("; ")}`;
      }
    } catch {
      const raw = (err as unknown as Record<string, unknown>);
      const anyLogs = raw.transactionLogs || raw.logs;
      if (Array.isArray(anyLogs)) return `${err.message} | ${(anyLogs as string[]).slice(-5).join("; ")}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.partialSign(...signers);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  } catch (err) {
    const msg = await extractError(err);
    throw new Error(`[${label}] ${msg}`);
  }
}

/* ─── Railway API helpers ─── */
async function railwayFetch(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(railwayUrl(path), {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
}

/* ─── Running Dashboard (wrapped in SlabProvider) ─── */
function RunningDashboard({
  slabAddress,
  tokenPreview,
  state,
  priceHistory,
  speed,
  loading,
  onStop,
  onSpeedChange,
  onPriceOverride,
  onScenarioSelect,
}: {
  slabAddress: string;
  tokenPreview: TokenPreview | null;
  state: SimState;
  priceHistory: PricePoint[];
  speed: number;
  loading: boolean;
  onStop: () => Promise<void>;
  onSpeedChange: (s: number) => void;
  onPriceOverride: (price: number) => Promise<void>;
  onScenarioSelect: (scenario: string) => Promise<void>;
}) {
  return (
    <SlabProvider slabAddress={slabAddress}>
      <UsdToggleProvider>
        <RunningDashboardInner
          slabAddress={slabAddress}
          tokenPreview={tokenPreview}
          state={state}
          priceHistory={priceHistory}
          speed={speed}
          loading={loading}
          onStop={onStop}
          onSpeedChange={onSpeedChange}
          onPriceOverride={onPriceOverride}
          onScenarioSelect={onScenarioSelect}
        />
      </UsdToggleProvider>
    </SlabProvider>
  );
}

function RunningDashboardInner({
  slabAddress,
  tokenPreview,
  state,
  priceHistory,
  speed,
  loading,
  onStop,
  onSpeedChange,
  onPriceOverride,
  onScenarioSelect,
}: {
  slabAddress: string;
  tokenPreview: TokenPreview | null;
  state: SimState;
  priceHistory: PricePoint[];
  speed: number;
  loading: boolean;
  onStop: () => Promise<void>;
  onSpeedChange: (s: number) => void;
  onPriceOverride: (price: number) => Promise<void>;
  onScenarioSelect: (scenario: string) => Promise<void>;
}) {
  const currentPrice = state.price / 1e6;
  const priceChange = priceHistory.length > 1 && priceHistory[0].price > 0
    ? ((currentPrice - priceHistory[0].price) / priceHistory[0].price) * 100
    : 0;

  const formatUptime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Header */}
      <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
        <div className="mx-auto max-w-7xl">
          <div className="flex items-start justify-between">
            <div>
              <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">// SIMULATION</p>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>{tokenPreview?.symbol || "SIM"}/USD</h1>
                <span className="text-[20px] font-bold font-mono text-[var(--text)]">${currentPrice.toFixed(4)}</span>
                <span className="text-[11px] font-mono" style={{ color: priceChange >= 0 ? "var(--long)" : "var(--short)" }}>
                  {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="border border-[var(--border)]/50 bg-[var(--bg-elevated)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 animate-pulse" style={{ backgroundColor: state.running ? "var(--long)" : "var(--short)" }} />
                  <div className="text-right">
                    <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{state.running ? "Live" : "Stopped"}</p>
                    {state.running && state.uptime > 0 && <p className="text-[9px] font-mono text-[var(--text)]">{formatUptime(state.uptime)}</p>}
                  </div>
                </div>
              </div>
              <button onClick={onStop} disabled={loading} className="border border-[var(--short)]/50 bg-[var(--short)]/[0.08] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--short)] hover:bg-[var(--short)]/[0.15] transition-all disabled:opacity-50">{loading ? "Ending..." : "End Simulation"}</button>
            </div>
          </div>
        </div>
      </div>

      {/* On-chain Trading Chart */}
      <div className="mx-auto max-w-7xl px-3 pt-3">
        <ErrorBoundary label="TradingChart">
          <TradingChart slabAddress={slabAddress} simulation />
        </ErrorBoundary>
      </div>

      {/* Main Grid */}
      <div className="mx-auto max-w-7xl px-3 py-3">
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-3">
          {/* Left Sidebar */}
          <div className="space-y-3">
            {/* Market Info */}
            <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3 space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Market Info</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Token</p>
                  <p className="text-[12px] font-bold text-[var(--accent)]">{tokenPreview?.symbol}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Model</p>
                  <p className="text-[12px] font-bold text-[var(--text)]">{state.model}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Scenario</p>
                  <p className="text-[12px] font-bold text-[var(--text)]">{state.scenario || "none"}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Speed</p>
                  <p className="text-[12px] font-bold text-[var(--text)]">{speed}x</p>
                </div>
              </div>
              {slabAddress && <p className="text-[8px] font-mono text-[var(--text-dim)] truncate">Slab: {slabAddress}</p>}
            </div>

            <SimulationControls isRunning={state.running} currentSlab={slabAddress} speed={speed} onStart={async () => {}} onStop={onStop} onSpeedChange={onSpeedChange} onPriceOverride={onPriceOverride} />

            <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-3">Scenarios</h3>
              <ScenarioSelector activeScenario={state.scenario} onScenarioSelect={onScenarioSelect} disabled={loading} />
            </div>

            {/* Bot Leaderboard — from Railway */}
            <ErrorBoundary label="BotLeaderboard">
              <BotLeaderboard isSimulationRunning={state.running} />
            </ErrorBoundary>
          </div>

          {/* Right Content — ALL on-chain risk engine components */}
          <div className="space-y-3">
            {/* Row 1: Market Stats + Engine Health */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <ErrorBoundary label="MarketStatsCard">
                <MarketStatsCard />
              </ErrorBoundary>
              <ErrorBoundary label="EngineHealthCard">
                <EngineHealthCard />
              </ErrorBoundary>
            </div>

            {/* Row 2: Funding Rates — current + historical chart */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <ErrorBoundary label="FundingRateCard">
                <FundingRateCard slabAddress={slabAddress} simulation />
              </ErrorBoundary>
              <ErrorBoundary label="FundingRateChart">
                <FundingRateChart slabAddress={slabAddress} simulation />
              </ErrorBoundary>
            </div>

            {/* Row 3: Open Interest + Insurance Fund */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <ErrorBoundary label="OpenInterestCard">
                <OpenInterestCard slabAddress={slabAddress} simulation />
              </ErrorBoundary>
              <ErrorBoundary label="InsuranceDashboard">
                <InsuranceDashboard slabAddress={slabAddress} simulation />
              </ErrorBoundary>
            </div>

            {/* Row 4: Liquidation Feed + Crank Health */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <ErrorBoundary label="LiveLiquidationFeed">
                <LiveLiquidationFeed />
              </ErrorBoundary>
              <ErrorBoundary label="CrankHealthCard">
                <CrankHealthCard />
              </ErrorBoundary>
            </div>

            {/* Row 5: System Capital (vault, c_tot, pnl_pos_tot, LP aggregates) + Liquidation Analytics */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <ErrorBoundary label="SystemCapitalCard">
                <SystemCapitalCard />
              </ErrorBoundary>
              <ErrorBoundary label="LiquidationAnalytics">
                <LiquidationAnalytics />
              </ErrorBoundary>
            </div>

            {/* Row 6: All Accounts (positions, warmup status, PnL) */}
            <ErrorBoundary label="AccountsCard">
              <AccountsCard />
            </ErrorBoundary>
          </div>
        </div>
      </div>

      {/* Pyth attribution */}
      <div className="mx-auto max-w-7xl px-3 pb-2">
        <div className="flex items-center gap-2 border border-[var(--border)]/20 bg-[var(--bg)]/80 px-3 py-1.5">
          <div className="h-2 w-2" style={{ backgroundColor: "#6B3FA0" }} />
          <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Oracle prices powered by Pyth Network</span>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-[var(--border)]/30 bg-[var(--bg)]/95 backdrop-blur-sm px-4 py-2">
        <div className="mx-auto max-w-7xl flex items-center justify-between">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            {state.running ? `${tokenPreview?.symbol}/USD | ${state.model} | ${state.scenario || "no scenario"} | ${speed}x` : "Simulation paused"}
          </p>
          <div className="flex items-center gap-3">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">on-chain data</span>
            <p className="text-[9px] font-mono text-[var(--text-secondary)]">{slabAddress.slice(0, 8)}...{slabAddress.slice(-8)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Component ─── */
export default function SimulationPage() {
  const rpcConnection = useRef(new Connection(RPC_URL, "confirmed")).current;
  const { publicKey, connected, sendTransaction, signTransaction } = useWallet();
  const { connection: walletConnection } = useConnection();

  const [phase, setPhase] = useState<Phase>("deposit");
  const [payer] = useState(() => Keypair.generate());
  const [balance, setBalance] = useState(0);
  const [tokenPreview, setTokenPreview] = useState<TokenPreview | null>(null);
  const [slabAddress, setSlabAddress] = useState<string | null>(null);
  const [mintAddress, setMintAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState("");
  const [stepNum, setStepNum] = useState(0);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<SimState>({ running: false, slabAddress: null, price: 1_000_000, scenario: null, model: "random-walk", uptime: 0 });
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [shareImage, setShareImage] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const buildingRef = useRef(false);
  const unmountedRef = useRef(false);
  const sessionStatsRef = useRef<SessionStats | null>(null);
  const priceHistoryRef = useRef<PricePoint[]>([]);
  const tokenPreviewRef = useRef<TokenPreview | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => { unmountedRef.current = true; };
  }, []);

  // Keep refs in sync for use inside intervals (avoids stale closures)
  useEffect(() => { sessionStatsRef.current = sessionStats; }, [sessionStats]);
  useEffect(() => { priceHistoryRef.current = priceHistory; }, [priceHistory]);
  useEffect(() => { tokenPreviewRef.current = tokenPreview; }, [tokenPreview]);

  /* ─── Fetch random token ─── */
  const fetchTokenPreview = useCallback(async () => {
    try {
      const res = await fetch("/api/simulation/random-token");
      if (res.ok) {
        const data = await res.json();
        setTokenPreview({ name: data.name, symbol: data.symbol, description: data.description, decimals: data.decimals ?? 6 });
      }
    } catch {
      setTokenPreview({ name: "Mystery Token", symbol: "???", description: "Could not load", decimals: 6 });
    }
  }, []);

  useEffect(() => { fetchTokenPreview(); }, [fetchTokenPreview]);

  /* ─── Poll balance while waiting for deposit ─── */
  useEffect(() => {
    if (phase !== "deposit") return;
    const interval = setInterval(async () => {
      try {
        const bal = await rpcConnection.getBalance(payer.publicKey);
        setBalance(bal);
        if (bal >= MIN_LAMPORTS && !buildingRef.current) {
          buildingRef.current = true;
          clearInterval(interval);
          buildMarket();
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, payer]);

  /* ─── Poll simulation state from Railway ─── */
  useEffect(() => {
    if (phase !== "running") return;
    const interval = setInterval(async () => {
      try {
        const res = await railwayFetch("/api/simulation");
        if (res.ok) {
          const data = await res.json();
          const stats = data.stats ?? {};
          const newPrice = data.currentPriceE6 ?? data.price ?? 1_000_000;
          setState(prev => ({
            ...prev,
            running: data.running,
            price: newPrice,
            scenario: data.scenario ?? prev.scenario,
            model: data.model ?? prev.model,
            uptime: data.uptime ?? prev.uptime,
            totalTrades: stats.tradesCount ?? data.totalTrades ?? prev.totalTrades,
            liquidations: stats.liquidationsCount ?? data.liquidations ?? prev.liquidations,
            fundingRate: stats.fundingRate ? Number(stats.fundingRate) / 10000 : (data.fundingRate ?? prev.fundingRate),
            openInterest: stats.openInterest ? Number(stats.openInterest) / 1_000_000 : (data.openInterest ?? prev.openInterest),
          }));
          const priceUsd = newPrice / 1e6;
          setPriceHistory(prev => {
            const next = [...prev, { time: Date.now(), price: priceUsd }];
            return next.slice(-600);
          });
          setSessionStats(prev => prev ? {
            ...prev,
            highPrice: Math.max(prev.highPrice, priceUsd),
            lowPrice: Math.min(prev.lowPrice, priceUsd),
            endPrice: priceUsd,
            dataPoints: prev.dataPoints + 1,
            scenario: data.scenario ?? prev.scenario,
            totalTrades: stats.tradesCount ?? prev.totalTrades,
            liquidations: stats.liquidationsCount ?? prev.liquidations,
            fundingRate: stats.fundingRate ? Number(stats.fundingRate) / 10000 : prev.fundingRate,
            openInterest: stats.openInterest ? Number(stats.openInterest) / 1_000_000 : prev.openInterest,
            peakOpenInterest: Math.max(prev.peakOpenInterest, stats.openInterest ? Number(stats.openInterest) / 1_000_000 : prev.openInterest),
            insuranceBalance: stats.insuranceBalance ? Number(stats.insuranceBalance) / 1_000_000 : prev.insuranceBalance,
            insuranceHealth: data.insuranceHealth ?? prev.insuranceHealth,
            forceCloses: data.forceCloses ?? prev.forceCloses,
          } : prev);
          if (!data.running) {
            const currentStats = sessionStatsRef.current;
            const currentHistory = priceHistoryRef.current;
            const currentToken = tokenPreviewRef.current;
            const finalStats = currentStats ? { ...currentStats, endTime: Date.now(), endPrice: priceUsd } : null;
            if (finalStats) {
              setSessionStats(finalStats);
              try { setShareImage(generateShareImage(finalStats, currentHistory, currentToken?.symbol || "SIM", currentToken?.name || "Simulation")); } catch { /* ignore */ }
            }
            setPhase("ended");
          }
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* ─── Fetch price history from Railway ─── */
  useEffect(() => {
    if (phase !== "running" || !slabAddress) return;
    const fetchHistory = async () => {
      try {
        const res = await railwayFetch(`/api/simulation/history?slab=${slabAddress}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.history) && data.history.length > 0) {
            const railwayPoints: PricePoint[] = data.history.map((p: { time: number; price: number }) => ({
              time: p.time,
              price: p.price / 1e6,
            }));
            setPriceHistory(prev => {
              // Merge: use railway history as base, append any local points that are newer
              const lastRailway = railwayPoints[railwayPoints.length - 1]?.time ?? 0;
              const localNewer = prev.filter(p => p.time > lastRailway);
              return [...railwayPoints, ...localNewer].slice(-600);
            });
          }
        }
      } catch { /* ignore */ }
    };
    fetchHistory();
    const interval = setInterval(fetchHistory, 15000);
    return () => clearInterval(interval);
  }, [phase, slabAddress]);

  /* ─── Send SOL via wallet ─── */
  const handleWalletSend = async () => {
    if (!publicKey) return;
    setSending(true);
    setError(null);
    try {
      /* Use our own devnet RPC for blockhash — walletConnection may differ */
      const conn = rpcConnection;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: publicKey }).add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: payer.publicKey, lamports: MIN_LAMPORTS })
      );

      /* Prefer signTransaction + sendRawTransaction for cross-wallet compatibility.
         sendTransaction varies per wallet (some use their own RPC for simulation). */
      let sig: string;
      if (signTransaction) {
        const signed = await signTransaction(tx);
        sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      } else {
        sig = await sendTransaction(tx, conn, { skipPreflight: true });
      }
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Transfer error full:", err);
      if (msg.includes("reject") || msg.includes("cancelled") || msg.includes("User rejected")) {
        // user cancelled — no error
      } else if (msg.includes("Blockhash not found") || msg.includes("block height exceeded")) {
        setError("Transaction expired — devnet can be slow. Click send again.");
      } else if (msg.includes("0x1") || msg.includes("insufficient lamports")) {
        setError(`Insufficient SOL. Need ${MIN_SOL} devnet SOL.`);
      } else if (msg.includes("not connected")) {
        setError("Wallet not connected. Reconnect and try again.");
      } else {
        setError(`Transfer failed: ${msg}`);
      }
    } finally {
      if (!unmountedRef.current) setSending(false);
    }
  };

  /* ─── Build market (all automatic after deposit detected) ─── */
  const buildMarket = async () => {
    setPhase("building");
    setError(null);
    setStepNum(0);

    try {
      const decimals = tokenPreview?.decimals ?? 6;
      const oracleKp = Keypair.generate();
      const mintKp = Keypair.generate();
      const slabKp = Keypair.generate();
      const matcherCtxKp = Keypair.generate();

      const tier = SLAB_TIERS.small;
      const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);
      const vaultAta = await getAssociatedTokenAddress(mintKp.publicKey, vaultPda, true);
      const [lpPda] = deriveLpPda(PROGRAM_ID, slabKp.publicKey, 0);
      const payerAta = await getAssociatedTokenAddress(mintKp.publicKey, payer.publicKey);

      // Step 1: Create mint + slab + market
      setStep("Creating mint, slab & market..."); setStepNum(1);
      {
        const tx = new Transaction();
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, lamports: MINT_RENT, space: getMintLen([]), programId: TOKEN_PROGRAM_ID }));
        tx.add(createInitializeMint2Instruction(mintKp.publicKey, decimals, payer.publicKey, null));
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: slabKp.publicKey, lamports: SLAB_RENT, space: tier.dataSize, programId: PROGRAM_ID }));
        tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta, vaultPda, mintKp.publicKey));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [payer.publicKey, slabKp.publicKey, mintKp.publicKey, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent, vaultPda, WELL_KNOWN.systemProgram]),
          data: encodeInitMarket({
            admin: payer.publicKey, collateralMint: mintKp.publicKey, indexFeedId: "0".repeat(64),
            maxStalenessSecs: "86400", confFilterBps: 0, invert: 0, unitScale: 0,
            initialMarkPriceE6: INITIAL_PRICE_E6.toString(), warmupPeriodSlots: "10",
            maintenanceMarginBps: "500", initialMarginBps: "1000", tradingFeeBps: "30",
            maxAccounts: "256", newAccountFee: "1000000", riskReductionThreshold: "0",
            maintenanceFeePerSlot: "0", maxCrankStalenessSlots: "400", liquidationFeeBps: "100",
            liquidationFeeCap: "100000000000", liquidationBufferBps: "50", minLiquidationAbs: "1000000",
          }),
        }));
        await sendAndConfirm(rpcConnection, tx, [payer, mintKp, slabKp], "Create market");
      }
      setSlabAddress(slabKp.publicKey.toBase58());
      setMintAddress(mintKp.publicKey.toBase58());

      // Step 2: Oracle + Config + Crank
      setStep("Setting up oracle & config..."); setStepNum(2);
      {
        const tx = new Transaction();
        const t = nowSecs();
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slabKp.publicKey]), data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: t.toString() }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slabKp.publicKey]), data: encodeSetOraclePriceCap({ maxChangeE2bps: 100_000n }) }));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [payer.publicKey, slabKp.publicKey]),
          data: encodeUpdateConfig({
            fundingHorizonSlots: "3600", fundingKBps: "100", fundingInvScaleNotionalE6: "1000000000000",
            fundingMaxPremiumBps: "1000", fundingMaxBpsPerSlot: "10", threshFloor: "0", threshRiskBps: "500",
            threshUpdateIntervalSlots: "100", threshStepBps: "100", threshAlphaBps: "5000",
            threshMin: "0", threshMax: "1000000000000000000", threshMinStep: "0",
          }),
        }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey]), data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) }));
        await sendAndConfirm(rpcConnection, tx, [payer], "Oracle+config");
      }

      // Step 3: LP + vAMM
      setStep("Initializing LP & vAMM..."); setStepNum(3);
      {
        const tx = new Transaction();
        tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mintKp.publicKey));
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: matcherCtxKp.publicKey, lamports: MATCHER_CTX_RENT, space: MATCHER_CTX_SIZE, programId: MATCHER_PROGRAM_ID }));
        tx.add(createMintToInstruction(mintKp.publicKey, payerAta, payer.publicKey, LP_FEE));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slabKp.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram]),
          data: encodeInitLP({ matcherProgram: MATCHER_PROGRAM_ID, matcherContext: matcherCtxKp.publicKey, feePayment: LP_FEE.toString() }),
        }));
        tx.add(buildIx({
          programId: MATCHER_PROGRAM_ID,
          keys: [
            { pubkey: lpPda, isSigner: false, isWritable: false },
            { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
          ],
          data: encodeInitVamm({
            mode: 0, tradingFeeBps: 30, baseSpreadBps: 50, maxTotalBps: 200,
            impactKBps: 0, liquidityNotionalE6: 10_000_000_000_000n,
            maxFillAbs: 1_000_000_000_000n, maxInventoryAbs: 0n,
          }),
        }));
        await sendAndConfirm(rpcConnection, tx, [payer, matcherCtxKp], "LP+vAMM");
      }

      // Step 4: Delegate oracle + final crank
      setStep("Finalizing oracle..."); setStepNum(4);
      {
        const tx = new Transaction();
        const t = nowSecs();
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: t.toString() }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey]), data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slabKp.publicKey]), data: encodeSetOracleAuthority({ newAuthority: oracleKp.publicKey }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [oracleKp.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: (t + 1).toString() }) }));
        await sendAndConfirm(rpcConnection, tx, [payer, oracleKp], "Finalize oracle");
      }

      // Step 5: Fund market
      setStep("Minting tokens & funding market..."); setStepNum(5);
      {
        const tx1 = new Transaction();
        tx1.add(createMintToInstruction(mintKp.publicKey, payerAta, payer.publicKey, MINT_AMOUNT));
        // Transfer mint authority to oracleKp so Railway can mint tokens for bots
        tx1.add(createSetAuthorityInstruction(mintKp.publicKey, payer.publicKey, AuthorityType.MintTokens, oracleKp.publicKey));
        await sendAndConfirm(rpcConnection, tx1, [payer], "Mint tokens");
      }
      {
        const tx2 = new Transaction();
        const lpCollateral = (MINT_AMOUNT * 70n) / 100n;
        const insuranceAmt = (MINT_AMOUNT * 20n) / 100n;
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slabKp.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]), data: encodeDepositCollateral({ userIdx: 0, amount: lpCollateral.toString() }) }));
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slabKp.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram]), data: encodeTopUpInsurance({ amount: insuranceAmt.toString() }) }));
        const t = nowSecs();
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [oracleKp.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: t.toString() }) }));
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey]), data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) }));
        await sendAndConfirm(rpcConnection, tx2, [payer, oracleKp], "Fund market");
      }

      // Transfer SOL to oracle keypair for bot init tx fees on Railway
      {
        const tx3 = new Transaction();
        tx3.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: oracleKp.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }));
        await sendAndConfirm(rpcConnection, tx3, [payer], "Fund oracle SOL");
      }

      // Step 6: Start simulation engine on Railway
      setStep("Starting simulation engine..."); setStepNum(6);
      const oracleSecret = Buffer.from(oracleKp.secretKey).toString("base64");
      const startRes = await railwayFetch("/api/simulation/start", {
        method: "POST",
        body: JSON.stringify({
          slabAddress: slabKp.publicKey.toBase58(),
          oracleSecret,
          startPriceE6: Number(INITIAL_PRICE_E6),
          intervalMs: 5000 / speed,
          tokenSymbol: tokenPreview?.symbol,
          tokenName: tokenPreview?.name,
          mintAddress: mintKp.publicKey.toBase58(),
          creatorWallet: publicKey?.toBase58(),
        }),
      });
      if (!startRes.ok) {
        const err = await startRes.json();
        throw new Error(err.details || err.error || "Failed to start");
      }

      setState({ running: true, slabAddress: slabKp.publicKey.toBase58(), price: Number(INITIAL_PRICE_E6), scenario: null, model: "random-walk", uptime: 0 });
      const startPrice = Number(INITIAL_PRICE_E6) / 1e6;
      setPriceHistory([{ time: Date.now(), price: startPrice }]);
      setSessionStats({ startTime: Date.now(), endTime: 0, highPrice: startPrice, lowPrice: startPrice, startPrice, endPrice: startPrice, dataPoints: 1, scenario: null, totalTrades: 0, liquidations: 0, fundingRate: 0, openInterest: 0, peakOpenInterest: 0, insuranceBalance: 0, insuranceHealth: 0, forceCloses: 0 });
      setShareImage(null);
      setPhase("running");
    } catch (err: unknown) {
      console.error("Build error:", err);
      if (unmountedRef.current) return;
      setError(await extractError(err));
      setPhase("deposit");
      buildingRef.current = false;
    }
  };

  /* ─── Controls ─── */
  const handleStop = async () => {
    setLoading(true);
    try {
      // Fetch final stats from Railway before stopping
      let finalRailwayStats: Record<string, number> = {};
      try {
        const statusRes = await railwayFetch("/api/simulation");
        if (statusRes.ok) {
          finalRailwayStats = await statusRes.json();
        }
      } catch { /* ignore */ }

      await railwayFetch("/api/simulation/stop", { method: "POST" });

      const currentStats = sessionStatsRef.current;
      const finalStats: SessionStats = currentStats ? {
        ...currentStats,
        endTime: Date.now(),
        totalTrades: finalRailwayStats.totalTrades ?? currentStats.totalTrades,
        liquidations: finalRailwayStats.liquidations ?? currentStats.liquidations,
        fundingRate: finalRailwayStats.fundingRate ?? currentStats.fundingRate,
        openInterest: finalRailwayStats.openInterest ?? currentStats.openInterest,
      } : {
        startTime: Date.now(), endTime: Date.now(), highPrice: 1, lowPrice: 1, startPrice: 1, endPrice: 1, dataPoints: 0, scenario: null, totalTrades: 0, liquidations: 0, fundingRate: 0, openInterest: 0, peakOpenInterest: 0, insuranceBalance: 0, insuranceHealth: 0, forceCloses: 0,
      };
      setSessionStats(finalStats);
      try {
        const img = generateShareImage(finalStats, priceHistoryRef.current, tokenPreviewRef.current?.symbol || "SIM", tokenPreviewRef.current?.name || "Simulation");
        setShareImage(img);
      } catch (e) { console.error("Share image error:", e); }
      setState({ running: false, slabAddress: null, price: 1_000_000, scenario: null, model: "random-walk", uptime: 0 });
      setPhase("ended");
    } catch (err) { console.error("Stop error:", err); }
    finally { setLoading(false); }
  };

  const handleRestart = () => {
    setPhase("deposit");
    setSlabAddress(null);
    setMintAddress(null);
    setBalance(0);
    setError(null);
    setStep("");
    setStepNum(0);
    setPriceHistory([]);
    setSessionStats(null);
    setShareImage(null);
    setState({ running: false, slabAddress: null, price: 1_000_000, scenario: null, model: "random-walk", uptime: 0 });
    buildingRef.current = false;
    fetchTokenPreview();
  };

  const handleScenarioSelect = async (scenario: string) => {
    try {
      await railwayFetch("/api/simulation/scenario", {
        method: "POST",
        body: JSON.stringify({ scenario }),
      });
      setState(prev => ({ ...prev, scenario }));
    } catch (err) { console.error("Scenario error:", err); }
  };

  const handlePriceOverride = async (price: number) => {
    try {
      await railwayFetch("/api/simulation/price", {
        method: "POST",
        body: JSON.stringify({ priceE6: price }),
      });
    } catch (err) { console.error("Price override error:", err); }
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(payer.publicKey.toBase58());
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => {
      if (!unmountedRef.current) setCopied(false);
    }, 2000);
  };

  /* ─── Deposit Screen ─── */
  if (phase === "deposit") {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
          <div className="mx-auto max-w-lg">
            <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">// SIMULATION</p>
            <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>Self-Service Demo</h1>
            <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">Fund with devnet SOL -- market creation is fully automatic</p>
          </div>
        </div>

        <div className="mx-auto max-w-lg px-4 py-6 space-y-4">
          {/* Token Preview */}
          {tokenPreview && (
            <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">Your Token</p>
                  <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--accent)]">{tokenPreview.symbol}</p>
                  <p className="text-[14px] font-bold text-[var(--text)] mt-0.5">{tokenPreview.name}</p>
                  <p className="text-[10px] text-[var(--text-dim)] mt-0.5">{tokenPreview.description}</p>
                </div>
                <button onClick={fetchTokenPreview} className="border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors">Reroll</button>
              </div>
            </div>
          )}

          {/* Quick Send via Wallet */}
          <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.03] p-5 space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Quick Start</p>
            {!mounted || !connected ? (
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-[var(--text-secondary)]">Connect wallet to send {MIN_SOL} devnet SOL in one click</p>
                <WalletMultiButton />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2" style={{ backgroundColor: "var(--long)" }} />
                  <span className="text-[11px] font-mono text-[var(--text)]">{publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}</span>
                </div>
                <button
                  onClick={handleWalletSend}
                  disabled={sending}
                  className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3.5 text-[12px] font-bold uppercase tracking-[0.2em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sending ? "Sending..." : `Send ${MIN_SOL} SOL & Launch`}
                </button>
                <p className="text-[9px] text-[var(--text-dim)] text-center">Make sure Phantom is set to devnet</p>
              </div>
            )}
          </div>

          {/* Manual Alternative */}
          <div className="border border-[var(--border)] bg-[var(--bg)]/80 p-4 space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Or send manually</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border)]/50 px-3 py-2 text-[10px] font-mono text-[var(--text)] break-all select-all">{payer.publicKey.toBase58()}</code>
              <button onClick={copyAddress} className="border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors whitespace-nowrap">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2" style={{ backgroundColor: balance >= MIN_LAMPORTS ? "var(--long)" : "var(--text-dim)" }} />
                <span className="text-[10px] text-[var(--text-secondary)]">
                  {balance > 0 ? `${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL received` : "Waiting for deposit..."}
                </span>
              </div>
              {balance > 0 && balance < MIN_LAMPORTS && (
                <span className="text-[9px] text-[var(--short)]">Need {((MIN_LAMPORTS - balance) / LAMPORTS_PER_SOL).toFixed(4)} more</span>
              )}
            </div>
            <p className="text-[9px] text-[var(--text-dim)]">Need devnet SOL? <a href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">faucet.solana.com</a></p>
          </div>

          {/* Error */}
          {error && (
            <div className="border border-[var(--short)]/30 bg-[var(--short)]/[0.04] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--short)] mb-1">Error</p>
              <p className="text-[10px] text-[var(--short)] break-all">{error}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ─── Building Screen ─── */
  if (phase === "building") {
    const steps = ["Create market", "Oracle & config", "LP & vAMM", "Finalize oracle", "Fund market", "Start engine"];
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="max-w-md w-full px-4">
          <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.02] p-6 space-y-5">
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70 mb-1">// BUILDING</p>
              <p className="text-[14px] font-bold text-[var(--text)]">{tokenPreview?.symbol || "SIM"} Market</p>
              <p className="text-[10px] text-[var(--text-secondary)]">{tokenPreview?.name}</p>
            </div>

            {/* Step progress */}
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={s} className="flex items-center gap-3">
                  <div className="h-5 w-5 flex items-center justify-center text-[8px] font-bold" style={{
                    backgroundColor: i + 1 < stepNum ? "var(--long)" : i + 1 === stepNum ? "var(--accent)" : "transparent",
                    color: i + 1 <= stepNum ? "var(--bg)" : "var(--text-dim)",
                    border: i + 1 <= stepNum ? "none" : "1px solid var(--text-dim)",
                  }}>
                    {i + 1 < stepNum ? "\u2713" : i + 1}
                  </div>
                  <span className="text-[11px]" style={{
                    color: i + 1 < stepNum ? "var(--long)" : i + 1 === stepNum ? "var(--text)" : "var(--text-dim)",
                  }}>{s}</span>
                  {i + 1 === stepNum && <div className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />}
                </div>
              ))}
            </div>

            <div className="h-1 bg-[var(--border)]">
              <div className="h-1 bg-[var(--accent)] transition-all" style={{ width: `${(stepNum / 6) * 100}%` }} />
            </div>
            <p className="text-[9px] text-[var(--text-dim)]">{step}</p>
          </div>
        </div>
      </div>
    );
  }

  /* ─── Ended Screen ─── */
  if (phase === "ended") {
    const downloadImage = () => {
      if (!shareImage) return;
      const a = document.createElement("a");
      a.href = shareImage;
      a.download = `percolator-${tokenPreview?.symbol || "sim"}-${Date.now()}.png`;
      a.click();
    };

    const shareToTwitter = () => {
      const pct = sessionStats ? ((sessionStats.endPrice - sessionStats.startPrice) / sessionStats.startPrice * 100).toFixed(2) : "0";
      const trades = sessionStats?.totalTrades ?? 0;
      const liqs = sessionStats?.liquidations ?? 0;
      const text = encodeURIComponent(
        `Just ran a ${tokenPreview?.symbol}/USD perp simulation on @peraborator\n\n` +
        `${Number(pct) >= 0 ? "+" : ""}${pct}% price movement\n` +
        `${trades} trades | ${liqs} liquidations\n` +
        `High: $${sessionStats?.highPrice.toFixed(4)} | Low: $${sessionStats?.lowPrice.toFixed(4)}\n\n` +
        `Permissionless perpetual futures on Solana\npercolatorlaunch.com/simulation`
      );
      window.open(`https://twitter.com/intent/tweet?text=${text}`, "_blank");
    };

    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
          <div className="mx-auto max-w-2xl">
            <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">// SIMULATION COMPLETE</p>
            <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>Results</h1>
          </div>
        </div>

        <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
          {/* Shareable Image Preview */}
          {shareImage && (
            <div className="space-y-3">
              <img src={shareImage} alt="Simulation results" className="w-full border border-[var(--border)]" />
              <div className="flex gap-2">
                <button onClick={downloadImage} className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-2.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-all">Download Image</button>
                <button onClick={shareToTwitter} className="flex-1 border border-[var(--border)] bg-[var(--bg)] py-2.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-[var(--text)] transition-all">Share on X</button>
              </div>
            </div>
          )}

          {/* Stats Summary */}
          {sessionStats && (
            <div className="border border-[var(--border)] bg-[var(--bg)]/80 p-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Start Price</p>
                  <p className="text-[14px] font-bold font-mono text-[var(--text)]">${sessionStats.startPrice.toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">End Price</p>
                  <p className="text-[14px] font-bold font-mono text-[var(--text)]">${sessionStats.endPrice.toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Change</p>
                  {(() => {
                    const pct = ((sessionStats.endPrice - sessionStats.startPrice) / sessionStats.startPrice * 100);
                    return <p className="text-[14px] font-bold font-mono" style={{ color: pct >= 0 ? "var(--long)" : "var(--short)" }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</p>;
                  })()}
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">High</p>
                  <p className="text-[12px] font-mono" style={{ color: "var(--long)" }}>${sessionStats.highPrice.toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Low</p>
                  <p className="text-[12px] font-mono" style={{ color: "var(--short)" }}>${sessionStats.lowPrice.toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Data Points</p>
                  <p className="text-[12px] font-mono text-[var(--text)]">{sessionStats.dataPoints}</p>
                </div>
              </div>

              {/* On-chain stats row */}
              <div className="mt-3 pt-3 border-t border-[var(--border)]/30 grid grid-cols-4 gap-3">
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Total Trades</p>
                  <p className="text-[12px] font-bold font-mono text-[var(--text)]">{sessionStats.totalTrades}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Liquidations</p>
                  <p className="text-[12px] font-bold font-mono" style={{ color: sessionStats.liquidations > 0 ? "var(--short)" : "var(--text)" }}>{sessionStats.liquidations}</p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Funding Rate</p>
                  <p className="text-[12px] font-bold font-mono" style={{ color: sessionStats.fundingRate >= 0 ? "var(--long)" : "var(--short)" }}>
                    {sessionStats.fundingRate >= 0 ? "+" : ""}{(sessionStats.fundingRate * 100).toFixed(4)}%
                  </p>
                </div>
                <div>
                  <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Open Interest</p>
                  <p className="text-[12px] font-bold font-mono text-[var(--accent)]">
                    {sessionStats.openInterest > 1e6 ? `$${(sessionStats.openInterest / 1e6).toFixed(1)}M` : sessionStats.openInterest > 1e3 ? `$${(sessionStats.openInterest / 1e3).toFixed(1)}K` : `$${sessionStats.openInterest.toFixed(0)}`}
                  </p>
                </div>
              </div>
            </div>
          )}

          {slabAddress && (
            <p className="text-[9px] font-mono text-[var(--text-dim)] text-center">Market: {slabAddress}</p>
          )}

          <button onClick={handleRestart} className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3.5 text-[12px] font-bold uppercase tracking-[0.2em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-all">Launch New Simulation</button>
        </div>
      </div>
    );
  }

  /* ─── Running Dashboard ─── */
  if (!slabAddress) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="h-6 w-6 animate-spin border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  return (
    <RunningDashboard
      slabAddress={slabAddress}
      tokenPreview={tokenPreview}
      state={state}
      priceHistory={priceHistory}
      speed={speed}
      loading={loading}
      onStop={handleStop}
      onSpeedChange={(s: number) => setSpeed(s)}
      onPriceOverride={handlePriceOverride}
      onScenarioSelect={handleScenarioSelect}
    />
  );
}
