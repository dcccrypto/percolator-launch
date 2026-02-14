import { Hono } from "hono";
import { IX_TAG } from "@percolator/core";
import { config } from "../config.js";
import { insertTrade } from "../db/queries.js";
import { eventBus } from "../services/events.js";
import { decodeBase58, readU128LE, parseTradeSize } from "../utils/binary.js";

const TRADE_TAGS = new Set<number>([IX_TAG.TradeNoCpi, IX_TAG.TradeCpi]);
const PROGRAM_IDS = new Set(config.allProgramIds);
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Helius Enhanced Transaction webhook receiver.
 * Parses trade instructions from enhanced tx data and stores them.
 */
export function webhookRoutes(): Hono {
  const app = new Hono();

  app.post("/webhook/trades", async (c) => {
    // Validate auth header
    const authHeader = c.req.header("authorization");
    if (config.webhookSecret && authHeader !== config.webhookSecret) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Parse body — Helius sends an array of enhanced transactions
    let transactions: any[];
    try {
      const body = await c.req.json();
      transactions = Array.isArray(body) ? body : [body];
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Process synchronously — Helius has a 15s timeout, and we need to confirm
    // processing before returning 200. If we return early, Helius may retry
    // and we'd get duplicates (insertTrade handles 23505 but still wastes work).
    try {
      await processTransactions(transactions);
    } catch (err) {
      console.error("[Webhook] Processing error:", err instanceof Error ? err.message : err);
      // Still return 200 to prevent Helius retries — we logged the error
    }

    return c.json({ received: transactions.length }, 200);
  });

  return app;
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
          console.warn("[Webhook] Insert error:", err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.warn("[Webhook] Failed to process tx:", err instanceof Error ? err.message : err);
    }
  }

  if (indexed > 0) {
    console.log(`[Webhook] Indexed ${indexed} trade(s)`);
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
    const { sizeValue, side } = parseTradeSize(data.slice(5, 21));

    // Account layout (from core/abi/accounts.ts):
    // TradeNoCpi: [0]=user(signer), [1]=lp(signer), [2]=slab(writable), [3]=clock, [4]=oracle
    // TradeCpi:   [0]=user(signer), [1]=lpOwner,    [2]=slab(writable), [3]=clock, [4]=oracle, ...
    const accounts: string[] = ix.accounts ?? [];
    const trader = accounts[0] ?? "";
    const slabAddress = accounts.length > 2 ? accounts[2] : "";
    if (!trader || !slabAddress) continue;

    // Validate pubkey formats
    if (!BASE58_PUBKEY.test(trader) || !BASE58_PUBKEY.test(slabAddress)) continue;

    // Extract price from program logs, fee from balance changes
    const price = extractPriceFromLogs(tx);
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

      const price = extractPriceFromLogs(tx);
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
 * Extract execution price from program logs in the enhanced tx.
 * The on-chain program emits: "Program log: {v1}, {v2}, {v3}, {v4}, {v5}"
 * where one value is price_e6 (range $0.001 to $1M → 1,000 to 1,000,000,000,000).
 * Values can be in hex (0x...) or decimal format.
 */
function extractPriceFromLogs(tx: any): number {
  const logs: string[] = tx.logMessages ?? [];
  for (const log of logs) {
    // Match both hex (0x...) and decimal formats
    const match = log.match(/^Program log: (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+)$/);
    if (!match) continue;
    
    // Parse hex or decimal to number
    const values = [match[1], match[2], match[3], match[4], match[5]].map((v) => {
      return v.startsWith('0x') ? parseInt(v, 16) : Number(v);
    });
    
    for (const v of values) {
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

// decodeBase58, readU128LE, parseTradeSize imported from ../utils/binary.js
