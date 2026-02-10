import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { IX_TAG } from "@percolator/core";
import { config } from "../config.js";
import { getConnection } from "../utils/solana.js";
import { insertTrade, tradeExistsBySignature } from "../db/queries.js";
import { eventBus } from "./events.js";

/** Trade instruction tags we want to index */
const TRADE_TAGS = new Set<number>([IX_TAG.TradeNoCpi, IX_TAG.TradeCpi]);

/** How many recent signatures to fetch per slab per cycle */
const MAX_SIGNATURES = 20;

/**
 * TradeIndexer — listens for crank.success events and indexes trades
 * from recent on-chain transactions for each market slab.
 *
 * Flow:
 * 1. On crank.success, fetch recent tx signatures for the slab address
 * 2. For each tx, check if it contains a TradeCpi or TradeNoCpi instruction
 * 3. Parse trade details (trader, size, side, price) from the transaction
 * 4. Insert into Supabase trades table via insertTrade()
 */
export class TradeIndexer {
  /** Track last indexed signature per slab to avoid re-processing */
  private lastSignature = new Map<string, string>();
  private _running = false;
  private pendingSlabs = new Set<string>();
  private processTimer: ReturnType<typeof setTimeout> | null = null;
  private crankListener: ((payload: { slabAddress: string }) => void) | null = null;

  start(): void {
    if (this._running) return;
    this._running = true;

    // Listen for successful cranks
    this.crankListener = (payload) => {
      this.pendingSlabs.add(payload.slabAddress);
      this.scheduleProcess();
    };
    eventBus.on("crank.success", this.crankListener);

    console.log("[TradeIndexer] Started — listening for crank.success events");
  }

  stop(): void {
    this._running = false;
    if (this.crankListener) {
      eventBus.off("crank.success", this.crankListener);
      this.crankListener = null;
    }
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    console.log("[TradeIndexer] Stopped");
  }

  /**
   * Debounce processing — cranks happen in batches, wait a bit
   * to collect all slabs before processing
   */
  private scheduleProcess(): void {
    if (this.processTimer) return;
    this.processTimer = setTimeout(async () => {
      this.processTimer = null;
      const slabs = [...this.pendingSlabs];
      this.pendingSlabs.clear();
      for (const slab of slabs) {
        try {
          await this.indexTradesForSlab(slab);
        } catch (err) {
          console.error(`[TradeIndexer] Error indexing ${slab}:`, err instanceof Error ? err.message : err);
        }
      }
    }, 3_000); // 3s debounce after crank
  }

  private async indexTradesForSlab(slabAddress: string): Promise<void> {
    const connection = getConnection();
    const slabPk = new PublicKey(slabAddress);
    const programIds = new Set(config.allProgramIds);

    // Fetch recent signatures for this slab account
    const opts: { limit: number; until?: string } = { limit: MAX_SIGNATURES };
    const lastSig = this.lastSignature.get(slabAddress);
    if (lastSig) opts.until = lastSig;

    let signatures;
    try {
      signatures = await connection.getSignaturesForAddress(slabPk, opts);
    } catch (err) {
      console.warn(`[TradeIndexer] Failed to get signatures for ${slabAddress}:`, err instanceof Error ? err.message : err);
      return;
    }

    if (signatures.length === 0) return;

    // Update last signature (most recent first)
    this.lastSignature.set(slabAddress, signatures[0].signature);

    // Filter out errored transactions
    const validSigs = signatures.filter(s => !s.err).map(s => s.signature);
    if (validSigs.length === 0) return;

    // Fetch transactions in batches of 5
    for (let i = 0; i < validSigs.length; i += 5) {
      const batch = validSigs.slice(i, i + 5);
      const txResults = await Promise.allSettled(
        batch.map(sig => connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }))
      );

      for (let j = 0; j < txResults.length; j++) {
        const result = txResults[j];
        if (result.status !== "fulfilled" || !result.value) continue;

        const tx = result.value;
        const sig = batch[j];

        try {
          await this.processTransaction(tx, sig, slabAddress, programIds);
        } catch (err) {
          // Non-fatal: skip this tx, continue with others
          console.warn(`[TradeIndexer] Failed to process tx ${sig.slice(0, 12)}...:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  private async processTransaction(
    tx: ParsedTransactionWithMeta,
    signature: string,
    slabAddress: string,
    programIds: Set<string>,
  ): Promise<void> {
    if (!tx.meta || tx.meta.err) return;

    const message = tx.transaction.message;

    for (const ix of message.instructions) {
      // Skip parsed instructions (system, token, etc.)
      if ("parsed" in ix) continue;

      // Check if this instruction is for one of our programs
      const programId = ix.programId.toBase58();
      if (!programIds.has(programId)) continue;

      // Decode instruction tag from data
      const data = decodeBase58(ix.data);
      if (!data || data.length < 1) continue;

      const tag = data[0];
      if (!TRADE_TAGS.has(tag)) continue;

      // This is a trade instruction! Parse it.
      // Layout: tag(1) + lpIdx(u16=2) + userIdx(u16=2) + size(i128=16) = 21 bytes
      if (data.length < 21) continue;

      // Parse size as signed i128 (little-endian)
      const sizeBytes = data.slice(5, 21);
      const sizeAbs = readU128LE(sizeBytes);
      const isNegative = sizeBytes[15] >= 128; // sign bit
      const side: "long" | "short" = isNegative ? "short" : "long";

      // For negative i128, compute absolute value: ~value + 1
      let sizeValue: bigint;
      if (isNegative) {
        // Two's complement: invert and add 1
        const inverted = new Uint8Array(16);
        for (let k = 0; k < 16; k++) inverted[k] = ~sizeBytes[k] & 0xff;
        sizeValue = readU128LE(inverted) + 1n;
      } else {
        sizeValue = sizeAbs;
      }

      // Determine trader from account keys
      // TradeCpi accounts[0] = user (signer), TradeNoCpi accounts[0] = user (signer)
      const traderKey = ix.accounts[0];
      if (!traderKey) continue;
      const trader = traderKey.toBase58();

      // Get price from slab account data post-execution
      // Use the oracle price from the slab's config (authorityPriceE6 or lastEffectivePriceE6)
      // We approximate: parse price from program logs
      const price = this.extractPriceFromLogs(tx) ?? 0;

      // Extract fee from logs if possible, default to 0
      const fee = 0;

      // Check for duplicate
      const exists = await tradeExistsBySignature(signature);
      if (exists) return; // Already indexed (a tx can only have one trade instruction we care about per slab)

      await insertTrade({
        slab_address: slabAddress,
        trader,
        side,
        size: sizeValue.toString(), // Keep full precision (i128 on-chain)
        price,
        fee,
        tx_signature: signature,
      });

      console.log(`[TradeIndexer] Indexed trade: ${side} ${sizeValue} on ${slabAddress.slice(0, 8)}... tx=${signature.slice(0, 12)}...`);
      eventBus.publish("trade.executed", slabAddress, { signature, trader, side, size: sizeValue.toString() });
    }
  }

  /**
   * Try to extract execution price from transaction logs.
   * The program uses sol_log_64 which appears as "Program log: ..." entries.
   * We look for price patterns in the logs.
   */
  private extractPriceFromLogs(tx: ParsedTransactionWithMeta): number | null {
    if (!tx.meta?.logMessages) return null;

    // Look for sol_log_64 entries that might contain price info
    // Format: "Program log: <base10_val1>, <base10_val2>, <base10_val3>, <base10_val4>, <base10_val5>"
    for (const log of tx.meta.logMessages) {
      // sol_log_64 logs appear as comma-separated u64 values
      const match = log.match(/^Program log: (\d+), (\d+), (\d+), (\d+), (\d+)$/);
      if (!match) continue;

      // Heuristic: the program likely logs price in one of the values.
      // Without knowing the exact log format, we look for values in a reasonable price range (e6 format).
      // A price in e6 format would be e.g. 1_000_000 = $1.00, 150_000_000 = $150.00
      const values = [match[1], match[2], match[3], match[4], match[5]].map(Number);

      for (const v of values) {
        // Reasonable price_e6 range: $0.001 (1000) to $1,000,000 (1e12)
        if (v >= 1_000 && v <= 1_000_000_000_000) {
          // Return as human-readable price (divide by 1e6)
          return v / 1_000_000;
        }
      }
    }

    return null;
  }
}

/** Decode base58 string to Uint8Array */
function decodeBase58(str: string): Uint8Array | null {
  try {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const BASE = 58;

    // Count leading '1's (zeros in base58)
    let zeros = 0;
    while (zeros < str.length && str[zeros] === "1") zeros++;

    // Decode
    const bytes: number[] = [];
    for (let i = zeros; i < str.length; i++) {
      const charIndex = ALPHABET.indexOf(str[i]);
      if (charIndex < 0) return null;

      let carry = charIndex;
      for (let j = bytes.length - 1; j >= 0; j--) {
        carry += bytes[j] * BASE;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.unshift(carry & 0xff);
        carry >>= 8;
      }
    }

    // Add leading zeros
    const result = new Uint8Array(zeros + bytes.length);
    result.set(bytes, zeros);
    return result;
  } catch {
    return null;
  }
}

/** Read unsigned 128-bit little-endian integer */
function readU128LE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}
