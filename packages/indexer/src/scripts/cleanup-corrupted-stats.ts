/**
 * One-time cleanup script: Reset corrupted market_stats values.
 *
 * Root cause: parseEngine reads fixed offsets from slab account data.
 * When the on-chain account is not a valid Percolator slab (or uses
 * a different layout), the parser returns garbage values like:
 *   - total_open_interest: 9.865e+34
 *   - insurance_balance: 1.844e+25
 *   - c_tot: 1.401e+35
 *
 * Also fixes corrupted decimals (values > 18) to default of 6.
 *
 * Run: npx tsx packages/indexer/src/scripts/cleanup-corrupted-stats.ts
 */
import { getSupabase } from "@percolator/shared";

const MAX_SANE_VALUE = 1e18;
const MAX_VALID_DECIMALS = 18;

async function main() {
  const supabase = getSupabase();

  // Fix corrupted decimals in markets table
  const { data: markets, error: marketsErr } = await supabase
    .from("markets")
    .select("slab_address, decimals, mint_address")
    .or(`decimals.gt.${MAX_VALID_DECIMALS},decimals.lt.0`);
  
  if (marketsErr) throw marketsErr;

  console.log(`Found ${markets?.length ?? 0} markets with invalid decimals`);
  
  for (const m of markets ?? []) {
    console.log(`  Fixing ${m.slab_address} (mint=${m.mint_address}): decimals ${m.decimals} → 6`);
    const { error } = await supabase
      .from("markets")
      .update({ decimals: 6 })
      .eq("slab_address", m.slab_address);
    if (error) console.error(`  ERROR: ${error.message}`);
  }

  // Reset corrupted stats values to null
  // Identify corrupted rows: total_open_interest > 1e18 or insurance_balance > 1e18
  const { data: corruptedStats, error: statsErr } = await supabase
    .from("markets")
    .select("slab_address, total_open_interest, insurance_balance, c_tot")
    .or(`total_open_interest.gt.${MAX_SANE_VALUE},insurance_balance.gt.${MAX_SANE_VALUE},c_tot.gt.${MAX_SANE_VALUE}`);

  if (statsErr) throw statsErr;

  console.log(`\nFound ${corruptedStats?.length ?? 0} markets with corrupted stats`);

  for (const s of corruptedStats ?? []) {
    console.log(`  Resetting stats for ${s.slab_address}`);
    const { error } = await supabase
      .from("markets")
      .update({
        total_open_interest: 0,
        open_interest_long: 0,
        open_interest_short: 0,
        insurance_fund: 0,
        insurance_balance: 0,
        insurance_fee_revenue: 0,
        vault_balance: 0,
        c_tot: 0,
        pnl_pos_tot: 0,
        net_lp_pos: "0",
        lp_sum_abs: 0,
        lp_max_abs: 0,
        total_accounts: 0,
        lifetime_liquidations: 0,
        lifetime_force_closes: 0,
      })
      .eq("slab_address", s.slab_address);
    if (error) console.error(`  ERROR: ${error.message}`);
  }

  console.log("\nCleanup complete!");
}

main().catch(console.error);
