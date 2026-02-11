import { getSupabase } from "../db/client.js";
import { config } from "../config.js";
import type { CrankService } from "./crank.js";
import { getConnection } from "../utils/solana.js";
import { deriveInsuranceLpMint } from "@percolator/core";
import { PublicKey } from "@solana/web3.js";

const POLL_INTERVAL_MS = 30_000;
const MS_PER_DAY = 86_400_000;

interface InsuranceSnapshot {
  slab: string;
  insurance_balance: number;
  lp_supply: number;
  redemption_rate_e6: number;
  snapshot_slot: number;
  created_at: string;
}

interface InsuranceStats {
  balance: number;
  lpSupply: number;
  redemptionRate: number;
  apy7d: number | null;
  apy30d: number | null;
}

export class InsuranceLPService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly crankService: CrankService;
  private cache = new Map<string, InsuranceStats>();

  constructor(crankService: CrankService) {
    this.crankService = crankService;
  }

  start(): void {
    if (this.timer) return;
    if (!config.supabaseUrl || !config.supabaseKey) {
      console.warn("[InsuranceLPService] SUPABASE_URL/KEY not set — service disabled");
      return;
    }
    this.poll().catch((e) => console.error("[InsuranceLPService] initial poll error:", e));
    this.timer = setInterval(() => {
      this.poll().catch((e) => console.error("[InsuranceLPService] poll error:", e));
    }, POLL_INTERVAL_MS);
    console.log("[InsuranceLPService] started — polling every 30s");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(slab: string): InsuranceStats | null {
    return this.cache.get(slab) ?? null;
  }

  private async poll(): Promise<void> {
    const markets = this.crankService.getMarkets();
    const connection = getConnection();

    for (const [slab, state] of markets.entries()) {
      try {
        const engine = state.market.engine;
        
        // Get real insurance balance from on-chain engine state
        const insuranceBalance = Number(engine.insuranceFund.balance);

        // Derive LP mint PDA and fetch supply (use per-market programId for multi-program support)
        const slabPubkey = new PublicKey(slab);
        const [lpMint] = deriveInsuranceLpMint(state.market.programId, slabPubkey);
        
        let lpSupply = 0;
        try {
          const mintInfo = await connection.getTokenSupply(lpMint);
          lpSupply = Number(mintInfo.value.amount);
        } catch (err) {
          // LP mint might not exist yet if no LPs have deposited
          console.warn(`[InsuranceLPService] LP mint not found for ${slab}:`, err);
        }

        const redemptionRateE6 =
          lpSupply > 0 ? Math.floor((insuranceBalance * 1_000_000) / lpSupply) : 1_000_000;

        // Record snapshot
        const db = getSupabase();
        await db.from("insurance_snapshots").insert({
          slab,
          insurance_balance: insuranceBalance,
          lp_supply: lpSupply,
          redemption_rate_e6: redemptionRateE6,
          snapshot_slot: Number(engine.lastCrankSlot),
        });

        // Compute APY from history
        const apy7d = await this.computeTrailingAPY(slab, 7);
        const apy30d = await this.computeTrailingAPY(slab, 30);

        this.cache.set(slab, {
          balance: insuranceBalance,
          lpSupply,
          redemptionRate: redemptionRateE6,
          apy7d,
          apy30d,
        });
      } catch (err) {
        console.error(`[InsuranceLPService] error polling ${slab}:`, err);
      }
    }
  }

  private async computeTrailingAPY(slab: string, days: number): Promise<number | null> {
    const db = getSupabase();
    const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();

    const { data, error } = await db
      .from("insurance_snapshots")
      .select("redemption_rate_e6, created_at")
      .eq("slab", slab)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(1);

    if (error || !data || data.length === 0) return null;

    const oldest = data[0] as InsuranceSnapshot;
    const oldRate = oldest.redemption_rate_e6;

    const current = this.cache.get(slab);
    if (!current || oldRate === 0) return null;

    const growth = (current.redemptionRate - oldRate) / oldRate;
    const elapsed = Date.now() - new Date(oldest.created_at).getTime();
    if (elapsed < MS_PER_DAY) return null; // need at least 1 day of data

    const annualized = growth * (365 * MS_PER_DAY) / elapsed;
    return Math.round(annualized * 10_000) / 10_000; // 4 decimal places
  }

  async getEvents(slab: string, limit = 50) {
    const db = getSupabase();
    const { data, error } = await db
      .from("insurance_lp_events")
      .select("*")
      .eq("slab", slab)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data ?? [];
  }

  async getDepositorCount(slab: string): Promise<number> {
    const db = getSupabase();
    const { data, error } = await db
      .from("insurance_lp_events")
      .select("user_wallet")
      .eq("slab", slab)
      .eq("event_type", "deposit");

    if (error) throw error;
    if (!data) return 0;
    const uniqueWallets = new Set(data.map((row: { user_wallet: string }) => row.user_wallet));
    return uniqueWallets.size;
  }
}
