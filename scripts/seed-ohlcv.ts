#!/usr/bin/env npx tsx
/**
 * PERC-375: Pre-seed 14 days of OHLCV price history into oracle_prices
 *
 * Generates realistic synthetic price data for all devnet markets so charts
 * are not empty on first load. Uses geometric Brownian motion with
 * mean-reversion to create believable price movements.
 *
 * Usage:
 *   npx tsx scripts/seed-ohlcv.ts                  # dry-run (prints stats)
 *   npx tsx scripts/seed-ohlcv.ts --commit          # write to Supabase
 *   npx tsx scripts/seed-ohlcv.ts --days 7          # 7 days instead of 14
 *   npx tsx scripts/seed-ohlcv.ts --interval 120    # 2-minute candles (default: 60s)
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_KEY)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DAYS = parseInt(process.argv.find((a) => a === "--days")
  ? process.argv[process.argv.indexOf("--days") + 1]
  : "14");

const INTERVAL_S = parseInt(process.argv.find((a) => a === "--interval")
  ? process.argv[process.argv.indexOf("--interval") + 1]
  : "60"); // default 60s between price points

const COMMIT = process.argv.includes("--commit");

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Price generation — geometric Brownian motion with mean-reversion
// ---------------------------------------------------------------------------

/** Generate N price points using mean-reverting GBM */
function generatePriceSeries(
  anchorPrice: number,
  count: number,
  volatility = 0.02, // daily vol as fraction
): number[] {
  const dt = INTERVAL_S / 86400; // fraction of a day
  const sigma = volatility * Math.sqrt(dt);
  const kappa = 0.05; // mean-reversion speed per step
  const prices: number[] = [];

  // Start slightly off anchor for realism
  let price = anchorPrice * (0.95 + Math.random() * 0.10);

  for (let i = 0; i < count; i++) {
    const drift = kappa * (Math.log(anchorPrice) - Math.log(price)) * dt;
    const shock = sigma * normalRandom();
    price = price * Math.exp(drift + shock);
    // Clamp to avoid absurd values
    price = Math.max(price * 0.01, Math.min(price * 100, price));
    prices.push(price);
  }

  return prices;
}

function normalRandom(): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`🕐 Seeding ${DAYS} days of price history (interval: ${INTERVAL_S}s)`);
  console.log(`   Mode: ${COMMIT ? "COMMIT (writing to DB)" : "DRY-RUN (use --commit to write)"}`);

  // 1. Fetch all markets
  const { data: markets, error: mktErr } = await db
    .from("markets")
    .select("slab_address, token_name, token_symbol");

  if (mktErr || !markets || markets.length === 0) {
    console.error("❌ No markets found:", mktErr?.message);
    process.exit(1);
  }

  console.log(`📊 Found ${markets.length} markets`);

  // 2. Fetch latest known prices from market_stats
  const { data: stats } = await db
    .from("market_stats")
    .select("slab_address, mark_price_e6, last_price");

  const priceMap = new Map<string, number>();
  for (const s of stats ?? []) {
    const priceE6 = s.mark_price_e6 ?? s.last_price;
    if (priceE6 && Number(priceE6) > 0) {
      priceMap.set(s.slab_address, Number(priceE6) / 1_000_000);
    }
  }

  // 3. Check for existing oracle_prices to avoid duplicating
  const { count: existingCount } = await db
    .from("oracle_prices")
    .select("id", { count: "exact", head: true });

  if ((existingCount ?? 0) > 1000 && !process.argv.includes("--force")) {
    console.log(`⚠️  oracle_prices already has ${existingCount} rows. Use --force to re-seed.`);
    if (!COMMIT) {
      console.log("   (dry-run, would skip)");
    } else {
      console.log("   Skipping. Pass --force to overwrite.");
      process.exit(0);
    }
  }

  // 4. Generate and insert price history per market
  const now = Date.now();
  const startMs = now - DAYS * 24 * 60 * 60 * 1000;
  const pointsPerMarket = Math.floor((DAYS * 24 * 60 * 60) / INTERVAL_S);

  let totalPoints = 0;
  let marketsDone = 0;

  for (const market of markets) {
    const anchor = priceMap.get(market.slab_address);
    if (!anchor || anchor <= 0) {
      // Assign a reasonable synthetic price based on symbol
      const fallback = guessFallbackPrice(market.token_symbol);
      console.log(`   ⚠️  ${market.token_symbol ?? market.slab_address.slice(0, 8)}: no on-chain price, using fallback $${fallback}`);
      priceMap.set(market.slab_address, fallback);
    }

    const basePrice = priceMap.get(market.slab_address)!;
    // Vary volatility: majors (BTC/ETH/SOL) lower vol, memes higher
    const vol = isMajor(market.token_symbol) ? 0.015 : 0.04;
    const series = generatePriceSeries(basePrice, pointsPerMarket, vol);

    // Build rows
    const rows = series.map((price, i) => ({
      slab_address: market.slab_address,
      price_e6: Math.round(price * 1_000_000).toString(),
      source: "seed",
      timestamp: startMs + i * INTERVAL_S * 1000,
    }));

    if (COMMIT) {
      // Insert in batches of 1000
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000);
        const { error } = await db.from("oracle_prices").insert(batch);
        if (error) {
          console.error(`   ❌ Insert failed for ${market.token_symbol}: ${error.message}`);
          break;
        }
      }
    }

    totalPoints += rows.length;
    marketsDone++;
    if (marketsDone % 10 === 0) {
      console.log(`   ${marketsDone}/${markets.length} markets processed...`);
    }
  }

  console.log(`\n✅ Done: ${marketsDone} markets, ${totalPoints.toLocaleString()} total price points`);
  if (!COMMIT) {
    console.log("   Run with --commit to write to Supabase.");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMajor(symbol: string | null): boolean {
  if (!symbol) return false;
  const s = symbol.toUpperCase();
  return ["BTC", "ETH", "SOL", "AVAX", "MATIC", "BNB", "ADA", "DOT", "LINK"].includes(s);
}

function guessFallbackPrice(symbol: string | null): number {
  if (!symbol) return 1.0;
  const s = symbol.toUpperCase();
  const known: Record<string, number> = {
    BTC: 85000, ETH: 3200, SOL: 140, AVAX: 35, BNB: 600,
    ADA: 0.7, DOT: 7, LINK: 18, MATIC: 0.5, DOGE: 0.12,
    BONK: 0.000025, WIF: 1.8, JTO: 3.5, JUP: 0.8, PYTH: 0.4,
    RNDR: 8, HNT: 5, RAY: 2, ORCA: 4, MNGO: 0.03,
  };
  return known[s] ?? 1.0;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
