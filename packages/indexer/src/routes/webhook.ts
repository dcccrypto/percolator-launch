import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { IX_TAG, detectSlabLayout } from "@percolator/sdk";
import { config, insertTrade, eventBus, decodeBase58, readU128LE, parseTradeSize, createLogger } from "@percolator/shared";

const logger = createLogger("indexer:webhook");

const TRADE_TAGS = new Set<number>([IX_TAG.TradeNoCpi, IX_TAG.TradeCpi, IX_TAG.TradeCpiV2]);
const PROGRAM_IDS = new Set(config.allProgramIds);
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Helius Enhanced Transaction webhook receiver.
 * Parses trade instructions from enhanced tx data and stores them.
 */
// PERC-692: Fail fast if webhook secret is not configured in production
const IS_PRODUCTION = process.env.NODE_ENV === "production";
if (!config.webhookSecret) {
  if (IS_PRODUCTION) {
    logger.error("FATAL: HELIUS_WEBHOOK_SECRET must be set in production — webhook auth would be bypassed");
    process.exit(1);
  } else {
    logger.warn("HELIUS_WEBHOOK_SECRET not set — webhook auth disabled (dev only)");
  }
}

export function webhookRoutes(): Hono {
  const app = new Hono();

  app.post("/webhook/trades", async (c) => {
    // PERC-750: Read raw body first — required for HMAC-SHA256 body signature verification.
    let rawBody: Buffer;
    try {
      rawBody = Buffer.from(await c.req.arrayBuffer());
    } catch {
      return c.json({ error: "Failed to read request body" }, 400);
    }

    // PERC-1063 / PERC-750: Fail-closed — 503 if secret not configured, 401 if verification fails.
    if (!config.webhookSecret) {
      logger.error("Webhook request rejected: HELIUS_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook auth not configured" }, 503);
    }

    const authHeader = c.req.header("authorization") ?? "";
    const hmacHeader = c.req.header("x-helius-hmac-sha256") ?? "";
    if (!verifyWebhookSignature(rawBody, authHeader, config.webhookSecret, hmacHeader || undefined)) {
      logger.warn("Webhook signature verification failed", { hasHeader: !!authHeader, hasHmac: !!hmacHeader });
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Parse body from the already-read buffer (avoids consuming the stream twice).
    let transactions: any[];
    try {
      const parsed = JSON.parse(rawBody.toString("utf-8"));
      transactions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Process synchronously — Helius has a 15s timeout, and we need to confirm
    // processing before returning 200. If we return early, Helius may retry
    // and we'd get duplicates (insertTrade handles 23505 but still wastes work).
    try {
      await processTransactions(transactions);
    } catch (err) {
      logger.error("Webhook processing error", { error: err instanceof Error ? err.message : err });
      // Still return 200 to prevent Helius retries — we logged the error
    }

    return c.json({ received: transactions.length }, 200);
  });

  return app;
}

/**
 * Verify Helius webhook request authenticity. (PERC-750)
 *
 * Supports two modes, checked in priority order:
 *
 * 1. **HMAC-SHA256 body signature** (preferred — body-bound, prevents payload tampering):
 *    The `x-helius-hmac-sha256` header contains hex(HMAC-SHA256(rawBody, secret)).
 *    Used when Helius or an intermediary proxy signs the payload.
 *
 * 2. **Static token** (current Helius `authHeader` behavior):
 *    The `Authorization` header is compared timing-safely to the configured secret.
 *    Timing-safe comparison prevents oracle attacks on the static token.
 *
 * All comparisons use `crypto.timingSafeEqual` to prevent timing side-channels.
 *
 * @param rawBody    Raw request body bytes (must be read before JSON.parse).
 * @param authHeader Value of the `Authorization` request header.
 * @param secret     Configured `HELIUS_WEBHOOK_SECRET`.
 * @param hmacHeader Optional value of the `x-helius-hmac-sha256` request header.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  authHeader: string,
  secret: string,
  hmacHeader?: string,
): boolean {
  // Mode 1: HMAC-SHA256 body signature (preferred)
  if (hmacHeader) {
    const expectedHmac = createHmac("sha256", secret).update(rawBody).digest("hex");
    const hmacBytes = Buffer.from(hmacHeader, "utf8");
    const expectedBytes = Buffer.from(expectedHmac, "utf8");
    // timingSafeEqual requires equal-length buffers; length mismatch is an immediate reject.
    if (hmacBytes.length !== expectedBytes.length) return false;
    return timingSafeEqual(hmacBytes, expectedBytes);
  }

  // Mode 2: Static token — timing-safe comparison (current Helius authHeader behavior).
  if (!authHeader) return false;
  const authBytes = Buffer.from(authHeader, "utf8");
  const secretBytes = Buffer.from(secret, "utf8");
  if (authBytes.length !== secretBytes.length) return false;
  return timingSafeEqual(authBytes, secretBytes);
}

async function processTransactions(transactions: any[]): Promise<void> {
  let indexed = 0;

  for (const tx of transactions) {
    try {
      const trades = extractTradesFromEnhancedTx(tx);
      for (const trade of trades) {
        try {
          await insertTrade(trade);
          eventBus.publish("trade.executed", trade.slab_address, {
            signature: trade.tx_signature,
            trader: trade.trader,
            side: trade.side,
            size: trade.size,
            price: trade.price,
            fee: trade.fee,
          });
          indexed++;
        } catch (err) {
          // insertTrade already handles duplicate constraint (23505)
          logger.warn("Trade insert error", { error: err instanceof Error ? err.message : err });
        }
      }
    } catch (err) {
      logger.warn("Failed to process transaction", { error: err instanceof Error ? err.message : err });
    }
  }

  if (indexed > 0) {
    logger.info("Trades indexed", { count: indexed });
  }
}

interface TradeData {
  slab_address: string;
  trader: string;
  side: "long" | "short";
  size: string;
  price: number;
  fee: number;
  tx_signature: string;
}

function extractTradesFromEnhancedTx(tx: any): TradeData[] {
  const trades: TradeData[] = [];
  const signature = tx.signature ?? "";
  if (!signature) return trades;

  const instructions = tx.instructions ?? [];

  for (const ix of instructions) {
    const programId = ix.programId ?? "";
    if (!PROGRAM_IDS.has(programId)) continue;

    // Decode instruction data (base58)
    const data = ix.data ? decodeBase58(ix.data) : null;
    if (!data || data.length < 21) continue;

    const tag = data[0];
    if (!TRADE_TAGS.has(tag)) continue;

    // Parse: tag(1) + lpIdx(u16=2) + userIdx(u16=2) + size(i128=16)
    // TradeCpiV2 adds an extra bump(u8) at byte 21 — same size offset, different total length (22 vs 21)
    const { sizeValue, side } = parseTradeSize(data.slice(5, 21));

    // Account layout (from core/abi/accounts.ts):
    // PERC-199: clock sysvar removed from trade instructions
    // TradeNoCpi:  [0]=user(signer), [1]=lp(signer), [2]=slab(writable), [3]=oracle
    // TradeCpi:    [0]=user(signer), [1]=lpOwner,    [2]=slab(writable), [3]=oracle, ...
    // TradeCpiV2:  [0]=user(signer), [1]=lpOwner,    [2]=slab(writable), [3]=oracle, ... (same layout, adds bump in data)
    const accounts: string[] = ix.accounts ?? [];
    const trader = accounts[0] ?? "";
    const slabAddress = accounts.length > 2 ? accounts[2] : "";
    if (!trader || !slabAddress) continue;

    // Validate pubkey formats
    if (!BASE58_PUBKEY.test(trader) || !BASE58_PUBKEY.test(slabAddress)) continue;

    // Extract price from slab account data or program logs
    const price = extractPrice(tx, slabAddress);
    const fee = extractFeeFromTransfers(tx, trader);

    trades.push({
      slab_address: slabAddress,
      trader,
      side,
      size: sizeValue.toString(),
      price,
      fee,
      tx_signature: signature,
    });
  }

  // Also check inner instructions (for TradeCpi routed through matcher)
  const innerInstructions = tx.innerInstructions ?? [];
  for (const inner of innerInstructions) {
    const innerIxs = inner.instructions ?? [];
    for (const ix of innerIxs) {
      const programId = ix.programId ?? "";
      if (!PROGRAM_IDS.has(programId)) continue;

      const data = ix.data ? decodeBase58(ix.data) : null;
      if (!data || data.length < 21) continue;

      const tag = data[0];
      if (!TRADE_TAGS.has(tag)) continue;

      const { sizeValue, side } = parseTradeSize(data.slice(5, 21));

      // Same account layout: [0]=user, [2]=slab
      const accounts: string[] = ix.accounts ?? [];
      const trader = accounts[0] ?? "";
      const slabAddress = accounts.length > 2 ? accounts[2] : "";
      if (!trader || !slabAddress) continue;

      if (!BASE58_PUBKEY.test(trader) || !BASE58_PUBKEY.test(slabAddress)) continue;

      const price = extractPrice(tx, slabAddress);
      const fee = extractFeeFromTransfers(tx, trader);

      // Avoid duplicates within same tx (match on trader + side + size + slab)
      if (trades.some((t) => t.tx_signature === signature && t.trader === trader && t.slab_address === slabAddress && t.side === side && t.size === sizeValue.toString())) continue;

      trades.push({
        slab_address: slabAddress,
        trader,
        side,
        size: sizeValue.toString(),
        price,
        fee,
        tx_signature: signature,
      });
    }
  }

  return trades;
}

/**
 * Extract execution price from an enhanced transaction.
 *
 * Strategy (in order):
 * 1. Read mark_price_e6 from the slab account's post-state data (Helius
 *    enhanced txs include `accountData` with base64-encoded post-state).
 * 2. Parse program logs for comma-separated numeric values and pick the
 *    first value in a plausible price_e6 range ($0.001–$1M).
 * 3. Return 0 if neither strategy yields a result.
 */
function extractPrice(tx: any, slabAddress: string): number {
  // Strategy 1: read mark_price_e6 from slab post-state account data
  const priceFromAccount = extractPriceFromAccountData(tx, slabAddress);
  if (priceFromAccount > 0) return priceFromAccount;

  // Strategy 2: parse program logs
  return extractPriceFromLogs(tx);
}

/**
 * Read mark_price_e6 from the slab account's post-state data.
 * Helius enhanced transactions include `accountData[]` with each account's
 * post-state as a base64-encoded `data` field.
 */
function extractPriceFromAccountData(tx: any, slabAddress: string): number {
  const accountData: any[] = tx.accountData ?? [];
  for (const acc of accountData) {
    if (acc.account !== slabAddress) continue;
    // Helius provides data as base64 string or { data: [base64, "base64"] }
    let raw: Uint8Array | null = null;
    if (typeof acc.data === "string") {
      try { raw = Uint8Array.from(Buffer.from(acc.data, "base64")); } catch { /* skip */ }
    } else if (Array.isArray(acc.data) && typeof acc.data[0] === "string") {
      try { raw = Uint8Array.from(Buffer.from(acc.data[0], "base64")); } catch { /* skip */ }
    }
    if (!raw) continue;

    // Auto-detect V0 vs V1 layout from the actual slab data length.
    // V0 (deployed devnet): ENGINE_OFF=480, no mark_price field (engineMarkPriceOff=-1).
    // V1 (future upgrade): ENGINE_OFF=640, mark_price at +400.
    const layout = detectSlabLayout(raw.length);
    if (!layout || layout.engineMarkPriceOff < 0) continue; // V0 has no mark_price

    const off = layout.engineOff + layout.engineMarkPriceOff;
    if (raw.length < off + 8) continue;

    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const markPriceE6 = dv.getBigUint64(off, true);
    if (markPriceE6 > 0n && markPriceE6 < 1_000_000_000_000n) {
      return Number(markPriceE6) / 1_000_000;
    }
  }
  return 0;
}

/**
 * Parse program logs for comma-separated numeric values (hex or decimal).
 * Matches 2–8 comma-separated values on a single "Program log:" line.
 */
function extractPriceFromLogs(tx: any): number {
  const logs: string[] = tx.logs ?? tx.logMessages ?? [];
  const valuePattern = /0x[0-9a-fA-F]+|\d+/g;

  for (const log of logs) {
    if (!log.startsWith("Program log: ")) continue;
    const payload = log.slice("Program log: ".length).trim();
    // Only consider lines that look like comma-separated numbers
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

/**
 * Extract fee from token/native transfers.
 * For coin-margined perps, look at SOL balance changes for the trader.
 */
function extractFeeFromTransfers(tx: any, trader: string): number {
  // Check accountData for balance changes (Helius enhanced provides this)
  const accountData: any[] = tx.accountData ?? [];
  for (const acc of accountData) {
    if (acc.account === trader && acc.nativeBalanceChange != null) {
      const change = Math.abs(Number(acc.nativeBalanceChange));
      // Transaction fee is typically 5000-10000 lamports, protocol fees are larger
      // Skip tiny tx fees, look for protocol-level fees
      if (change > 10_000 && change < 1_000_000_000) {
        return change / 1e9;
      }
    }
  }
  return 0;
}
