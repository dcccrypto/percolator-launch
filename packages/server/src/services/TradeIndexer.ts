import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { IX_TAG } from "@percolator/core";
import { config } from "../config.js";
import { getConnection } from "../utils/solana.js";
import { insertTrade, tradeExistsBySignature, getMarkets } from "../db/queries.js";
import { eventBus } from "./events.js";
import { decodeBase58, readU128LE, parseTradeSize } from "../utils/binary.js";

/** Trade instruction tags we want to index */
const TRADE_TAGS = new Set<number>([IX_TAG.TradeNoCpi, IX_TAG.TradeCpi]);

/** How many recent signatures to fetch per slab per cycle */
const MAX_SIGNATURES = 50;

/** Poll interval for trade indexing (5 minutes — backup/backfill only, primary is webhook) */
const POLL_INTERVAL_MS = 5 * 60_000;

/** Initial backfill: fetch more signatures on first run */
const BACKFILL_SIGNATURES = 100;

/**
 * TradeIndexerPolling — backup/backfill trade indexer using on-chain polling.
 *
 * Primary indexing is now webhook-driven (see HeliusWebhookManager + webhook routes).
 * This poller runs on startup for backfill, then every 5 minutes as a catchall.
 *
 * Two modes:
 * 1. Reactive: listens for crank.success events for immediate indexing
 * 2. Proactive: polls all active markets periodically to catch any missed trades
 */
export class TradeIndexerPolling {
  /** Track last indexed signature per slab to avoid re-processing */
  private lastSignature = new Map<string, string>();
  private _running = false;
  private pendingSlabs = new Set<string>();
  private processTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private crankListener: ((payload: { slabAddress: string }) => void) | null = null;
  private hasBackfilled = false;

  start(): void {
    if (this._running) return;
    this._running = true;

    // Listen for successful cranks (reactive mode)
    this.crankListener = (payload) => {
      this.pendingSlabs.add(payload.slabAddress);
      this.scheduleProcess();
    };
    eventBus.on("crank.success", this.crankListener);

    // Initial backfill after short delay to let discovery finish
    setTimeout(() => this.backfill(), 5_000);

    // Start periodic polling (proactive mode)
    this.pollTimer = setInterval(() => this.pollAllMarkets(), POLL_INTERVAL_MS);

    console.log("[TradeIndexerPolling] Started — backup mode (5m interval)");
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[TradeIndexer] Stopped");
  }

  /**
   * Backfill: fetch recent trades for all known markets on startup
   */
  private async backfill(): Promise<void> {
    if (this.hasBackfilled || !this._running) return;
    this.hasBackfilled = true;

    try {
      const markets = await getMarkets();
      if (markets.length === 0) {
        console.log("[TradeIndexer] No markets found for backfill");
        return;
      }

      console.log(`[TradeIndexer] Backfilling trades for ${markets.length} market(s)...`);
      for (const market of markets) {
        if (!this._running) break;
        try {
          await this.indexTradesForSlab(market.slab_address, BACKFILL_SIGNATURES);
        } catch (err) {
          console.error(`[TradeIndexer] Backfill error for ${market.slab_address.slice(0, 8)}...:`,
            err instanceof Error ? err.message : err);
        }
        // Small delay between markets to avoid rate limits
        await sleep(1_000);
      }
      console.log("[TradeIndexer] Backfill complete");
    } catch (err) {
      console.error("[TradeIndexer] Backfill failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Poll all active markets for new trades
   */
  private async pollAllMarkets(): Promise<void> {
    if (!this._running) return;

    try {
      const markets = await getMarkets();
      for (const market of markets) {
        if (!this._running) break;
        try {
          await this.indexTradesForSlab(market.slab_address, MAX_SIGNATURES);
        } catch (err) {
          console.error(`[TradeIndexer] Poll error for ${market.slab_address.slice(0, 8)}...:`,
            err instanceof Error ? err.message : err);
        }
        // Small delay between markets
        await sleep(500);
      }
    } catch (err) {
      console.error("[TradeIndexer] Poll failed:", err instanceof Error ? err.message : err);
    }
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

  private async indexTradesForSlab(slabAddress: string, maxSigs = MAX_SIGNATURES): Promise<void> {
    const connection = getConnection();
    const slabPk = new PublicKey(slabAddress);
    const programIds = new Set(config.allProgramIds);

    // Fetch recent signatures for this slab account
    const opts: { limit: number; until?: string } = { limit: maxSigs };
    const lastSig = this.lastSignature.get(slabAddress);
    if (lastSig) opts.until = lastSig;

    let signatures;
    try {
      signatures = await connection.getSignaturesForAddress(slabPk, opts);
    } catch (err) {
      console.warn(`[TradeIndexer] Failed to get signatures for ${slabAddress.slice(0, 8)}...:`,
        err instanceof Error ? err.message : err);
      return;
    }

    if (signatures.length === 0) return;

    // Update last signature (most recent first)
    this.lastSignature.set(slabAddress, signatures[0].signature);

    // Filter out errored transactions
    const validSigs = signatures.filter(s => !s.err).map(s => s.signature);
    if (validSigs.length === 0) return;

    let indexed = 0;

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
          const didIndex = await this.processTransaction(tx, sig, slabAddress, programIds);
          if (didIndex) indexed++;
        } catch (err) {
          // Non-fatal: skip this tx, continue with others
          console.warn(`[TradeIndexer] Failed to process tx ${sig.slice(0, 12)}...:`, err instanceof Error ? err.message : err);
        }
      }
    }

    if (indexed > 0) {
      console.log(`[TradeIndexer] Indexed ${indexed} trade(s) for ${slabAddress.slice(0, 8)}...`);
    }
  }

  private async processTransaction(
    tx: ParsedTransactionWithMeta,
    signature: string,
    slabAddress: string,
    programIds: Set<string>,
  ): Promise<boolean> {
    if (!tx.meta || tx.meta.err) return false;

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
      const { sizeValue, side } = parseTradeSize(data.slice(5, 21));

      // Determine trader from account keys
      const traderKey = ix.accounts[0];
      if (!traderKey) continue;
      const trader = traderKey.toBase58();

      // Get price from program logs
      const price = this.extractPriceFromLogs(tx) ?? 0;
      const fee = 0;

      // Check for duplicate
      const exists = await tradeExistsBySignature(signature);
      if (exists) return false;

      // Validate inputs
      const base58PubkeyRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      const base58SigRegex = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
      
      if (!base58PubkeyRegex.test(trader)) {
        console.warn(`[TradeIndexer] Invalid trader pubkey format: ${trader.slice(0, 12)}... - skipping`);
        return false;
      }
      
      if (!base58SigRegex.test(signature)) {
        console.warn(`[TradeIndexer] Invalid signature format: ${signature.slice(0, 12)}... - skipping`);
        return false;
      }
      
      // Validate size is within i128 range
      const i128Max = (1n << 127n) - 1n;
      if (sizeValue > i128Max) {
        console.warn(`[TradeIndexer] Size out of range: ${sizeValue} - skipping`);
        return false;
      }

      await insertTrade({
        slab_address: slabAddress,
        trader,
        side,
        size: sizeValue.toString(),
        price,
        fee,
        tx_signature: signature,
      });

      eventBus.publish("trade.executed", slabAddress, { signature, trader, side, size: sizeValue.toString() });
      return true;
    }

    return false;
  }

  /**
   * Try to extract execution price from transaction logs.
   * The on-chain program emits values in hex (0x...) or decimal format.
   */
  private extractPriceFromLogs(tx: ParsedTransactionWithMeta): number | null {
    if (!tx.meta?.logMessages) return null;

    for (const log of tx.meta.logMessages) {
      // Match both hex (0x...) and decimal formats
      const match = log.match(/^Program log: (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+), (0x[0-9a-fA-F]+|\d+)$/);
      if (!match) continue;

      // Parse hex or decimal to number
      const values = [match[1], match[2], match[3], match[4], match[5]].map((v) => {
        return v.startsWith('0x') ? parseInt(v, 16) : Number(v);
      });

      for (const v of values) {
        // Reasonable price_e6 range: $0.001 to $1,000,000
        if (v >= 1_000 && v <= 1_000_000_000_000) {
          return v / 1_000_000;
        }
      }
    }

    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// decodeBase58, readU128LE, parseTradeSize imported from ../utils/binary.js
