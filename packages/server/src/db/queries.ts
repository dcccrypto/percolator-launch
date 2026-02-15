import { getSupabase } from "./client.js";

export interface MarketRow {
  id: string;
  slab_address: string;
  mint_address: string;
  symbol: string;
  name: string;
  decimals: number;
  deployer: string;
  oracle_authority: string | null;
  initial_price_e6: number | null;
  max_leverage: number;
  trading_fee_bps: number;
  lp_collateral: string | null;
  matcher_context: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MarketStatsRow {
  slab_address: string;
  last_price: number | null;
  mark_price: number | null;
  index_price: number | null;
  volume_24h: number | null;
  volume_total: number | null;
  open_interest_long: number | null;
  open_interest_short: number | null;
  insurance_fund: number | null;
  total_accounts: number | null;
  funding_rate: number | null;
  // Hidden features (migration 007)
  total_open_interest: number | null;
  net_lp_pos: string | null;
  lp_sum_abs: number | null;
  lp_max_abs: number | null;
  insurance_balance: number | null;
  insurance_fee_revenue: number | null;
  warmup_period_slots: number | null;
  // Complete RiskEngine fields (migration 010)
  vault_balance: number | null;
  lifetime_liquidations: number | null;
  lifetime_force_closes: number | null;
  c_tot: number | null;
  pnl_pos_tot: number | null;
  last_crank_slot: number | null;
  max_crank_staleness_slots: number | null;
  maintenance_fee_per_slot: string | null;
  liquidation_fee_bps: number | null;
  liquidation_fee_cap: string | null;
  liquidation_buffer_bps: number | null;
  updated_at: string | null;
}

export interface TradeRow {
  id: string;
  slab_address: string;
  trader: string;
  side: "long" | "short";
  size: number | string; // string for full BigInt precision (i128 on-chain)
  price: number;
  fee: number;
  tx_signature: string | null;
  created_at: string;
}

export interface OraclePriceRow {
  slab_address: string;
  price_e6: string;
  timestamp: number; // epoch seconds (BIGINT in DB)
  tx_signature?: string | null;
}

export async function getMarkets(): Promise<MarketRow[]> {
  const { data, error } = await getSupabase().from("markets").select("*");
  if (error) throw error;
  return (data ?? []) as MarketRow[];
}

export async function getMarketBySlabAddress(slabAddress: string): Promise<MarketRow | null> {
  const { data, error } = await getSupabase()
    .from("markets")
    .select("*")
    .eq("slab_address", slabAddress)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return (data as MarketRow) ?? null;
}

export async function insertMarket(market: Omit<MarketRow, "id" | "created_at" | "updated_at">): Promise<void> {
  const { error } = await getSupabase().from("markets").insert(market);
  // Ignore unique constraint violations (market already exists)
  if (error && error.code !== "23505") {
    throw error;
  }
}

export async function upsertMarketStats(stats: Partial<MarketStatsRow> & { slab_address: string }): Promise<void> {
  const { error } = await getSupabase()
    .from("market_stats")
    .upsert(stats, { onConflict: "slab_address" });
  if (error) throw error;
}

export async function insertTrade(trade: Omit<TradeRow, "id" | "created_at">): Promise<void> {
  const { error } = await getSupabase().from("trades").insert(trade);
  // BH8: Ignore unique constraint violations (23505 = unique_violation)
  // This allows the TradeIndexer to safely retry without crashing on duplicates
  if (error && error.code !== "23505") {
    throw error;
  }
}

export async function tradeExistsBySignature(txSignature: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("id")
    .eq("tx_signature", txSignature)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function insertOraclePrice(price: OraclePriceRow): Promise<void> {
  const { error } = await getSupabase().from("oracle_prices").insert({
    slab_address: price.slab_address,
    price_e6: price.price_e6,
    timestamp: price.timestamp,
    tx_signature: price.tx_signature ?? null,
  });
  if (error) throw error;
}

export async function getRecentTrades(slabAddress: string, limit = 50): Promise<TradeRow[]> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("slab_address", slabAddress)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as TradeRow[];
}

export async function get24hVolume(slabAddress: string): Promise<{ volume: string; tradeCount: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from("trades")
    .select("size")
    .eq("slab_address", slabAddress)
    .gte("created_at", since);
  if (error) throw error;
  let total = 0n;
  for (const row of data ?? []) {
    // size is stored as string for BigInt precision
    try {
      const abs = BigInt(row.size) < 0n ? -BigInt(row.size) : BigInt(row.size);
      total += abs;
    } catch {
      total += BigInt(Math.abs(Number(row.size)));
    }
  }
  return { volume: total.toString(), tradeCount: (data ?? []).length };
}

export async function getGlobalRecentTrades(limit = 50): Promise<TradeRow[]> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as TradeRow[];
}

export async function getPriceHistory(
  slabAddress: string,
  sinceEpoch: number,
): Promise<OraclePriceRow[]> {
  const { data, error } = await getSupabase()
    .from("oracle_prices")
    .select("*")
    .eq("slab_address", slabAddress)
    .gte("timestamp", sinceEpoch)
    .order("timestamp", { ascending: true });
  if (error) throw error;
  return (data ?? []) as OraclePriceRow[];
}

export interface FundingHistoryRow {
  id: string;
  market_slab: string;
  slot: number;
  timestamp: string;
  rate_bps_per_slot: number;
  net_lp_pos: string;
  price_e6: number;
  funding_index_qpb_e6: string;
  created_at: string;
}

export async function insertFundingHistory(record: {
  market_slab: string;
  slot: number;
  timestamp: string;
  rate_bps_per_slot: number;
  net_lp_pos: string;
  price_e6: number;
  funding_index_qpb_e6: string;
}): Promise<void> {
  const { error } = await getSupabase().from("funding_history").insert(record);
  if (error) throw error;
}

export async function getFundingHistory(slabAddress: string, limit: number = 100): Promise<FundingHistoryRow[]> {
  const { data, error } = await getSupabase()
    .from("funding_history")
    .select("*")
    .eq("market_slab", slabAddress)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getFundingHistorySince(slabAddress: string, sinceTimestamp: string): Promise<FundingHistoryRow[]> {
  const { data, error } = await getSupabase()
    .from("funding_history")
    .select("*")
    .eq("market_slab", slabAddress)
    .gte("timestamp", sinceTimestamp)
    .order("timestamp", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
