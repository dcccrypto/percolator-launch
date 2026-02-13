import { getSupabase } from "./client.js";

export interface MarketRow {
  id: string;
  slab_address: string;
  mint: string;
  admin: string;
  oracle_type: string;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface MarketStatsRow {
  slab_address: string;
  last_crank_at: string;
  crank_success_count: number;
  crank_failure_count: number;
  last_price_e6: string;
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
  source: string;
  timestamp: string;
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
  const { error } = await getSupabase().from("oracle_prices").insert(price);
  if (error) throw error;
}

export async function getRecentTrades(slabAddress: string, limit = 50): Promise<TradeRow[]> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("slab_address", slabAddress)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as TradeRow[];
}

export async function getPriceHistory(
  slabAddress: string,
  since: string,
): Promise<OraclePriceRow[]> {
  const { data, error } = await getSupabase()
    .from("oracle_prices")
    .select("*")
    .eq("slab_address", slabAddress)
    .gte("timestamp", since)
    .order("timestamp", { ascending: true });
  if (error) throw error;
  return (data ?? []) as OraclePriceRow[];
}
