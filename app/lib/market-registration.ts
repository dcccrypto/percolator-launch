/**
 * The single write that registers a market.
 *
 * WHY THIS EXISTS
 * ---------------
 * Registration used to take two writes to two stores — a Vercel blob for the
 * keeper's list and the `markets` row for metadata — and the one carrying the
 * creator's intent lost. `POST /api/markets` 409s when a row already exists
 * ("Existing metadata is immutable via this endpoint"), the launch flow swallows
 * that as non-fatal, and the indexer's syncMarkets() inserts a row for any slab
 * it discovers within ~60s with `metadata_source` defaulting to 'auto'. The slab
 * exists on chain before the app POSTs, so the indexer usually wins.
 *
 * Measured on the live database 2026-07-30: all 5 market rows had
 * metadata_source='auto'. `POST /api/markets` had never once created a row. Four
 * of the five were unidentified — symbol='UNKNOWN', name='Market 6RobABa7', no
 * pool address — and every row's `deployer` held the sim-USDC MINT rather than a
 * wallet. The race was not occasional; it was the only outcome.
 *
 * This module is the fix. It is called from the registration route, AFTER that
 * route has verified the caller against the slab's live on-chain marketauth, so
 * every branch below is already authenticated. That is what lets an 'auto' row
 * be overwritten safely: the blanket 409 existed to stop tampering-by-replay,
 * and the marketauth proof stops that far more precisely than refusing all
 * updates.
 *
 * See docs/MARKET-REGISTRATION-SPEC-2026-07-30.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Everything registration writes. Display fields come from the creator. */
export interface RegistrationRow {
  slab_address: string;
  mint_address: string;
  symbol: string;
  name: string;
  decimals: number;
  deployer: string;
  dex_pool_address: string;
  mainnet_ca: string | null;
  oracle_mode: string;
  network: string;
  /** Derived fields from the wizard's buildMarketRegistrationPayload. Null when
   *  re-registering an already-listed market (the retry path has no
   *  CreateMarketParams to derive them from) — see the null-strip below, which
   *  keeps an existing row's values rather than blanking them. */
  oracle_authority?: string | null;
  initial_price_e6?: string | null;
  lp_collateral?: string | null;
  max_leverage?: number | null;
  trading_fee_bps?: number | null;
  logo_url?: string | null;
}

export type UpsertResult =
  | { ok: true; action: "inserted" | "updated" }
  | { ok: false; status: number; error: string };

/**
 * Insert or update the market row.
 *
 *   no row                     -> insert, metadata_source='manual', keeper_status='active'
 *   existing metadata_source='auto'   -> update; the creator beats the indexer's guess
 *   existing metadata_source='manual' -> idempotent update (re-registration/retry)
 *
 * The 'manual' branch is an update rather than a 409 because reaching it already
 * required signing against the slab's on-chain marketauth — the same wallet is
 * re-registering, which is exactly what the retry path does. A caller who cannot
 * sign never gets here.
 *
 * `keeper_status='active'` is set here and only here. The indexer's inserts take
 * the column default ('retired'), so auto-discovery can never enroll a market
 * for pricing.
 */
export async function upsertRegisteredMarketRow(
  supabase: SupabaseClient,
  row: RegistrationRow,
): Promise<UpsertResult> {
  const { data: existing, error: readErr } = await supabase
    .from("markets")
    .select("id, metadata_source")
    .eq("slab_address", row.slab_address)
    .eq("network", row.network)
    .maybeSingle();

  if (readErr) {
    return { ok: false, status: 500, error: "Failed to read existing market state" };
  }

  // Drop null/undefined optional fields before writing. The retry path
  // re-registers an already-listed market and has no CreateMarketParams to
  // derive max_leverage / trading_fee_bps / oracle_authority from, so it sends
  // nulls; writing those would blank a correct row back to nothing. Absent
  // means "leave whatever is there" — on INSERT the column defaults apply.
  const payload: Record<string, unknown> = { metadata_source: "manual", keeper_status: "active" };
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) payload[k] = v;
  }

  if (!existing) {
    const { error } = await supabase.from("markets").insert(payload as never);
    if (error) {
      // 23505: a concurrent writer (almost always the indexer's discovery pass)
      // inserted between our read and this write. Fall through to an update so
      // the creator's metadata still lands, rather than failing the launch.
      if (error.code === "23505") {
        const { error: updErr } = await supabase
          .from("markets")
          .update(payload as never)
          .eq("slab_address", row.slab_address)
          .eq("network", row.network);
        if (updErr) return { ok: false, status: 500, error: "Failed to register market" };
        return { ok: true, action: "updated" };
      }
      return { ok: false, status: 500, error: "Failed to register market" };
    }
    return { ok: true, action: "inserted" };
  }

  const { error: updErr } = await supabase
    .from("markets")
    .update(payload as never)
    .eq("slab_address", row.slab_address)
    .eq("network", row.network);
  if (updErr) return { ok: false, status: 500, error: "Failed to update market registration" };
  return { ok: true, action: "updated" };
}
