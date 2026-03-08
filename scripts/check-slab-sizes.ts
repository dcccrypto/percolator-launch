import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID ?? "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn";

// Fetch counts by each expected tier size
const TIERS: Record<string, number> = {
  small: 62_808,
  medium: 248_760,
  large: 992_568,
};

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const prog = new PublicKey(PROGRAM_ID);

  console.log(`Program: ${PROGRAM_ID}`);
  console.log(`RPC:     ${RPC.replace(/api-key=.*/, "api-key=***")}\n`);

  let totalKnown = 0;
  const knownPubkeys = new Set<string>();

  for (const [tier, dataSize] of Object.entries(TIERS)) {
    const accounts = await conn.getProgramAccounts(prog, {
      commitment: "confirmed",
      filters: [{ dataSize }],
      dataSlice: { offset: 0, length: 0 },
    });
    console.log(`  ${tier.padEnd(6)} (${dataSize} bytes): ${accounts.length} slab(s)`);
    totalKnown += accounts.length;
    for (const { pubkey } of accounts) knownPubkeys.add(pubkey.toBase58());
  }

  // Find accounts that don't match any standard size
  const allAccounts = await conn.getProgramAccounts(prog, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: 4 }, // small slice to count total
  });
  
  console.log(`\n  TOTAL program accounts: ${allAccounts.length}`);
  
  const broken = allAccounts.filter((a) => !knownPubkeys.has(a.pubkey.toBase58()));
  if (broken.length === 0) {
    console.log("  ✅ All accounts match a known tier size — no broken slabs under this program.\n");
    console.log("  Note: If the BTC slab is under a DIFFERENT program ID, check that program separately.");
  } else {
    console.log(`\n  ⚠️  ${broken.length} account(s) with non-standard sizes:`);
    for (const b of broken) {
      // Re-fetch to get actual size
      const info = await conn.getAccountInfo(b.pubkey);
      console.log(`    ${b.pubkey.toBase58()} — ${info?.data.length ?? "?"} bytes`);
    }
  }
}

main().catch(console.error);
