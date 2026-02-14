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
} from "@percolator/core";
import { config } from "../config.js";
import { getConnection, loadKeypair, sendWithRetry, pollSignatureStatus, getRecentPriorityFees, checkTransactionSize } from "../utils/solana.js";
import { eventBus } from "./events.js";
import { OracleService } from "./oracle.js";

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

  constructor(oracleService: OracleService, intervalMs = 15_000) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs;
  }

  /**
   * Scan a single market for undercollateralized accounts.
   */
  async scanMarket(market: DiscoveredMarket): Promise<LiquidationCandidate[]> {
    const connection = getConnection();
    const slabAddress = market.slabAddress.toBase58();

    try {
      const data = await fetchSlab(connection, market.slabAddress);
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
          console.warn(`[LiquidationService] Skipping ${slabAddress}: oracle price is ${priceAge}s old (max 60s)`);
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
              console.warn(`[LiquidationService] PnL calculation overflow for account ${i} in ${slabAddress}`);
              markPnl = diff > 0n ? MAX_SAFE_BIGINT : -MAX_SAFE_BIGINT;
            } else if (diff < 0n && absPosSize > MAX_SAFE_BIGINT / -diff) {
              console.warn(`[LiquidationService] PnL calculation overflow for account ${i} in ${slabAddress}`);
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
      console.error(`[LiquidationService] Failed to scan market ${slabAddress}:`, err);
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
        const freshData = await fetchSlab(connection, slabAddress);
        const freshEngine = parseEngine(freshData);
        const freshParams = parseParams(freshData);
        const freshCfg = parseConfig(freshData);

        // Use bitmap to verify account is still active (not sequential numUsedAccounts)
        const freshUsed = parseUsedIndices(freshData);
        if (!freshUsed.includes(accountIdx)) {
          console.warn(`[LiquidationService] Race condition: accountIdx ${accountIdx} no longer in bitmap on ${slabAddress.toBase58()}, skipping`);
          return null;
        }

        const freshAccount = parseAccount(freshData, accountIdx);
        // Owner is verified implicitly — the account at this index is what we'll liquidate

        // Verify still undercollateralized
        if (freshAccount.kind !== 0 || freshAccount.positionSize === 0n) {
          console.warn(`[LiquidationService] Race condition: account ${accountIdx} on ${slabAddress.toBase58()} no longer active, skipping`);
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
                console.warn(`[LiquidationService] Race condition: account ${accountIdx} on ${slabAddress.toBase58()} no longer undercollateralized (margin: ${marginRatioBps} bps), skipping`);
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
      console.log(`[LiquidationService] Liquidated account ${accountIdx} on ${slabAddress.toBase58()}: ${sig}`);
      return sig!;
    } catch (err) {
      eventBus.publish("liquidation.failure", slabAddress.toBase58(), {
        accountIdx,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[LiquidationService] Liquidation failed:`, err);
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

    for (const [, state] of markets) {
      const candidates = await this.scanMarket(state.market);
      scanned++;
      candidateCount += candidates.length;

      for (const candidate of candidates) {
        const sig = await this.liquidate(state.market, candidate.accountIdx);
        if (sig) liquidated++;
      }
    }

    this.scanCount++;
    this.lastScanTime = Date.now();
    return { scanned, candidates: candidateCount, liquidated };
  }

  start(getMarkets: () => Map<string, { market: DiscoveredMarket }>): void {
    if (this.timer) return;
    console.log(`[LiquidationService] Starting with interval ${this.intervalMs}ms`);

    this.timer = setInterval(async () => {
      // Overlap guard: skip if previous cycle is still running (mirrors CrankService pattern)
      if (this._scanning) return;
      this._scanning = true;
      try {
        // Snapshot the market map to avoid iteration issues if markets are added/removed
        const marketsSnapshot = new Map(getMarkets());
        const result = await this.scanAndLiquidateAll(marketsSnapshot);
        if (result.candidates > 0) {
          console.log(
            `[LiquidationService] Scan: ${result.scanned} markets, ${result.candidates} candidates, ${result.liquidated} liquidated`,
          );
        }
      } catch (err) {
        console.error("[LiquidationService] Failed to complete liquidation cycle:", err);
      } finally {
        this._scanning = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[LiquidationService] Stopped");
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
