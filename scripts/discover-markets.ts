import { Connection, PublicKey } from "@solana/web3.js";
import { discoverMarkets } from "@percolator/sdk";

const RPC = process.env.RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=<your-helius-api-key>";
const SMALL_PROGRAM = "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn";

const KNOWN_FEEDS: Record<string, string> = {
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d": "SOL",
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": "BTC",
  "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": "ETH",
};

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const programId = new PublicKey(SMALL_PROGRAM);
  const markets = await discoverMarkets(conn, programId);
  console.log(`Found ${markets.length} markets on ${SMALL_PROGRAM.slice(0,8)}:`);

  const deploymentMarkets = [];
  for (const m of markets) {
    const feedId = m.config.indexFeedId;
    const feedHex = Buffer.from(
      feedId instanceof PublicKey ? feedId.toBytes() : (feedId as Uint8Array),
    ).toString("hex");
    
    const authPrice = m.config.authorityPriceE6 ?? 0n;
    const priceUsd = Number(authPrice) / 1_000_000;
    
    let symbol = KNOWN_FEEDS[feedHex] ?? "UNKNOWN";
    if (feedHex === "0".repeat(64)) {
      if (priceUsd > 50_000) symbol = "BTC";
      else if (priceUsd > 2_000) symbol = "ETH";
      else if (priceUsd > 50) symbol = "SOL";
      else symbol = "UNKNOWN";
    }
    
    console.log(`  slab=${m.slabAddress.toBase58()} symbol=${symbol} authPrice=$${priceUsd.toFixed(2)} feed=${feedHex.slice(0,16)}...`);
    deploymentMarkets.push({ symbol, label: symbol + "-PERP", slab: m.slabAddress.toBase58() });
  }
  
  const deployment = { programId: SMALL_PROGRAM, markets: deploymentMarkets };
  console.log("\nDEPLOYMENT_JSON='" + JSON.stringify(deployment) + "'");
}

main().catch(console.error);
