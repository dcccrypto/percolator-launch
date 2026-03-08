#!/usr/bin/env npx tsx
import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const slabArg = process.argv[2];
if (!slabArg) throw new Error("Usage: npx tsx scripts/dump-slab-raw.ts <SLAB_PUBKEY>");

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const info = await conn.getAccountInfo(new PublicKey(slabArg));
  if (!info) { console.log("not found"); return; }
  
  const d = new Uint8Array(info.data);
  console.log(`Slab: ${slabArg}`);
  console.log(`Size: ${d.length} bytes\n`);
  
  const dv = new DataView(d.buffer, d.byteOffset);
  const u32le = (off: number) => dv.getUint32(off, true);
  const u64le = (off: number) => dv.getBigUint64(off, true);

  console.log("Header (0..72):");
  console.log(`  magic:    ${Buffer.from(d.slice(0,8)).toString("hex")} (u64=${u64le(0)})`);
  console.log(`  version:  ${u32le(8)}`);
  console.log(`  bump:     ${d[12]}`);
  console.log(`  flags:    0x${d[13].toString(16)}`);
  console.log(`  admin:    ${new PublicKey(d.slice(16,48)).toBase58()}`);
  
  // Config at offset 72 (V0_HEADER_LEN)
  console.log("\nConfig at offset 72 (V0 default):");
  const mint72 = d.slice(72, 104);
  const allZero72 = mint72.every(b => b === 0);
  console.log(`  collateral_mint (72..104): ${allZero72 ? "ALL ZEROS" : new PublicKey(mint72).toBase58()}`);
  
  // Also try offset 104 (in case header is 104 bytes in V1)
  console.log("\nConfig at offset 104 (V1 header size):");
  const mint104 = d.slice(104, 136);
  const allZero104 = mint104.every(b => b === 0);
  console.log(`  collateral_mint (104..136): ${allZero104 ? "ALL ZEROS" : new PublicKey(mint104).toBase58()}`);
}

main().catch(console.error);
