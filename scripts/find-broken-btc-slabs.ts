#!/usr/bin/env npx tsx
/**
 * find-broken-btc-slabs.ts — Scan for wrong-size slabs and identify BTC markets.
 * V1-format slabs (65088 / 1025568 bytes) use a 104-byte header, not 72.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";
import { SLAB_TIERS } from "../packages/core/src/solana/discovery.js";
dotenv.config();

const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.RPC_URL ??
  (HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.devnet.solana.com");
const PROGRAM_ID = process.env.PROGRAM_ID ?? "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn";

const KNOWN_SIZES = new Set([
  ...Object.values(SLAB_TIERS).map(t => t.dataSize),
  65_352, 257_448, 1_025_832, // V1 official
  65_088, 1_025_568,           // observed V1 variant
  16_320,                      // tiny (probably not a real slab)
]);
const VALID_SIZES = new Set(Object.values(SLAB_TIERS).map(t => t.dataSize));

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset);
const u32le = (d: Uint8Array, off: number) => dv(d).getUint32(off, true);
const u64le = (d: Uint8Array, off: number) => dv(d).getBigUint64(off, true);

function readMint(d: Uint8Array, configOff: number): string | null {
  if (d.length < configOff + 32) return null;
  const bytes = d.slice(configOff, configOff + 32);
  if (bytes.every(b => b === 0)) return null;
  return new PublicKey(bytes).toBase58();
}

function readMarkPriceUsd(d: Uint8Array, engineOff: number, markPriceFieldOff: number): number {
  const absOff = engineOff + markPriceFieldOff;
  if (d.length < absOff + 8) return 0;
  const priceE6 = u64le(d, absOff);
  return Number(priceE6) / 1_000_000;
}

// V1 layout: header=104, config=536, engine_off=640, mark_price_field_off=400
const V1_HEADER_LEN = 104;
const V1_ENGINE_OFF = 640;
const V1_MARK_PRICE_OFF_IN_ENGINE = 400;

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const prog = new PublicKey(PROGRAM_ID);

  console.log(`Program: ${PROGRAM_ID}`);
  console.log(`RPC:     ${RPC.replace(/api-key=.*/, "api-key=***")}\n`);

  console.log("Fetching all program accounts...");
  const allAccounts = await conn.getProgramAccounts(prog, { commitment: "confirmed" });
  console.log(`Found ${allAccounts.length} total accounts\n`);

  const broken: Array<{ pubkey: string; size: number; data: Uint8Array }> = [];
  const sizeMap: Record<number, number> = {};

  for (const { pubkey, account } of allAccounts) {
    const size = account.data.length;
    sizeMap[size] = (sizeMap[size] ?? 0) + 1;
    if (!VALID_SIZES.has(size)) {
      broken.push({ pubkey: pubkey.toBase58(), size, data: new Uint8Array(account.data) });
    }
  }

  console.log("Size distribution:");
  for (const [size, count] of Object.entries(sizeMap).sort(([a], [b]) => Number(a) - Number(b))) {
    const ok = VALID_SIZES.has(Number(size));
    console.log(`  ${String(size).padStart(9)} bytes [${ok ? "✅ ok" : "⚠️  BROKEN"}]: ${count}`);
  }

  if (broken.length === 0) { console.log("\n✅ No broken slabs."); return; }
  console.log(`\n⚠️  ${broken.length} broken slab(s):\n`);

  // First pass: collect mints from CORRECT-size slabs to find known BTC mints
  // (we still need to parse correct slabs to find BTC mints by mark price)
  // Since parseEngine may not work for all correct slabs here, rely on raw bytes too
  const btcMints = new Set<string>();
  for (const { account } of allAccounts) {
    const d = new Uint8Array(account.data);
    if (!VALID_SIZES.has(d.length)) continue;
    // V0 correct size uses V1_ENGINE_OFF=640 (current default)
    const markUsd = readMarkPriceUsd(d, V1_ENGINE_OFF, V1_MARK_PRICE_OFF_IN_ENGINE);
    if (markUsd >= 20_000 && markUsd <= 200_000) {
      // V0 slab header is 72 bytes, config at 72
      const mint = readMint(d, 72);
      if (mint) btcMints.add(mint);
    }
  }
  console.log(`BTC mints from working slabs (${btcMints.size}): ${[...btcMints].map(m => m.slice(0,12)).join(", ") || "none"}\n`);

  const btcSlabs: string[] = [];

  for (const { pubkey, size, data: d } of broken) {
    const version = d.length >= 12 ? u32le(d, 8) : -1;
    let admin = "?";
    try { admin = new PublicKey(d.slice(16, 48)).toBase58().slice(0, 12); } catch {}

    // Try both V0 (offset 72) and V1 (offset 104) config positions for the mint
    const mintV0 = readMint(d, 72);
    const mintV1 = readMint(d, 104);
    const mint = mintV1 ?? mintV0 ?? "?";

    // Mark price at V1 engine offset (640 + 400 = 1040)
    const markUsd = readMarkPriceUsd(d, V1_ENGINE_OFF, V1_MARK_PRICE_OFF_IN_ENGINE);

    let symbol = "UNKNOWN";
    if (btcMints.has(mint)) {
      symbol = "BTC (mint match)";
    } else if (markUsd >= 20_000 && markUsd <= 200_000) {
      symbol = "BTC (price)";
    }

    const isBtc = symbol.startsWith("BTC");
    const prefix = isBtc ? "🔴 BTC" : "⚪ ???";
    console.log(`${prefix}  ${pubkey}  size=${size}  v=${version}  admin=${admin}  mint=${mint.slice(0,12)}  mark=$${markUsd.toFixed(0)}`);

    if (isBtc) btcSlabs.push(pubkey);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  if (btcSlabs.length > 0) {
    console.log(`BTC slabs to reinit (${btcSlabs.length}):`);
    for (const s of btcSlabs) {
      console.log(`  npx tsx scripts/reinit-slab.ts --slab ${s} --dry-run`);
    }
  } else {
    console.log("No BTC slabs identified by mint or price among the broken accounts.");
    console.log("→ All 15 broken slabs are likely old test/dev markets. BTC crash may be elsewhere.");
    console.log("\nRaw mint list for manual review:");
    for (const { pubkey, size, data: d } of broken) {
      const mintV1 = readMint(d, 104);
      const mintV0 = readMint(d, 72);
      console.log(`  ${pubkey.slice(0,12)}...  size=${size}  mintV0=${(mintV0 ?? "0").slice(0,12)}  mintV1=${(mintV1 ?? "0").slice(0,12)}`);
    }
  }
}

main().catch(console.error);
