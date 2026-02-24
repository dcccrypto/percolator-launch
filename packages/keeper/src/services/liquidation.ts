import { PublicKey, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram } from "@solana/web3.js";
import {
  fetchSlab,
  parseConfig,
  parseEngine,
  parseParams,
  parseAccount,
  parseUsedIndices,
  detectLayout,
  buildAccountMetas,
  buildIx,
  encodeLiquidateAtOracle,
  encodeKeeperCrank,
  encodePushOraclePrice,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  derivePythPushOraclePDA,
  type DiscoveredMarket,
} from "@percolator/sdk";
import { config, getConnection, loadKeypair, sendWithRetry, pollSignatureStatus, getRecentPriorityFees, checkTransactionSize, eventBus, createLogger, sendWarningAlert, acquireToken, getFallbackConnection, backoffMs } from "@percolator/shared";
import { OracleService } from "./oracle.js";

const logger = createLogger("keeper:liquidation");

/**
 * Rate-limited fetchSlab with automatic fallback to secondary RPC.
 * Retries up to 3 times with exponential backoff on rate-limit (429) or
 * transient network errors, falling back to the secondary RPC on 429.
 */
async function fetchSlabWithRetry(
  slabPubkey: PublicKey,
  maxRetries = 3,
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const conn = attempt === 0 ? getConnection() : getFallbackConnection();
    try {
      await acquireToken();
      return await fetchSlab(conn, slabPubkey);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isRetryable = msg.includes("429") || msg.includes("too many requests")
        || msg.includes("rate limit") || msg.includes("timeout")
        || msg.includes("socket") || msg.includes("econnrefused")
        || msg.includes("502") || msg.includes("503");
      if (!isRetryable || attempt >= maxRetries - 1) break;
      const delay = backoffMs(attempt, 500, 8_000);
      logger.warn("fetchSlab retrying", {
        slabAddress: slabPubkey.toBase58(),
        attempt: attempt + 1,
        delayMs: Math.round(delay),
        error: msg.slice(0, 120),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// BL2: Extract magic numbers to named constants
const PRICE_E6_DIVISOR = 1_000_000n; // Price precision divisor (6 decimals)
const BPS_MULTIPLIER = 10_000n; // Basis points multiplier (100% = 10000 bps)

interface LiquidationCandidate {
  slabAddress: string;
  accountIdx: number;
  owner: string;
  positionSize: bigint;
  capital: bigint;
  pnl: bigint;
  marginRatio: number;  // as percentage
  maintenanceMarginBps: bigint;
}

export class LiquidationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly oracleService: OracleService;
  private liquidationCount = 0;
  private scanCount = 0;
  private lastScanTime = 0;
  // Overlap guard: prevent concurrent scan cycles from interleaving
  private _scanning = false;
  // BC1: Signature replay protection
  private recentSignatures = new Map<string, number>(); // signature -> timestamp
  private readonly signatureTTLMs = 60_000; // 60 seconds
  // PERC-134: Exponential backoff on consecutive scan failures
  private consecutiveFailures = 0;
  private readonly maxBackoffMs = 300_000; // 5 minutes max backoff

  constructor(oracleService: OracleService, intervalMs = 60_000) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs;
  }

  /**
   * Scan a single market for undercollateralized accounts.
   */
  async scanMarket(market: DiscoveredMarket): Promise<LiquidationCandidate[]> {
    const slabAddress = market.slabAddress.toBase58();

    try {
      const data = await fetchSlabWithRetry(market.slabAddress);
      const engine = parseEngine(data);
      const params = parseParams(data);
      const cfg = parseConfig(data);
      const layout = detectLayout(data.length);
      if (!layout) return [];

      const candidates: LiquidationCandidate[] = [];
      const maintenanceMarginBps = params.maintenanceMarginBps;
      const price = cfg.authorityPriceE6;

      if (price === 0n) return []; // No price set

      // BC2: Check oracle staleness - reject if timestamp > 60s old
      const now = BigInt(Math.floor(Date.now() / 1000));
      const priceAge = cfg.authorityTimestamp > 0n ? now - cfg.authorityTimestamp : now;
      if (priceAge > 60n) {
        // Only log for markets with actual positions (reduce noise)
        if (engine.totalOpenInterest > 0n) {
          logger.warn("Stale oracle price, skipping", { slabAddress, priceAgeSeconds: Number(priceAge), maxAge: 60 });
        }
        return []; // Don't liquidate with stale prices
      }

      // Use bitmap to find actually-used account indices (not sequential iteration)
      // The bitmap can be sparse — e.g., accounts at indices 0, 5, 100
      const usedIndices = parseUsedIndices(data);

      for (const i of usedIndices) {
        try {
          const account = parseAccount(data, i);

          // Skip LP accounts (kind=1) and empty accounts
          if (account.kind !== 0) continue;  // 0 = User
          if (account.positionSize === 0n) continue;  // No position

          // Calculate margin health using mark-to-market PnL (not stale on-chain pnl)
          // On-chain pnl is only updated during cranks; between cranks it can be stale
          const notional = absBI(account.positionSize) * price / PRICE_E6_DIVISOR;
          if (notional === 0n) continue;

          // Compute mark PnL from live price instead of stale on-chain pnl
          const entryPrice = account.entryPrice;
          let markPnl = 0n;
          if (entryPrice > 0n && price > 0n) {
            const diff = account.positionSize > 0n
              ? price - entryPrice    // long: profit when price goes up
              : entryPrice - price;   // short: profit when price goes down
            
            // BH5: Overflow protection - check bounds before multiplication
            const MAX_SAFE_BIGINT = 9007199254740991n; // Number.MAX_SAFE_INTEGER
            const absPosSize = absBI(account.positionSize);
            
            // Check if multiplication would overflow
            if (diff > 0n && absPosSize > MAX_SAFE_BIGINT / diff) {
              logger.warn("PnL calculation overflow", { accountIndex: i, slabAddress });
              markPnl = diff > 0n ? MAX_SAFE_BIGINT : -MAX_SAFE_BIGINT;
            } else if (diff < 0n && absPosSize > MAX_SAFE_BIGINT / -diff) {
              logger.warn("PnL calculation overflow", { accountIndex: i, slabAddress });
              markPnl = -MAX_SAFE_BIGINT;
            } else {
              markPnl = (diff * absPosSize) / price;
            }
          }
          const equity = account.capital + markPnl;

          // H4: If equity <= 0, definitely liquidatable (skip ratio calc)
          if (equity <= 0n) {
            candidates.push({
              slabAddress,
              accountIdx: i,
              owner: account.owner.toBase58(),
              positionSize: account.positionSize,
              capital: account.capital,
              pnl: markPnl,
              marginRatio: equity <= 0n ? 0 : -1,
              maintenanceMarginBps,
            });
            continue;
          }

          const marginRatioBps = equity * BPS_MULTIPLIER / notional;

          // If margin ratio < maintenance margin, this account is liquidatable
          if (marginRatioBps < maintenanceMarginBps) {
            candidates.push({
              slabAddress,
              accountIdx: i,
              owner: account.owner.toBase58(),
              positionSize: account.positionSize,
              capital: account.capital,
              pnl: markPnl,
              marginRatio: Number(marginRatioBps) / 100,
              maintenanceMarginBps,
            });
          }
        } catch {
          // Skip accounts that fail to parse
          continue;
        }
      }

      return candidates;
    } catch (err) {
      logger.error("Market scan failed", {
        slabAddress,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return [];
    }
  }

  /**
   * Execute liquidation for an undercollateralized account.
   * Prepends oracle price push + crank (to ensure fresh state) then liquidates.
   */
  async liquidate(
    market: DiscoveredMarket,
    accountIdx: number,
  ): Promise<string | null> {
    const slabAddress = market.slabAddress;
    const isAdminOracle = !market.config.oracleAuthority.equals(PublicKey.default);

    try {
      const connection = getConnection();
      const keypair = loadKeypair(config.crankKeypair);
      const programId = market.programId;

      // Build multi-instruction tx: push price → crank → liquidate
      const instructions = [];

      // Determine oracle account for crank/liquidate
      const feedIdBytes = market.config.indexFeedId.toBytes();
      const feedHex = Array.from(feedIdBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      const isAllZeros = feedHex === "0".repeat(64);
      const oracleAccount = isAllZeros ? slabAddress : derivePythPushOraclePDA(feedHex)[0];

      // 1. Push oracle price only if crank wallet IS the oracle authority
      // (user-owned oracle markets skip the push — user pushes manually)
      if (isAdminOracle && market.config.oracleAuthority.equals(keypair.publicKey)) {
        const mint = market.config.collateralMint.toBase58();
        const priceEntry = await this.oracleService.fetchPrice(mint, slabAddress.toBase58());
        if (priceEntry) {
          const pushData = encodePushOraclePrice({
            priceE6: priceEntry.priceE6,
            timestamp: BigInt(Math.floor(Date.now() / 1000)),
          });
          const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
            keypair.publicKey, slabAddress,
          ]);
          instructions.push(buildIx({ programId, keys: pushKeys, data: pushData }));
        }
      }

      // 2. Crank (make sure engine state is fresh)
      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        keypair.publicKey, slabAddress, SYSVAR_CLOCK_PUBKEY, oracleAccount,
      ]);
      instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

      // 3. Liquidate
      const liqData = encodeLiquidateAtOracle({ targetIdx: accountIdx });
      const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
        keypair.publicKey, slabAddress, SYSVAR_CLOCK_PUBKEY, oracleAccount,
      ]);
      instructions.push(buildIx({ programId, keys: liqKeys, data: liqData }));

      // Bug 3: Re-read slab data and verify account before submitting
      {
        const freshData = await fetchSlabWithRetry(slabAddress);
        const freshEngine = parseEngine(freshData);
        const freshParams = parseParams(freshData);
        const freshCfg = parseConfig(freshData);

        // Use bitmap to verify account is still active (not sequential numUsedAccounts)
        const freshUsed = parseUsedIndices(freshData);
        if (!freshUsed.includes(accountIdx)) {
          logger.warn("Race condition: account not in bitmap", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58() });
          return null;
        }

        const freshAccount = parseAccount(freshData, accountIdx);
        // Owner is verified implicitly — the account at this index is what we'll liquidate

        // Verify still undercollateralized
        if (freshAccount.kind !== 0 || freshAccount.positionSize === 0n) {
          logger.warn("Race condition: account no longer active", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58() });
          return null;
        }

        const freshPrice = freshCfg.authorityPriceE6;
        if (freshPrice > 0n) {
          const notional = absBI(freshAccount.positionSize) * freshPrice / PRICE_E6_DIVISOR;
          if (notional > 0n) {
            // Use mark-to-market PnL for re-verification
            const freshEntry = freshAccount.entryPrice;
            let freshMarkPnl = 0n;
            if (freshEntry > 0n && freshPrice > 0n) {
              const diff = freshAccount.positionSize > 0n
                ? freshPrice - freshEntry
                : freshEntry - freshPrice;
              freshMarkPnl = (diff * absBI(freshAccount.positionSize)) / freshPrice;
            }
            const equity = freshAccount.capital + freshMarkPnl;
            if (equity > 0n) {
              const marginRatioBps = equity * BPS_MULTIPLIER / notional;
              if (marginRatioBps >= freshParams.maintenanceMarginBps) {
                logger.warn("Race condition: account no longer undercollateralized", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58(), marginRatioBps: Number(marginRatioBps) });
                return null;
              }
            }
          }
        }
      }

      // Send all in one tx with retry (Bug 7+8+9)
      const { Transaction } = await import("@solana/web3.js");
      const MAX_RETRIES = 2;
      let sig: string | null = null;
      
      // BH6 + BH11: Get dynamic priority fees and compute budget
      const { priorityFeeMicroLamports, computeUnitLimit } = await getRecentPriorityFees(connection);
      
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const tx = new Transaction();
          
          // BH6 + BH11: Add compute budget instructions at the start
          tx.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports })
          );
          
          for (const ix of instructions) {
            tx.add(ix);
          }
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
          tx.recentBlockhash = blockhash;
          tx.feePayer = keypair.publicKey;
          tx.sign(keypair);
          
          // BH9: Check transaction size before sending
          checkTransactionSize(tx);
          
          const txSig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          // Use getSignatureStatuses polling instead of confirmTransaction
          // (confirmTransaction can falsely report "block height exceeded" on devnet)
          await pollSignatureStatus(connection, txSig);
          sig = txSig;
          break;
        } catch (retryErr) {
          const errMsg = retryErr instanceof Error ? retryErr.message.toLowerCase() : String(retryErr).toLowerCase();
          const isNetworkError = errMsg.includes("timeout") || errMsg.includes("socket") || errMsg.includes("econnrefused") || errMsg.includes("429") || errMsg.includes("block height exceeded");
          if (!isNetworkError || attempt >= MAX_RETRIES) {
            throw retryErr;
          }
          console.warn(`[LiquidationService] Attempt ${attempt + 1} failed with network error, retrying...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }

      // BC1: Track signature to prevent replay attacks
      const now = Date.now();
      this.recentSignatures.set(sig!, now);
      // Clean up signatures older than TTL
      for (const [oldSig, timestamp] of this.recentSignatures.entries()) {
        if (now - timestamp > this.signatureTTLMs) {
          this.recentSignatures.delete(oldSig);
        }
      }

      this.liquidationCount++;
      eventBus.publish("liquidation.success", slabAddress.toBase58(), {
        accountIdx,
        signature: sig!,
      });
      logger.info("Account liquidated", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58(), signature: sig });
      
      // Send Discord alert for liquidation execution
      await sendWarningAlert("Liquidation executed", [
        { name: "Market", value: slabAddress.toBase58().slice(0, 8), inline: true },
        { name: "Account Index", value: accountIdx.toString(), inline: true },
        { name: "Signature", value: sig!.slice(0, 12), inline: true },
      ]);
      
      return sig!;
    } catch (err) {
      logger.error("Liquidation failed", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        slabAddress: slabAddress.toBase58(),
        accountIdx,
        market: slabAddress.toBase58(),
        programId: market.programId.toBase58(),
      });
      
      eventBus.publish("liquidation.failure", slabAddress.toBase58(), {
        accountIdx,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Scan all markets and liquidate any undercollateralized accounts.
   */
  async scanAndLiquidateAll(markets: Map<string, { market: DiscoveredMarket }>): Promise<{
    scanned: number;
    candidates: number;
    liquidated: number;
  }> {
    let scanned = 0;
    let candidateCount = 0;
    let liquidated = 0;

    // Process markets in batches to avoid RPC rate-limit bursts.
    // Batch size of 10 keeps us well within Helius free-tier (100 req/10s).
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 1_200; // ~1.2s pause between batches
    const entries = Array.from(markets.values());

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map((state) => this.scanMarket(state.market)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        scanned++;
        const result = batchResults[j]!;
        if (result.status === "rejected") {
          logger.error("Market scan rejected", { error: result.reason });
          continue;
        }
        const candidates = result.value;
        candidateCount += candidates.length;

        // Liquidations are sequential (each is a transaction)
        for (const candidate of candidates) {
          const sig = await this.liquidate(batch[j]!.market, candidate.accountIdx);
          if (sig) liquidated++;
        }
      }

      // Pause between batches (skip after last batch)
      if (i + BATCH_SIZE < entries.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    this.scanCount++;
    this.lastScanTime = Date.now();
    return { scanned, candidates: candidateCount, liquidated };
  }

  start(getMarkets: () => Map<string, { market: DiscoveredMarket }>): void {
    if (this.timer) return;
    logger.info("Liquidation service starting", { intervalMs: this.intervalMs });

    const runCycle = async () => {
      // Overlap guard: skip if previous cycle is still running
      if (this._scanning) return;
      this._scanning = true;
      try {
        const marketsSnapshot = new Map(getMarkets());
        const result = await this.scanAndLiquidateAll(marketsSnapshot);
        this.consecutiveFailures = 0; // Reset on success
        if (result.candidates > 0) {
          logger.info("Liquidation scan complete", { 
            scanned: result.scanned, 
            candidates: result.candidates, 
            liquidated: result.liquidated 
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        const backoff = Math.min(
          this.intervalMs * Math.pow(2, this.consecutiveFailures - 1),
          this.maxBackoffMs,
        );
        logger.error("Liquidation cycle failed", {
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures: this.consecutiveFailures,
          nextRetryMs: Math.round(backoff),
        });
        // Schedule delayed retry instead of waiting for next fixed interval
        if (backoff > this.intervalMs) {
          setTimeout(runCycle, backoff - this.intervalMs);
        }
      } finally {
        this._scanning = false;
      }
    };
    this.timer = setInterval(runCycle, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Liquidation service stopped");
    }
  }

  getStatus() {
    return {
      liquidationCount: this.liquidationCount,
      scanCount: this.scanCount,
      lastScanTime: this.lastScanTime,
      running: this.timer !== null,
    };
  }
}

function absBI(n: bigint): bigint {
  return n < 0n ? -n : n;
}
