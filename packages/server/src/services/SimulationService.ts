import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  encodePushOraclePrice,
  encodeKeeperCrank,
  encodeInitUser,
  encodeDepositCollateral,
  encodeTradeNoCpi,
  encodeLiquidateAtOracle,
  encodeTopUpInsurance,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_TOPUP_INSURANCE,
  WELL_KNOWN,
  parseEngine,
  parseConfig,
  parseParams,
  parseAllAccounts,
  parseUsedIndices,
  AccountKind,
  type EngineState,
  type RiskParams,
  type MarketConfig,
  type Account,
} from "@percolator/core";
import { config } from "../config.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

// ============================================================================
// Types
// ============================================================================

export type Scenario = "live" | "crash" | "squeeze" | "blackswan" | "volatile" | "calm";

interface PricePoint {
  timestamp: number;
  price: number;
  priceE6: string; // serialized bigint
  scenario: Scenario;
}

interface FundingSnapshot {
  timestamp: number;
  rateBpsPerSlot: string;
  indexE6: string;
}

interface BotStats {
  name: string;
  type: string;
  accountIdx: number | null;
  initialized: boolean;
  funded: boolean;
  trades: number;
  positionSize: string;
  entryPrice: string;
  capital: string;
  pnl: string;
  warmupStartSlot: string;
}

interface SimulationStateSnapshot {
  running: boolean;
  slabAddress: string;
  scenario: Scenario;
  currentPrice: number;
  currentPriceE6: string;
  livePriceE6: string | null;
  uptime: number;
  stats: object;
  bots: BotStats[];
}

interface SimStats {
  tradesCount: number;
  liquidationsCount: number;
  liquidationVolume: number;
  forceCloseCount: number;
  oraclePushes: number;
  cranks: number;
  botErrors: number;
  startTime: number;
  volume: number;
  // Engine state snapshots
  fundingRate: string;
  fundingIndex: string;
  fundingHistory: FundingSnapshot[];
  openInterest: string;
  cTot: string;
  pnlPosTot: string;
  vaultBalance: string;
  insuranceBalance: string;
  insuranceFeeRevenue: string;
  insuranceHealthRatio: number; // insurance / totalOI
  lpNetPos: string;
  lpSumAbs: string;
  lpMaxAbs: string;
  crankStaleness: number; // slots since last crank
  currentSlot: string;
  lastCrankSlot: string;
  lifetimeLiquidations: string;
  lifetimeForceCloses: string;
  numAccounts: number;
  riskReductionThreshold: string;
  maintenanceMarginBps: string;
  initialMarginBps: string;
}

interface BotState {
  name: string;
  type: "MarketMaker" | "TrendFollower" | "LiquidationBot" | "WhaleBot" | "InsuranceBot";
  accountIdx: number | null;
  initialized: boolean;
  funded: boolean;
  lastTradeTime: number;
  tradeInterval: number;
  trades: number;
}

interface SimulationState {
  running: boolean;
  slabAddress: string;
  scenario: Scenario;
  currentPriceE6: bigint;
  currentPrice: number;
  livePriceE6: bigint | null;
  stats: SimStats;
  bots: BotState[];
}

// ============================================================================
// Pyth Hermes
// ============================================================================

const PYTH_SOL_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PYTH_HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";

async function fetchPythPrice(): Promise<number | null> {
  try {
    const url = `${PYTH_HERMES_URL}?ids[]=${PYTH_SOL_FEED}&encoding=hex&parsed=true`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const json = await resp.json() as { parsed: Array<{ price: { price: string; expo: number } }> };
    const p = json.parsed?.[0]?.price;
    if (!p) return null;
    return Number(p.price) * Math.pow(10, p.expo);
  } catch {
    return null;
  }
}

// ============================================================================
// Scenario Overlays — DRAMATIC for demo
// ============================================================================

function applyScenario(
  basePrice: number,
  scenario: Scenario,
  elapsedMs: number,
): number {
  switch (scenario) {
    case "live":
      return basePrice;

    case "crash": {
      // -40% over 30s, then slow bleed -5% over next 30s → cascading liquidations
      if (elapsedMs < 30_000) {
        const progress = elapsedMs / 30_000;
        return basePrice * (1 - 0.40 * progress);
      }
      const extraProgress = Math.min((elapsedMs - 30_000) / 30_000, 1);
      return basePrice * 0.60 * (1 - 0.05 * extraProgress);
    }

    case "squeeze": {
      // +60% over 30s — shorts get destroyed, funding spikes
      const progress = Math.min(elapsedMs / 30_000, 1);
      // Add oscillation to make it look dramatic
      const osc = Math.sin(elapsedMs / 2000) * 0.02;
      return basePrice * (1 + 0.60 * progress + osc);
    }

    case "blackswan": {
      // Flash crash -50% in 10s, bounce +20% in 10s, then volatile ±10%
      if (elapsedMs < 10_000) {
        const progress = elapsedMs / 10_000;
        return basePrice * (1 - 0.50 * progress);
      }
      if (elapsedMs < 20_000) {
        const progress = (elapsedMs - 10_000) / 10_000;
        return basePrice * 0.50 * (1 + 0.40 * progress);
      }
      // Violent oscillation
      const swing = Math.sin(elapsedMs / 1500) * 0.10 + (Math.random() - 0.5) * 0.08;
      return basePrice * 0.70 * (1 + swing);
    }

    case "volatile": {
      // ±8% random walk with momentum
      const swing = Math.sin(elapsedMs / 3000) * 0.05 + (Math.random() - 0.5) * 0.06;
      return basePrice * (1 + swing);
    }

    case "calm": {
      // ±0.2% — shows steady funding accumulation
      const swing = Math.sin(elapsedMs / 5000) * 0.001 + (Math.random() - 0.5) * 0.002;
      return basePrice * (1 + swing);
    }

    default:
      // Unknown scenario — treat as live (return base price unchanged)
      return basePrice;
  }
}

// ============================================================================
// SimulationService
// ============================================================================

export class SimulationService {
  private connection: Connection;
  private programId: PublicKey;
  private state: SimulationState | null = null;
  private oracleKeypair: Keypair | null = null;
  private priceHistory: PricePoint[] = [];
  private oracleTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private botTimers: ReturnType<typeof setTimeout>[] = [];
  private scenarioStartTime = 0;
  private scenarioBasePrice = 0;
  // Cached slab state for bots
  private cachedSlabData: Uint8Array | null = null;
  private cachedEngine: EngineState | null = null;
  private cachedConfig: MarketConfig | null = null;
  private cachedParams: RiskParams | null = null;
  private cachedAccounts: { idx: number; account: Account }[] = [];
  private lpIdx = 0;

  // Supabase persistence
  private supabase: SupabaseClient | null = null;
  private sessionId: string | null = null;
  private supabaseUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private highPriceE6 = 0;
  private lowPriceE6 = Number.MAX_SAFE_INTEGER;

  constructor() {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.programId = new PublicKey(config.programId);

    // Initialize Supabase if configured
    const sbUrl = config.supabaseUrl;
    const sbKey = config.supabaseServiceRoleKey || config.supabaseKey;
    if (sbUrl && sbKey) {
      this.supabase = createClient(sbUrl, sbKey);
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async start(params: {
    slabAddress: string;
    oracleSecret: string;
    startPriceE6?: number;
    intervalMs?: number;
    tokenSymbol?: string;
    tokenName?: string;
    mintAddress?: string;
    creatorWallet?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (this.state?.running) {
      return { ok: false, error: "Simulation already running" };
    }

    try {
      const secretBytes = Buffer.from(params.oracleSecret, "base64");
      this.oracleKeypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
    } catch (e) {
      return { ok: false, error: `Invalid oracleSecret: ${e}` };
    }

    const slabPk = new PublicKey(params.slabAddress);
    const intervalMs = params.intervalMs ?? 3000;

    // Fetch initial live price
    const livePrice = await fetchPythPrice();
    const startPrice = params.startPriceE6
      ? params.startPriceE6 / 1_000_000
      : livePrice ?? 150;
    const startPriceE6 = BigInt(Math.round(startPrice * 1_000_000));

    this.state = {
      running: true,
      slabAddress: params.slabAddress,
      scenario: "live",
      currentPriceE6: startPriceE6,
      currentPrice: startPrice,
      livePriceE6: livePrice ? BigInt(Math.round(livePrice * 1_000_000)) : null,
      stats: this.freshStats(),
      bots: [
        { name: "MarketMaker", type: "MarketMaker", accountIdx: null, initialized: false, funded: false, lastTradeTime: 0, tradeInterval: 4000, trades: 0 },
        { name: "TrendFollower", type: "TrendFollower", accountIdx: null, initialized: false, funded: false, lastTradeTime: 0, tradeInterval: 6000, trades: 0 },
        { name: "LiquidationBot", type: "LiquidationBot", accountIdx: null, initialized: false, funded: false, lastTradeTime: 0, tradeInterval: 5000, trades: 0 },
        { name: "WhaleBot", type: "WhaleBot", accountIdx: null, initialized: false, funded: false, lastTradeTime: 0, tradeInterval: 10000, trades: 0 },
        { name: "InsuranceBot", type: "InsuranceBot", accountIdx: null, initialized: false, funded: false, lastTradeTime: 0, tradeInterval: 15000, trades: 0 },
      ],
    };

    this.scenarioStartTime = Date.now();
    this.scenarioBasePrice = startPrice;
    this.priceHistory = [];

    this.highPriceE6 = Number(startPriceE6);
    this.lowPriceE6 = Number(startPriceE6);

    console.log(`🎮 Simulation starting | slab=${params.slabAddress} | price=$${startPrice.toFixed(2)}`);

    // Persist session to Supabase
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase.from("simulation_sessions").insert({
          status: "running",
          slab_address: params.slabAddress,
          mint_address: params.mintAddress ?? null,
          token_symbol: params.tokenSymbol ?? null,
          token_name: params.tokenName ?? null,
          creator_wallet: params.creatorWallet ?? null,
          model: "random-walk",
          start_price_e6: Number(startPriceE6),
          current_price_e6: Number(startPriceE6),
          high_price_e6: Number(startPriceE6),
          low_price_e6: Number(startPriceE6),
          started_at: new Date().toISOString(),
        }).select("id").single();

        if (error) {
          console.error("Supabase insert error:", error.message);
        } else if (data) {
          this.sessionId = data.id;
          console.log(`📊 Supabase session created: ${this.sessionId}`);
        }
      } catch (err) {
        console.error("Supabase insert failed:", err);
      }

      // Periodic Supabase update every 30s
      this.supabaseUpdateTimer = setInterval(() => {
        void this.updateSupabaseProgress();
      }, 30_000);
    }

    // Initial slab read
    await this.refreshSlabState(slabPk);

    // Start oracle price loop
    this.oracleTimer = setInterval(() => {
      void this.oracleTick(slabPk);
    }, intervalMs);

    // Stats refresh every 5s
    this.statsTimer = setInterval(() => {
      void this.refreshSlabState(slabPk);
    }, 5000);

    // Initialize bots (non-blocking)
    void this.initBots(slabPk);

    return { ok: true };
  }

  async stop(): Promise<{ ok: boolean; stats?: SimStats }> {
    if (!this.state?.running) {
      return { ok: false };
    }

    if (this.oracleTimer) clearInterval(this.oracleTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.supabaseUpdateTimer) clearInterval(this.supabaseUpdateTimer);
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
    this.oracleTimer = null;
    this.statsTimer = null;
    this.supabaseUpdateTimer = null;

    const stats = { ...this.state.stats };
    const endPriceE6 = Number(this.state.currentPriceE6);
    this.state.running = false;

    // Persist final results to Supabase
    if (this.supabase && this.sessionId) {
      try {
        const durationSeconds = Math.floor((Date.now() - stats.startTime) / 1000);
        const botStats: BotStats[] = this.state.bots.map((b) => {
          const onChain = b.accountIdx !== null
            ? this.cachedAccounts.find((a) => a.idx === b.accountIdx)?.account
            : undefined;
          return {
            name: b.name, type: b.type, accountIdx: b.accountIdx,
            initialized: b.initialized, funded: b.funded, trades: b.trades,
            positionSize: onChain?.positionSize?.toString() ?? "0",
            entryPrice: onChain?.entryPrice?.toString() ?? "0",
            capital: onChain?.capital?.toString() ?? "0",
            pnl: onChain?.pnl?.toString() ?? "0",
            warmupStartSlot: onChain?.warmupStartedAtSlot?.toString() ?? "0",
          };
        });

        const { error } = await this.supabase.from("simulation_sessions").update({
          status: "completed",
          end_price_e6: endPriceE6,
          high_price_e6: this.highPriceE6,
          low_price_e6: this.lowPriceE6,
          current_price_e6: endPriceE6,
          total_trades: stats.tradesCount,
          total_liquidations: stats.liquidationsCount,
          total_volume_e6: Math.round(stats.volume * 1_000_000),
          force_closes: stats.forceCloseCount,
          peak_oi_e6: Number(stats.openInterest),
          final_funding_rate_e6: Number(stats.fundingRate),
          final_insurance_balance_e6: Number(stats.insuranceBalance),
          final_insurance_revenue_e6: Number(stats.insuranceFeeRevenue),
          final_vault_balance_e6: Number(stats.vaultBalance),
          duration_seconds: durationSeconds,
          bot_count: this.state.bots.length,
          bots_data: botStats,
          updates_count: stats.oraclePushes,
          ended_at: new Date().toISOString(),
        }).eq("id", this.sessionId);

        if (error) {
          console.error("Supabase stop update error:", error.message);
        } else {
          console.log(`📊 Supabase session completed: ${this.sessionId}`);
        }
      } catch (err) {
        console.error("Supabase stop update failed:", err);
      }
      this.sessionId = null;
    }

    console.log(`🛑 Simulation stopped | trades=${stats.tradesCount} | liquidations=${stats.liquidationsCount} | pushes=${stats.oraclePushes}`);
    return { ok: true, stats };
  }

  getState(): SimulationStateSnapshot | null {
    if (!this.state) return null;

    // Enrich bot stats with on-chain data
    const botStats: BotStats[] = this.state.bots.map((b) => {
      const onChain = b.accountIdx !== null
        ? this.cachedAccounts.find((a) => a.idx === b.accountIdx)?.account
        : undefined;
      return {
        name: b.name,
        type: b.type,
        accountIdx: b.accountIdx,
        initialized: b.initialized,
        funded: b.funded,
        trades: b.trades,
        positionSize: onChain?.positionSize?.toString() ?? "0",
        entryPrice: onChain?.entryPrice?.toString() ?? "0",
        capital: onChain?.capital?.toString() ?? "0",
        pnl: onChain?.pnl?.toString() ?? "0",
        warmupStartSlot: onChain?.warmupStartedAtSlot?.toString() ?? "0",
      };
    });

    return {
      running: this.state.running,
      slabAddress: this.state.slabAddress,
      scenario: this.state.scenario,
      currentPrice: this.state.currentPrice,
      currentPriceE6: this.state.currentPriceE6.toString(),
      livePriceE6: this.state.livePriceE6?.toString() ?? null,
      uptime: this.state.running ? Date.now() - this.state.stats.startTime : 0,
      stats: this.serializeStats(this.state.stats),
      bots: botStats,
    };
  }

  setScenario(scenario: Scenario): { ok: boolean } {
    if (!this.state?.running) return { ok: false };
    const validScenarios: Scenario[] = ["live", "crash", "squeeze", "blackswan", "volatile", "calm"];
    if (!validScenarios.includes(scenario)) return { ok: false };
    this.state.scenario = scenario;
    this.scenarioStartTime = Date.now();
    this.scenarioBasePrice = this.state.currentPrice;
    console.log(`🎬 Scenario → ${scenario} (base=$${this.scenarioBasePrice.toFixed(2)})`);
    return { ok: true };
  }

  getHistory(): object[] {
    return this.priceHistory;
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  private async updateSupabaseProgress(): Promise<void> {
    if (!this.supabase || !this.sessionId || !this.state) return;
    try {
      const { error } = await this.supabase.from("simulation_sessions").update({
        current_price_e6: Number(this.state.currentPriceE6),
        high_price_e6: this.highPriceE6,
        low_price_e6: this.lowPriceE6,
        updates_count: this.state.stats.oraclePushes,
        total_trades: this.state.stats.tradesCount,
        total_liquidations: this.state.stats.liquidationsCount,
      }).eq("id", this.sessionId);
      if (error) console.error("Supabase progress update error:", error.message);
    } catch (err) {
      console.error("Supabase progress update failed:", err);
    }
  }

  private freshStats(): SimStats {
    return {
      tradesCount: 0,
      liquidationsCount: 0,
      liquidationVolume: 0,
      forceCloseCount: 0,
      oraclePushes: 0,
      cranks: 0,
      botErrors: 0,
      startTime: Date.now(),
      volume: 0,
      fundingRate: "0",
      fundingIndex: "0",
      fundingHistory: [],
      openInterest: "0",
      cTot: "0",
      pnlPosTot: "0",
      vaultBalance: "0",
      insuranceBalance: "0",
      insuranceFeeRevenue: "0",
      insuranceHealthRatio: 0,
      lpNetPos: "0",
      lpSumAbs: "0",
      lpMaxAbs: "0",
      crankStaleness: 0,
      currentSlot: "0",
      lastCrankSlot: "0",
      lifetimeLiquidations: "0",
      lifetimeForceCloses: "0",
      numAccounts: 0,
      riskReductionThreshold: "0",
      maintenanceMarginBps: "0",
      initialMarginBps: "0",
    };
  }

  private serializeStats(s: SimStats): object {
    return { ...s }; // already stringified bigints
  }

  private async refreshSlabState(slab: PublicKey): Promise<void> {
    try {
      const info = await this.connection.getAccountInfo(slab);
      if (!info?.data) return;
      const data = new Uint8Array(info.data);
      this.cachedSlabData = data;
      this.cachedEngine = parseEngine(data);
      this.cachedConfig = parseConfig(data);
      this.cachedParams = parseParams(data);
      this.cachedAccounts = parseAllAccounts(data);

      // Find LP idx
      for (const { idx, account } of this.cachedAccounts) {
        if (account.kind === AccountKind.LP) {
          this.lpIdx = idx;
          break;
        }
      }

      // Update stats from engine
      if (this.state && this.cachedEngine) {
        const e = this.cachedEngine;
        const p = this.cachedParams!;
        const s = this.state.stats;

        // Track previous lifetime counts BEFORE updating — fixes double-count bug
        const prevLiq = BigInt(s.lifetimeLiquidations);
        const prevForce = BigInt(s.lifetimeForceCloses);

        s.fundingRate = e.fundingRateBpsPerSlotLast.toString();
        s.fundingIndex = e.fundingIndexQpbE6.toString();
        s.openInterest = e.totalOpenInterest.toString();
        s.cTot = e.cTot.toString();
        s.pnlPosTot = e.pnlPosTot.toString();
        s.vaultBalance = e.vault.toString();
        s.insuranceBalance = e.insuranceFund.balance.toString();
        s.insuranceFeeRevenue = e.insuranceFund.feeRevenue.toString();

        const oi = Number(e.totalOpenInterest);
        const insBalance = Number(e.insuranceFund.balance);
        s.insuranceHealthRatio = oi > 0 ? insBalance / oi : 999;

        s.lpNetPos = e.netLpPos.toString();
        s.lpSumAbs = e.lpSumAbs.toString();
        s.lpMaxAbs = e.lpMaxAbs.toString();
        s.currentSlot = e.currentSlot.toString();
        s.lastCrankSlot = e.lastCrankSlot.toString();
        s.crankStaleness = Number(e.currentSlot - e.lastCrankSlot);
        s.lifetimeLiquidations = e.lifetimeLiquidations.toString();
        s.lifetimeForceCloses = e.lifetimeForceCloses.toString();
        s.numAccounts = e.numUsedAccounts;
        s.riskReductionThreshold = p.riskReductionThreshold.toString();
        s.maintenanceMarginBps = p.maintenanceMarginBps.toString();
        s.initialMarginBps = p.initialMarginBps.toString();

        // Detect new on-chain liquidations/force-closes via lifetime counter delta
        if (e.lifetimeLiquidations > prevLiq) {
          const newLiqs = Number(e.lifetimeLiquidations - prevLiq);
          s.liquidationsCount += newLiqs;
        }
        if (e.lifetimeForceCloses > prevForce) {
          s.forceCloseCount += Number(e.lifetimeForceCloses - prevForce);
        }

        // Funding history snapshot
        s.fundingHistory.push({
          timestamp: Date.now(),
          rateBpsPerSlot: e.fundingRateBpsPerSlotLast.toString(),
          indexE6: e.fundingIndexQpbE6.toString(),
        });
        if (s.fundingHistory.length > 500) {
          s.fundingHistory = s.fundingHistory.slice(-500);
        }
      }
    } catch (err) {
      console.error("Slab refresh error:", err);
    }
  }

  // --------------------------------------------------------------------------
  // Oracle Price Loop
  // --------------------------------------------------------------------------

  private async oracleTick(slab: PublicKey): Promise<void> {
    if (!this.state?.running || !this.oracleKeypair) return;

    try {
      // Fetch live price
      const livePrice = await fetchPythPrice();
      if (livePrice) {
        this.state.livePriceE6 = BigInt(Math.round(livePrice * 1_000_000));
      }

      const basePrice = this.state.scenario === "live"
        ? (livePrice ?? this.state.currentPrice)
        : this.scenarioBasePrice;
      const elapsed = Date.now() - this.scenarioStartTime;
      const scenarioPrice = applyScenario(basePrice, this.state.scenario, elapsed);

      // Clamp to positive, guard NaN
      const finalPrice = Math.max(Number.isFinite(scenarioPrice) ? scenarioPrice : basePrice, 0.01);
      const priceE6 = BigInt(Math.round(finalPrice * 1_000_000));
      const now = Math.floor(Date.now() / 1000);

      // PushOraclePrice + KeeperCrank in one tx
      const pushData = encodePushOraclePrice({ priceE6, timestamp: BigInt(now) });
      const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
        this.oracleKeypair.publicKey,
        slab,
      ]);
      const pushIx = buildIx({ programId: this.programId, keys: pushKeys, data: pushData });

      const crankData = encodeKeeperCrank({ callerIdx: 0, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        this.oracleKeypair.publicKey,
        slab,
        WELL_KNOWN.clock,
        WELL_KNOWN.systemProgram,
      ]);
      const crankIx = buildIx({ programId: this.programId, keys: crankKeys, data: crankData });

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(pushIx);
      tx.add(crankIx);

      const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.oracleKeypair.publicKey;

      await this.connection.sendTransaction(tx, [this.oracleKeypair], {
        skipPreflight: true,
      });

      this.state.currentPriceE6 = priceE6;
      this.state.currentPrice = finalPrice;
      this.state.stats.oraclePushes++;
      this.state.stats.cranks++;

      // Track high/low
      const priceNum = Number(priceE6);
      if (priceNum > this.highPriceE6) this.highPriceE6 = priceNum;
      if (priceNum < this.lowPriceE6) this.lowPriceE6 = priceNum;

      // Price history
      const point: PricePoint = {
        timestamp: Date.now(),
        price: finalPrice,
        priceE6: priceE6.toString(),
        scenario: this.state.scenario,
      };
      this.priceHistory.push(point);
      if (this.priceHistory.length > 1000) {
        this.priceHistory = this.priceHistory.slice(-1000);
      }
    } catch (err) {
      console.error("Oracle tick error:", err);
    }
  }

  // --------------------------------------------------------------------------
  // Bot Fleet
  // --------------------------------------------------------------------------

  private async initBots(slab: PublicKey): Promise<void> {
    if (!this.state || !this.oracleKeypair) return;

    // Read slab
    await this.refreshSlabState(slab);
    if (!this.cachedConfig) {
      console.error("Cannot read slab config for bot init");
      return;
    }

    const vault = this.cachedConfig.vaultPubkey;
    const mint = this.cachedConfig.collateralMint;
    const payer = this.oracleKeypair;

    // Ensure oracle keypair has an ATA with enough tokens for all bot deposits
    // Total needed: 50M + 30M + 5M + 200M + 4x100K fees = 285.4M tokens
    const totalTokensNeeded = BigInt(500_000_000); // 500M to be safe
    try {
      const ata = await getAssociatedTokenAddress(mint, payer.publicKey);
      let needsCreate = false;
      try {
        await getAccount(this.connection, ata);
      } catch (e) {
        if (e instanceof TokenAccountNotFoundError) {
          needsCreate = true;
        }
      }

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));

      if (needsCreate) {
        tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint));
      }

      // Mint tokens — oracle keypair is the mint authority (it created the market)
      tx.add(createMintToInstruction(mint, ata, payer.publicKey, totalTokensNeeded));

      const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;

      await this.connection.sendTransaction(tx, [payer], { skipPreflight: true });
      console.log(`🪙 Minted ${totalTokensNeeded} tokens to oracle ATA for bot funding`);
      await new Promise((r) => setTimeout(r, 2000)); // wait for confirmation
    } catch (err) {
      console.error("Failed to mint tokens for bots:", err);
      // Continue anyway — bots will fail individually
    }

    // Initialize each bot sequentially (avoid nonce conflicts)
    for (const bot of this.state.bots) {
      // InsuranceBot doesn't need a trading account
      if (bot.type === "InsuranceBot") {
        bot.initialized = true;
        bot.funded = true;
        this.startBotLoop(slab, bot);
        continue;
      }

      try {
        await this.initSingleBot(slab, bot, vault, mint);
        await new Promise((r) => setTimeout(r, 1500)); // wait for confirmation
        this.startBotLoop(slab, bot);
      } catch (err) {
        console.error(`Failed to init bot ${bot.name}:`, err);
        this.state.stats.botErrors++;
      }
    }
  }

  private async initSingleBot(
    slab: PublicKey,
    bot: BotState,
    vault: PublicKey,
    mint: PublicKey,
  ): Promise<void> {
    if (!this.oracleKeypair) return;
    const payer = this.oracleKeypair;
    const userAta = await getAssociatedTokenAddress(mint, payer.publicKey);

    // InitUser
    const initData = encodeInitUser({ feePayment: BigInt(100_000) });
    const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      payer.publicKey, slab, userAta, vault, WELL_KNOWN.tokenProgram,
    ]);
    const initIx = buildIx({ programId: this.programId, keys: initKeys, data: initData });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(initIx);
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;

    try {
      const sig = await this.connection.sendTransaction(tx, [payer], { skipPreflight: true });
      bot.initialized = true;
      console.log(`✅ ${bot.name} InitUser sent (sig=${sig.slice(0, 16)}...)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`InitUser failed for ${bot.name}: ${msg}`);
      return; // Don't try to deposit if init failed
    }

    // Wait then find account index
    await new Promise((r) => setTimeout(r, 2500));
    await this.refreshSlabState(slab);

    const usedIdxs = new Set(
      this.state?.bots.filter((b) => b.accountIdx !== null).map((b) => b.accountIdx) ?? [],
    );
    const ownedUserAccounts = this.cachedAccounts.filter(
      ({ idx, account }) =>
        account.owner.equals(payer.publicKey) &&
        account.kind === AccountKind.User &&
        !usedIdxs.has(idx),
    );
    if (ownedUserAccounts.length === 0) {
      console.error(`No account found for ${bot.name} after init`);
      return;
    }
    // Take the last created one (newest, not yet assigned)
    bot.accountIdx = ownedUserAccounts[ownedUserAccounts.length - 1].idx;

    // DepositCollateral — aggressive amounts for demo
    const depositAmounts: Record<string, bigint> = {
      MarketMaker: BigInt(50_000_000),    // 50 USDC
      TrendFollower: BigInt(30_000_000),  // 30 USDC
      LiquidationBot: BigInt(5_000_000),  // 5 USDC — deliberately low for liquidation demos
      WhaleBot: BigInt(200_000_000),      // 200 USDC — big player
    };
    const depositAmount = depositAmounts[bot.type] ?? BigInt(10_000_000);

    const depositData = encodeDepositCollateral({
      userIdx: bot.accountIdx,
      amount: depositAmount,
    });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, slab, userAta, vault, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const depositIx = buildIx({ programId: this.programId, keys: depositKeys, data: depositData });

    const tx2 = new Transaction();
    tx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx2.add(depositIx);
    const { blockhash: bh2 } = await this.connection.getLatestBlockhash("confirmed");
    tx2.recentBlockhash = bh2;
    tx2.feePayer = payer.publicKey;

    try {
      const sig2 = await this.connection.sendTransaction(tx2, [payer], { skipPreflight: true });
      bot.funded = true;
      console.log(`💰 ${bot.name} funded (idx=${bot.accountIdx}, amount=${depositAmount}, sig=${sig2.slice(0, 16)}...)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Deposit failed for ${bot.name} (idx=${bot.accountIdx}): ${msg}`);
    }
  }

  private startBotLoop(slab: PublicKey, bot: BotState): void {
    if (!this.state?.running) return;

    const tick = async () => {
      if (!this.state?.running || !this.oracleKeypair) return;

      try {
        switch (bot.type) {
          case "MarketMaker":
            await this.botMarketMaker(slab, bot);
            break;
          case "TrendFollower":
            await this.botTrendFollower(slab, bot);
            break;
          case "LiquidationBot":
            await this.botLiquidator(slab, bot);
            break;
          case "WhaleBot":
            await this.botWhale(slab, bot);
            break;
          case "InsuranceBot":
            await this.botInsurance(slab);
            break;
        }
      } catch (err) {
        console.error(`Bot ${bot.name} error:`, err);
        this.state!.stats.botErrors++;
      }

      if (this.state?.running) {
        const jitter = Math.random() * 2000;
        const timer = setTimeout(() => {
          // Remove self from tracking array to prevent unbounded growth
          const idx = this.botTimers.indexOf(timer);
          if (idx !== -1) this.botTimers.splice(idx, 1);
          void tick();
        }, bot.tradeInterval + jitter);
        this.botTimers.push(timer);
      }
    };

    // Stagger starts
    const delay = 2000 + Math.random() * 3000;
    const timer = setTimeout(() => void tick(), delay);
    this.botTimers.push(timer);
  }

  // --------------------------------------------------------------------------
  // Bot: MarketMaker — creates inventory imbalance → drives funding rates
  // --------------------------------------------------------------------------

  private async botMarketMaker(slab: PublicKey, bot: BotState): Promise<void> {
    if (bot.accountIdx === null) return;

    const price = this.state!.currentPrice;
    // Bias towards creating imbalance: 70% long in normal, flip on crash
    const scenario = this.state!.scenario;
    const longBias = (scenario === "crash" || scenario === "blackswan") ? 0.3 : 0.7;
    const isLong = Math.random() < longBias;

    // Decent size to move funding
    const sizeUsd = 200 + Math.random() * 500;
    const sizeUnits = (sizeUsd / price) * 1_000_000;
    const size = BigInt(Math.round(isLong ? sizeUnits : -sizeUnits));

    await this.sendTrade(slab, bot, size, sizeUsd);
  }

  // --------------------------------------------------------------------------
  // Bot: TrendFollower — momentum trades that compound with whale
  // --------------------------------------------------------------------------

  private async botTrendFollower(slab: PublicKey, bot: BotState): Promise<void> {
    if (bot.accountIdx === null) return;

    const recentPrices = this.priceHistory.slice(-10);
    if (recentPrices.length < 3) return;

    const first = recentPrices[0].price;
    const last = recentPrices[recentPrices.length - 1].price;
    const momentum = (last - first) / first;

    // Follow momentum aggressively
    const isLong = momentum > 0;
    const intensity = Math.min(Math.abs(momentum) * 20, 3); // scale up with momentum
    const sizeUsd = (150 + Math.random() * 300) * (1 + intensity);
    const sizeUnits = (sizeUsd / this.state!.currentPrice) * 1_000_000;
    const size = BigInt(Math.round(isLong ? sizeUnits : -sizeUnits));

    await this.sendTrade(slab, bot, size, sizeUsd);
  }

  // --------------------------------------------------------------------------
  // Bot: WhaleBot — large positions, stress OI, trigger risk-reduction
  // --------------------------------------------------------------------------

  private async botWhale(slab: PublicKey, bot: BotState): Promise<void> {
    if (bot.accountIdx === null) return;

    const scenario = this.state!.scenario;
    const price = this.state!.currentPrice;

    // Whale always takes directional bets
    let isLong: boolean;
    switch (scenario) {
      case "crash":
      case "blackswan":
        isLong = false; // Short into the crash
        break;
      case "squeeze":
        isLong = true; // Long into squeeze
        break;
      default:
        isLong = Math.random() > 0.4; // Slight long bias
    }

    // BIG sizes — push OI high
    const sizeUsd = 1000 + Math.random() * 3000;
    const sizeUnits = (sizeUsd / price) * 1_000_000;
    const size = BigInt(Math.round(isLong ? sizeUnits : -sizeUnits));

    await this.sendTrade(slab, bot, size, sizeUsd);
  }

  // --------------------------------------------------------------------------
  // Bot: LiquidationBot — scans & liquidates underwater positions
  // --------------------------------------------------------------------------

  private async botLiquidator(slab: PublicKey, bot: BotState): Promise<void> {
    if (!this.cachedAccounts.length || !this.oracleKeypair) return;

    const payer = this.oracleKeypair;
    let liquidated = 0;

    for (const { idx, account } of this.cachedAccounts) {
      if (account.kind !== AccountKind.User) continue;
      if (account.positionSize === 0n) continue;

      // Check if margin is breached
      const capital = Number(account.capital);
      const pnl = Number(account.pnl);
      const equity = capital + pnl;
      const posNotional = Math.abs(Number(account.positionSize)) / 1_000_000 * this.state!.currentPrice;

      // Maintenance margin check (using cached params)
      const maintMarginBps = this.cachedParams ? Number(this.cachedParams.maintenanceMarginBps) : 500;
      const requiredMargin = posNotional * maintMarginBps / 10_000;

      if (equity < requiredMargin && equity < capital * 0.5) {
        // Attempt liquidation
        const liqData = encodeLiquidateAtOracle({ targetIdx: idx });
        const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
          payer.publicKey,
          slab,
          WELL_KNOWN.clock,
          WELL_KNOWN.systemProgram,
        ]);
        const liqIx = buildIx({ programId: this.programId, keys: liqKeys, data: liqData });

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(liqIx);
        const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = payer.publicKey;

        try {
          const sig = await this.connection.sendTransaction(tx, [payer], { skipPreflight: true });
          liquidated++;
          // Note: liquidationsCount is incremented via on-chain lifetime counter delta
          // in refreshSlabState() — no manual increment here to avoid double-counting
          this.state!.stats.liquidationVolume += posNotional;
          console.log(`⚡ LIQUIDATION idx=${idx} equity=$${equity.toFixed(2)} required=$${requiredMargin.toFixed(2)} sig=${sig.slice(0, 12)}...`);
        } catch {
          // May not be liquidatable on-chain yet
        }
      }
    }

    if (liquidated > 0) {
      bot.trades += liquidated;
    }
  }

  // --------------------------------------------------------------------------
  // Bot: InsuranceBot — monitors & tops up insurance fund
  // --------------------------------------------------------------------------

  private async botInsurance(slab: PublicKey): Promise<void> {
    if (!this.cachedEngine || !this.oracleKeypair || !this.cachedConfig) return;

    const insuranceBalance = Number(this.cachedEngine.insuranceFund.balance);
    const oi = Number(this.cachedEngine.totalOpenInterest);
    const healthRatio = oi > 0 ? insuranceBalance / oi : 999;

    // Top up if health ratio is below 10%
    if (healthRatio < 0.10 && oi > 0) {
      const topUpAmount = BigInt(Math.round(oi * 0.05)); // top up 5% of OI
      if (topUpAmount <= 0n) return;

      const payer = this.oracleKeypair;
      const mint = this.cachedConfig.collateralMint;
      const vault = this.cachedConfig.vaultPubkey;
      const userAta = await getAssociatedTokenAddress(mint, payer.publicKey);

      const topUpData = encodeTopUpInsurance({ amount: topUpAmount });
      const topUpKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
        payer.publicKey, slab, userAta, vault, WELL_KNOWN.tokenProgram,
      ]);
      const topUpIx = buildIx({ programId: this.programId, keys: topUpKeys, data: topUpData });

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(topUpIx);
      const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;

      try {
        const sig = await this.connection.sendTransaction(tx, [payer], { skipPreflight: true });
        console.log(`🛡️  Insurance top-up: ${topUpAmount} (ratio was ${(healthRatio * 100).toFixed(1)}%) sig=${sig.slice(0, 12)}...`);
      } catch (err) {
        console.error("Insurance top-up failed:", err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Shared: Send Trade
  // --------------------------------------------------------------------------

  private async sendTrade(
    slab: PublicKey,
    bot: BotState,
    size: bigint,
    notionalUsd: number,
  ): Promise<void> {
    if (!this.oracleKeypair || bot.accountIdx === null) return;

    const payer = this.oracleKeypair;
    const tradeData = encodeTradeNoCpi({
      lpIdx: this.lpIdx,
      userIdx: bot.accountIdx,
      size: size.toString(),
    });

    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
      payer.publicKey,  // user
      payer.publicKey,  // lp (same keypair for sim)
      slab,
      WELL_KNOWN.clock,
      WELL_KNOWN.systemProgram, // dummy oracle for Hyperp
    ]);
    const tradeIx = buildIx({ programId: this.programId, keys: tradeKeys, data: tradeData });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(tradeIx);
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;

    try {
      await this.connection.sendTransaction(tx, [payer], { skipPreflight: true });
      bot.trades++;
      bot.lastTradeTime = Date.now();
      this.state!.stats.tradesCount++;
      this.state!.stats.volume += notionalUsd;
    } catch (err) {
      console.error(`Trade failed for ${bot.name}:`, err);
      this.state!.stats.botErrors++;
    }
  }
}
