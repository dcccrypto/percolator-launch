/**
 * PERC-423: One-time backfill script — fix price=0 trades in DB.
 *
 * Root cause: prior to PERC-421, extractPriceFromLogs() used a rigid 5-value
 * regex that missed most trades → price stored as 0.
 *
 * Strategy:
 * 1. Fetch all trades WHERE price = 0 AND tx_signature IS NOT NULL
 * 2. Batch-request Helius Parse Transactions API (up to 100 sigs per call)
 * 3. Extract mark_price_e6 from slab account post-state data (same logic as
 *    the PERC-421 webhook fix, auto-detecting V0/V1 layout from data length;
 *    V0 slabs have no mark_price field; V1: ENGINE_OFF=640 + ENGINE_MARK_PRICE_OFF=400)
 * 4. UPDATE trades SET price = <recovered> WHERE id = <id>
 * 5. Print a summary (fixed / skipped / failed)
 *
 * Run:
 *   cd packages/indexer
 *   HELIUS_API_KEY=xxx SUPABASE_URL=xxx SUPABASE_KEY=xxx \
 *     npx tsx src/scripts/backfill-price-zero-trades.ts [--dry-run]
 *
 * Dry-run mode prints what would be updated without writing to DB.
 */

import { getSupabase } from "@percolator/shared";
import { config } from "@percolator/shared";
import { detectSlabLayout } from "@percolator/sdk";

// Helius Parse Transactions batch limit
const HELIUS_BATCH_SIZE = 100;

// Max concurrent Helius batches in-flight
const HELIUS_CONCURRENCY = 3;

const isDryRun = process.argv.includes("--dry-run");

// ─── Helius helpers ──────────────────────────────────────────────────────────

function getHeliusParseUrl(): string {
  const isDevnet = config.rpcUrl.includes("devnet");
  const host = isDevnet ? "api-devnet.helius-rpc.com" : "api-mainnet.helius-rpc.com";
  return `https://${host}/v0/transactions?api-key=${config.heliusApiKey}`;
}

async function fetchEnhancedTxs(signatures: string[]): Promise<any[]> {
  const url = getHeliusParseUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: signatures }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Helius ${res.status}: ${text}`);
  }
  return (await res.json()) as any[];
}

// ─── Price extraction (mirrors PERC-421 webhook fix) ─────────────────────────

/**
 * Extract execution price from an enhanced Helius transaction.
 *
 * Strategy (in order):
 * 1. Read mark_price_e6 from slab account post-state (V1 layout only).
 * 2. Fall back to parsing program logs (covers V0 slabs on devnet where the
 *    mark_price field does not exist).
 * 3. Return 0 if neither strategy yields a result.
 */
function extractPrice(tx: any, slabAddress: string): number {
  const priceFromAccount = extractPriceFromAccountData(tx, slabAddress);
  if (priceFromAccount > 0) return priceFromAccount;
  return extractPriceFromLogs(tx);
}

function extractPriceFromAccountData(tx: any, slabAddress: string): number {
  const accountData: any[] = tx.accountData ?? [];
  for (const acc of accountData) {
    if (acc.account !== slabAddress) continue;

    let raw: Uint8Array | null = null;
    if (typeof acc.data === "string") {
      try {
        raw = Uint8Array.from(Buffer.from(acc.data, "base64"));
      } catch { /* skip */ }
    } else if (Array.isArray(acc.data) && typeof acc.data[0] === "string") {
      try {
        raw = Uint8Array.from(Buffer.from(acc.data[0], "base64"));
      } catch { /* skip */ }
    }
    if (!raw) continue;

    // Auto-detect V0 vs V1 layout from the actual slab data length.
    // V0 (deployed devnet): ENGINE_OFF=480, no mark_price field (engineMarkPriceOff=-1).
    // V1 (future upgrade): ENGINE_OFF=640, mark_price at ENGINE_OFF+400=1040.
    const layout = detectSlabLayout(raw.length);
    if (!layout || layout.engineMarkPriceOff < 0) continue; // V0 has no mark_price; fall through to logs

    const markPriceOffset = layout.engineOff + layout.engineMarkPriceOff;
    if (raw.length < markPriceOffset + 8) continue;

    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const markPriceE6 = dv.getBigUint64(markPriceOffset, true);

    // Sanity range: $0.001 → $1 000 000 (in e6 units)
    if (markPriceE6 > 0n && markPriceE6 < 1_000_000_000_000n) {
      return Number(markPriceE6) / 1_000_000;
    }
  }
  return 0;
}

/**
 * Parse program logs for comma-separated numeric values (hex or decimal).
 * Mirrors the same logic in packages/indexer/src/routes/webhook.ts so that
 * V0 devnet slabs (no mark_price field) are recovered during backfill.
 */
function extractPriceFromLogs(tx: any): number {
  const logs: string[] = tx.logs ?? tx.logMessages ?? [];
  const valuePattern = /0x[0-9a-fA-F]+|\d+/g;

  for (const log of logs) {
    if (!log.startsWith("Program log: ")) continue;
    const payload = log.slice("Program log: ".length).trim();
    if (!/^[\d, a-fA-Fx]+$/.test(payload)) continue;

    const matches = payload.match(valuePattern);
    if (!matches || matches.length < 2) continue;

    const values = matches.map((v) =>
      v.startsWith("0x") ? parseInt(v, 16) : Number(v),
    );

    for (const v of values) {
      // Reasonable price_e6 range: $0.001 to $1,000,000
      if (v >= 1_000 && v <= 1_000_000_000_000) {
        return v / 1_000_000;
      }
    }
  }
  return 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧  PERC-423 backfill — price=0 trades${isDryRun ? " [DRY RUN]" : ""}\n`);

  if (!config.heliusApiKey) {
    throw new Error("HELIUS_API_KEY is required");
  }

  const supabase = getSupabase();

  // 1. Fetch all price=0 trades with a tx signature
  console.log("Fetching price=0 trades from DB…");
  const { data: zeroPricedTrades, error: fetchErr } = await supabase
    .from("trades")
    .select("id, slab_address, tx_signature, price")
    .eq("price", 0)
    .not("tx_signature", "is", null)
    .order("created_at", { ascending: true });

  if (fetchErr) throw fetchErr;

  const trades = (zeroPricedTrades ?? []) as {
    id: string;
    slab_address: string;
    tx_signature: string;
    price: number;
  }[];

  console.log(`Found ${trades.length} price=0 trade(s) with tx signatures.\n`);

  if (trades.length === 0) {
    console.log("✅  Nothing to backfill.");
    return;
  }

  // Build sig→[trade] map (multiple trades can share a tx)
  const sigToTrades = new Map<string, typeof trades>();
  for (const t of trades) {
    const list = sigToTrades.get(t.tx_signature) ?? [];
    list.push(t);
    sigToTrades.set(t.tx_signature, list);
  }
  const uniqueSigs = [...sigToTrades.keys()];
  console.log(`Unique tx signatures to fetch: ${uniqueSigs.length}`);

  // 2. Batch-fetch from Helius with concurrency control
  const sigChunks: string[][] = [];
  for (let i = 0; i < uniqueSigs.length; i += HELIUS_BATCH_SIZE) {
    sigChunks.push(uniqueSigs.slice(i, i + HELIUS_BATCH_SIZE));
  }

  const txBySignature = new Map<string, any>();
  let fetchedCount = 0;
  let fetchFailures = 0;

  for (let ci = 0; ci < sigChunks.length; ci += HELIUS_CONCURRENCY) {
    const concurrentBatches = sigChunks.slice(ci, ci + HELIUS_CONCURRENCY);
    const results = await Promise.allSettled(
      concurrentBatches.map((chunk) => fetchEnhancedTxs(chunk))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`  ⚠️  Helius batch fetch failed: ${result.reason?.message ?? result.reason}`);
        fetchFailures++;
        continue;
      }
      for (const tx of result.value) {
        if (tx?.signature) {
          txBySignature.set(tx.signature, tx);
          fetchedCount++;
        }
      }
    }
    // Small delay between concurrent batches to avoid rate-limiting
    if (ci + HELIUS_CONCURRENCY < sigChunks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`Fetched ${fetchedCount} enhanced txs (${fetchFailures} batch failure(s)).\n`);

  // 3. Extract prices and build update list
  const updates: { id: string; price: number }[] = [];
  let skipped = 0;

  for (const [sig, tradeList] of sigToTrades) {
    const tx = txBySignature.get(sig);
    if (!tx) {
      console.warn(`  ⚠️  TX not found in Helius response: ${sig.slice(0, 12)}…`);
      skipped += tradeList.length;
      continue;
    }

    for (const trade of tradeList) {
      const price = extractPrice(tx, trade.slab_address);
      if (price > 0) {
        updates.push({ id: trade.id, price });
        console.log(`  ✓  trade ${trade.id} | slab ${trade.slab_address.slice(0, 8)}… → $${price.toFixed(6)}`);
      } else {
        console.warn(`  ⚠️  Could not extract price for trade ${trade.id} (sig ${sig.slice(0, 12)}…)`);
        skipped++;
      }
    }
  }

  console.log(`\nSummary: ${updates.length} to update, ${skipped} skipped.\n`);

  if (isDryRun) {
    console.log("DRY RUN — no DB writes performed.");
    return;
  }

  if (updates.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  // 4. Apply updates in batches of 50
  const UPDATE_BATCH = 50;
  let fixed = 0;
  let dbErrors = 0;

  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const batch = updates.slice(i, i + UPDATE_BATCH);
    const results = await Promise.allSettled(
      batch.map(({ id, price }) =>
        supabase
          .from("trades")
          .update({ price })
          .eq("id", id)
          .eq("price", 0) // guard: only overwrite if still 0
      )
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`  DB update failed: ${r.reason?.message ?? r.reason}`);
        dbErrors++;
      } else if (r.value.error) {
        console.error(`  DB error: ${r.value.error.message}`);
        dbErrors++;
      } else {
        fixed++;
      }
    }
  }

  // 5. Verify: count remaining price=0 rows
  const { count: remaining, error: countErr } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("price", 0);

  if (countErr) {
    console.warn(`Could not verify remaining zeros: ${countErr.message}`);
  }

  console.log(`\n✅  Done: ${fixed} updated, ${dbErrors} DB error(s), ${skipped} skipped.`);
  if (remaining !== null) {
    console.log(`Remaining price=0 rows in DB: ${remaining}`);
    if (remaining > 0) {
      console.log("  (Some rows may lack tx_signature — those require manual recovery or re-indexing.)");
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
