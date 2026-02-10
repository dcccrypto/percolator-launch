import { createClient } from "@supabase/supabase-js";

// Lazy singletons — avoids build-time crashes when env vars aren't available during SSG
let _anonClient: ReturnType<typeof createClient> | null = null;
let _serviceClient: ReturnType<typeof createClient> | null = null;

export function getSupabase() {
  if (!_anonClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase env vars not set");
    _anonClient = createClient(url, key);
  }
  return _anonClient;
}

/** @deprecated Use getSupabase() instead */
export const supabase = null as unknown as ReturnType<typeof createClient>;

// Server-side (service role, bypasses RLS)
export function getServiceClient() {
  if (!_serviceClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new Error("Supabase env vars not set");
    _serviceClient = createClient(url, serviceKey);
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
  price_change_24h: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  num_traders: number | null;
  vault_balance: number | null;
  insurance_balance: number | null;
  last_crank_slot: number | null;
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
