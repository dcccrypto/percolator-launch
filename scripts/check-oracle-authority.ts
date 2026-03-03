#!/usr/bin/env npx tsx
/**
 * Check oracle_authority on all markets — diagnose OraclePush failures
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { discoverMarkets } from "@percolator/sdk";

const HELIUS_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC_URL = HELIUS_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.devnet.solana.com";

const PROGRAM_ID = new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn");
const MAKER_WALLET = new PublicKey("6cZPV3w2ySoiKgCUn5b3SbXrarPfaf72d9veTgRic7tL");
const FILLER_WALLET = new PublicKey("FPQa6EfDYwc35TDnfbMBojdTmcB9EPhzEQc27oEcRb2X");

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  console.log("RPC:", RPC_URL.replace(/api-key=.*/, "api-key=***"));

  const markets = await discoverMarkets(conn, PROGRAM_ID);
  console.log(`\nFound ${markets.length} markets\n`);

  for (const m of markets) {
    const feedId = m.config.indexFeedId;
    const feedHex = Buffer.from(
      feedId instanceof PublicKey ? feedId.toBytes() : (feedId as Uint8Array),
    ).toString("hex");
    const isHyperp = feedHex === "0".repeat(64);

    let symbol = "UNKNOWN";
    if (isHyperp) {
      const markUsd = Number(m.config.authorityPriceE6 ?? 0n) / 1_000_000;
      if (markUsd > 50_000) symbol = "BTC";
      else if (markUsd > 2_000) symbol = "ETH";
      else if (markUsd > 50) symbol = "SOL";
    }

    if (m.header.paused || m.header.resolved) continue;

    const oracleAuth = m.config.oracleAuthority.toBase58();
    const isZero = m.config.oracleAuthority.equals(PublicKey.default);

    console.log(`${symbol} | slab=${m.slabAddress.toBase58()}`);
    console.log(`  oracle_authority: ${oracleAuth}`);
    console.log(`  oracle_authority_is_zero: ${isZero}`);
    console.log(`  admin: ${m.header.admin?.toBase58() ?? "N/A"}`);
    console.log(`  maker_matches: ${oracleAuth === MAKER_WALLET.toBase58()}`);
    console.log(`  filler_matches: ${oracleAuth === FILLER_WALLET.toBase58()}`);
    console.log(`  price: $${(Number(m.config.authorityPriceE6 ?? 0n) / 1e6).toFixed(2)}`);
    console.log(`  collateral_mint: ${m.config.collateralMint.toBase58()}`);
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
