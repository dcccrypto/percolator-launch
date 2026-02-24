import { PublicKey } from "@solana/web3.js";
import { discoverMarkets, type DiscoveredMarket } from "@percolator/sdk";
import { config, getConnection, getFallbackConnection, createLogger, captureException } from "@percolator/shared";

const logger = createLogger("indexer:market-discovery");

export class MarketDiscovery {
  private markets = new Map<string, { market: DiscoveredMarket }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  
  async discover(): Promise<DiscoveredMarket[]> {
    const programIds = config.allProgramIds;
    const conn = getFallbackConnection();
    const all: DiscoveredMarket[] = [];
    
    for (const id of programIds) {
      try {
        const found = await discoverMarkets(conn, new PublicKey(id));
        all.push(...found);
      } catch (e) {
        logger.warn("Failed to discover on program", { programId: id, error: e });
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    
    for (const market of all) {
      this.markets.set(market.slabAddress.toBase58(), { market });
    }
    
    logger.info("Market discovery complete", { totalMarkets: all.length });
    return all;
  }
  
  getMarkets() {
    return this.markets;
  }
  
  start(intervalMs = 300_000) {
    this.discover().catch((err) => {
      logger.error("Initial discovery failed", { error: err });
      captureException(err, { tags: { context: "market-discovery-initial" } });
    });
    this.timer = setInterval(() => this.discover().catch((err) => {
      logger.error("Discovery failed", { error: err });
      captureException(err, { tags: { context: "market-discovery-periodic" } });
    }), intervalMs);
  }
  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
