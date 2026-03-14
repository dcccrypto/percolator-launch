import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { IX_TAG, detectSlabLayout } from "@percolator/sdk";
import { config, getConnection, insertTrade, tradeExistsBySignature, getMarkets, eventBus, decodeBase58, readU128LE, parseTradeSize, withRetry, createLogger, captureException, addBreadcrumb } from "@percolator/shared";

const logger = createLogger("indexer:trade-indexer");

/** Trade instruction tags we want to index */
const TRADE_TAGS = new Set<number>([IX_TAG.TradeNoCpi, IX_TAG.TradeCpi, IX_TAG.TradeCpiV2]);

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

    logger.info("TradeIndexerPolling started (backup mode)", { intervalMs: POLL_INTERVAL_MS });
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
    logger.info("TradeIndexer stopped");
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
        logger.info("No markets found for backfill");
        return;
      }

      logger.info("Starting trade backfill", { marketCount: markets.length });
      for (const market of markets) {
        if (!this._running) break;
        try {
          await this.indexTradesForSlab(market.slab_address, BACKFILL_SIGNATURES);
        } catch (err) {
          logger.error("Backfill error", { 
            slabAddress: market.slab_address.slice(0, 8),
            error: err instanceof Error ? err.message : err
          });
          captureException(err, {
            tags: {
              context: "trade-indexer-backfill",
              slabAddress: market.slab_address,
            },
          });
        }
        // Small delay between markets to avoid rate limits
        await sleep(1_000);
      }
      logger.info("Trade backfill complete");
    } catch (err) {
      logger.error("Backfill failed", { error: err instanceof Error ? err.message : err });
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
          logger.error("Poll error", { 
            slabAddress: market.slab_address.slice(0, 8),
            error: err instanceof Error ? err.message : err
          });
        }
        // Small delay between markets
        await sleep(500);
      }
    } catch (err) {
      logger.error("Poll failed", { error: err instanceof Error ? err.message : err });
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
          logger.error("Error indexing trade", { slabAddress: slab, error: err instanceof Error ? err.message : err });
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
      signatures = await withRetry(
        () => connection.getSignaturesForAddress(slabPk, opts),
        { 
          maxRetries: 3, 
          baseDelayMs: 1000, 
          label: `getSignaturesForAddress(${slabAddress.slice(0, 8)})` 
        }
      );
    } catch (err) {
      console.warn(`[TradeIndexer] Failed to get signatures for ${slabAddress.slice(0, 8)}... after retries:`,
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
        batch.map(sig => withRetry(
          () => connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }),
          { 
            maxRetries: 3, 
            baseDelayMs: 1000, 
            label: `getParsedTransaction(${sig.slice(0, 12)})` 
          }
        ))
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
      // TradeCpiV2 adds bump(u8) at byte 21, total 22 bytes — size offset unchanged.
      if (data.length < 21) continue;

      // Parse size as signed i128 (little-endian)
      const { sizeValue, side } = parseTradeSize(data.slice(5, 21));

      // Determine trader from account keys
      const traderKey = ix.accounts[0];
      if (!traderKey) continue;
      const trader = traderKey.toBase58();

      // Get price: try logs first, then read slab account mark_price
      let price = this.extractPriceFromLogs(tx);
      if (price === 0) {
        price = await this.readMarkPriceFromSlab(getConnection(), slabAddress);
      }
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
   * Matches comma-separated numeric values (2–8 values, hex or decimal).
   */
  private extractPriceFromLogs(tx: ParsedTransactionWithMeta): number {
    if (!tx.meta?.logMessages) return 0;

    const valuePattern = /0x[0-9a-fA-F]+|\d+/g;

    for (const log of tx.meta.logMessages) {
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

  /**
   * Fallback: read mark_price_e6 from the slab account's on-chain state.
   * This gives the current mark price (close to execution price for recent trades).
   */
  private async readMarkPriceFromSlab(connection: Connection, slabAddress: string): Promise<number> {
    try {
      const info = await connection.getAccountInfo(new PublicKey(slabAddress));
      if (!info?.data) return 0;

      // Auto-detect V0 vs V1 layout from the actual slab data length.
      // V0 (deployed devnet): ENGINE_OFF=480, no mark_price field (engineMarkPriceOff=-1).
      // V1 (future upgrade): ENGINE_OFF=640, mark_price at +400.
      const layout = detectSlabLayout(info.data.length);
      if (!layout || layout.engineMarkPriceOff < 0) return 0; // V0 has no mark_price

      const off = layout.engineOff + layout.engineMarkPriceOff;
      if (info.data.length < off + 8) return 0;

      const dv = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
      const markPriceE6 = dv.getBigUint64(off, true);

      if (markPriceE6 > 0n && markPriceE6 < 1_000_000_000_000n) {
        return Number(markPriceE6) / 1_000_000;
      }
    } catch (err) {
      logger.warn("Failed to read mark price from slab", {
        slabAddress: slabAddress.slice(0, 8),
        error: err instanceof Error ? err.message : err,
      });
    }
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
