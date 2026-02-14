import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Lazy singletons — avoids build-time crashes when env vars aren't available during SSG
let _anonClient: ReturnType<typeof createClient<Database>> | null = null;
let _serviceClient: ReturnType<typeof createClient<Database>> | null = null;

export function getSupabase() {
  if (!_anonClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase env vars not set");
    _anonClient = createClient<Database>(url, key);
  }
  return _anonClient;
}

/** @deprecated Use getSupabase() instead */
export const supabase = null as unknown as ReturnType<typeof createClient<Database>>;

// Server-side (service role, bypasses RLS)
export function getServiceClient() {
  if (!_serviceClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error("Supabase env vars not set");
    _serviceClient = createClient<Database>(url, serviceKey);
  }
  return _serviceClient;
}

export interface Market {
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
  lp_collateral: number | null;
  matcher_context: string | null;
  status: string;
  created_at: string;
}

export interface MarketWithStats extends Market {
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
  stats_updated_at: string | null;
}

export interface Trade {
  id: string;
  slab_address: string;
  trader: string;
  side: "long" | "short";
  size: number;
  price: number;
  fee: number;
  tx_signature: string | null;
  created_at: string;
}

export interface OraclePrice {
  id: number;
  slab_address: string;
  price_e6: number;
  timestamp: number;
  created_at: string;
}
