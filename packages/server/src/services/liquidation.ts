import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  fetchSlab,
  parseConfig,
  parseEngine,
  parseParams,
  parseAccount,
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
import { getConnection, loadKeypair, sendWithRetry } from "../utils/solana.js";
import { eventBus } from "./events.js";
import { OracleService } from "./oracle.js";

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
      const numAccounts = engine.numUsedAccounts;
      const maintenanceMarginBps = params.maintenanceMarginBps;
      const price = cfg.authorityPriceE6;

      if (price === 0n) return []; // No price set

      for (let i = 0; i < numAccounts; i++) {
        try {
          const account = parseAccount(data, i);

          // Skip LP accounts (kind=1) and empty accounts
          if (account.kind !== 0) continue;  // 0 = User
          if (account.positionSize === 0n) continue;  // No position

          // Calculate margin health using mark-to-market PnL (not stale on-chain pnl)
          // On-chain pnl is only updated during cranks; between cranks it can be stale
          const notional = absBI(account.positionSize) * price / 1_000_000n;
          if (notional === 0n) continue;

          // Compute mark PnL: (oracle - entry) * |pos| / oracle for longs
          const entryPrice = account.entryPrice;
          let markPnl = 0n;
          if (entryPrice > 0n && price > 0n) {
            const diff = account.positionSize > 0n
              ? price - entryPrice
              : entryPrice - price;
            markPnl = (diff * absBI(account.positionSize)) / price;
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
              marginRatio: 0,
              maintenanceMarginBps,
            });
            continue;
          }

          const marginRatioBps = equity * 10_000n / notional;

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

      // Send all in one tx
      // Note: sendWithRetry only takes a single IX, so we need to build the full tx
      const { Transaction } = await import("@solana/web3.js");
      const tx = new Transaction();
      for (const ix of instructions) {
        tx.add(ix);
      }
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = keypair.publicKey;
      tx.sign(keypair);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(sig, "confirmed");

      this.liquidationCount++;
      eventBus.publish("liquidation.success", slabAddress.toBase58(), {
        accountIdx,
        signature: sig,
      });
      console.log(`[LiquidationService] Liquidated account ${accountIdx} on ${slabAddress.toBase58()}: ${sig}`);
      return sig;
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
      try {
        const result = await this.scanAndLiquidateAll(getMarkets());
        if (result.candidates > 0) {
          console.log(
            `[LiquidationService] Scan: ${result.scanned} markets, ${result.candidates} candidates, ${result.liquidated} liquidated`,
          );
        }
      } catch (err) {
        console.error("[LiquidationService] Cycle error:", err);
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
