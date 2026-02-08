/**
 * DEX Oracle tests — PumpSwap, Raydium CLMM, Meteora DLMM
 */
import { PublicKey } from "@solana/web3.js";
import {
  detectDexType,
  parseDexPool,
  computeDexSpotPriceE6,
} from "../src/solana/dex-oracle.js";
import {
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} from "../src/solana/pda.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertThrows(fn: () => void, substr: string, testName: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${testName} — expected throw containing "${substr}"`);
  } catch (e: any) {
    if (!e.message.includes(substr)) {
      throw new Error(`FAIL: ${testName} — expected "${substr}" but got "${e.message}"`);
    }
  }
}

// Helper to write u16 LE
function writeU16LE(buf: Uint8Array, offset: number, val: number) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
}

// Helper to write i32 LE
function writeI32LE(buf: Uint8Array, offset: number, val: number) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setInt32(offset, val, true);
}

// Helper to write u64 LE
function writeU64LE(buf: Uint8Array, offset: number, val: bigint) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(offset, Number(val & 0xffffffffn), true);
  dv.setUint32(offset + 4, Number((val >> 32n) & 0xffffffffn), true);
}

// Helper to write u128 LE
function writeU128LE(buf: Uint8Array, offset: number, val: bigint) {
  writeU64LE(buf, offset, val & ((1n << 64n) - 1n));
  writeU64LE(buf, offset + 8, val >> 64n);
}

// Helper: fill 32 bytes with a pubkey-like pattern
function fillPubkey(buf: Uint8Array, offset: number, seed: number) {
  for (let i = 0; i < 32; i++) buf[offset + i] = (seed + i) % 256;
}

// ===========================================================================
// detectDexType
// ===========================================================================

console.log("--- detectDexType ---");

assert(detectDexType(PUMPSWAP_PROGRAM_ID) === "pumpswap", "detect pumpswap");
assert(detectDexType(RAYDIUM_CLMM_PROGRAM_ID) === "raydium-clmm", "detect raydium-clmm");
assert(detectDexType(METEORA_DLMM_PROGRAM_ID) === "meteora-dlmm", "detect meteora-dlmm");
assert(detectDexType(PublicKey.default) === null, "detect unknown returns null");
assert(detectDexType(new PublicKey("11111111111111111111111111111111")) === null, "detect system program returns null");

console.log("  ✓ detectDexType");

// ===========================================================================
// PumpSwap
// ===========================================================================

console.log("--- PumpSwap ---");

function makePumpSwapPoolData(): Uint8Array {
  const buf = new Uint8Array(200);
  fillPubkey(buf, 35, 1);   // baseMint
  fillPubkey(buf, 67, 33);  // quoteMint
  fillPubkey(buf, 131, 65); // baseVault
  fillPubkey(buf, 163, 97); // quoteVault
  return buf;
}

function makeSplTokenAccount(amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  writeU64LE(buf, 64, amount);
  return buf;
}

// Parse
{
  const data = makePumpSwapPoolData();
  const pool = parseDexPool("pumpswap", PublicKey.default, data);
  assert(pool.dexType === "pumpswap", "pumpswap parse type");
  assert(pool.baseMint !== undefined, "pumpswap has baseMint");
  assert(pool.baseVault !== undefined, "pumpswap has baseVault");
  assert(pool.quoteVault !== undefined, "pumpswap has quoteVault");
}

// Parse too-short data
assertThrows(
  () => parseDexPool("pumpswap", PublicKey.default, new Uint8Array(100)),
  "too short",
  "pumpswap parse too short"
);

// Price computation — normal
{
  const poolData = makePumpSwapPoolData();
  const base = makeSplTokenAccount(1_000_000_000n); // 1B base
  const quote = makeSplTokenAccount(500_000_000n);   // 500M quote
  const price = computeDexSpotPriceE6("pumpswap", poolData, { base, quote });
  // price = 500M * 1e6 / 1B = 500_000
  assert(price === 500_000n, `pumpswap normal price: expected 500000, got ${price}`);
}

// Price — zero base returns 0
{
  const poolData = makePumpSwapPoolData();
  const base = makeSplTokenAccount(0n);
  const quote = makeSplTokenAccount(100n);
  const price = computeDexSpotPriceE6("pumpswap", poolData, { base, quote });
  assert(price === 0n, "pumpswap zero base returns 0");
}

// Price — very large amounts
{
  const poolData = makePumpSwapPoolData();
  const base = makeSplTokenAccount(18_446_744_073_709_551_615n); // u64 max
  const quote = makeSplTokenAccount(18_446_744_073_709_551_615n);
  const price = computeDexSpotPriceE6("pumpswap", poolData, { base, quote });
  assert(price === 1_000_000n, `pumpswap equal large amounts: expected 1000000, got ${price}`);
}

// Vault data too short
assertThrows(
  () => computeDexSpotPriceE6("pumpswap", makePumpSwapPoolData(), {
    base: new Uint8Array(10),
    quote: makeSplTokenAccount(100n),
  }),
  "too short",
  "pumpswap base vault too short"
);

// Missing vaultData
assertThrows(
  () => computeDexSpotPriceE6("pumpswap", makePumpSwapPoolData()),
  "vaultData",
  "pumpswap missing vaultData"
);

console.log("  ✓ PumpSwap");

// ===========================================================================
// Raydium CLMM
// ===========================================================================

console.log("--- Raydium CLMM ---");

function makeRaydiumClmmData(decimals0: number, decimals1: number, sqrtPriceX64: bigint): Uint8Array {
  const buf = new Uint8Array(280);
  fillPubkey(buf, 73, 1);   // baseMint
  fillPubkey(buf, 105, 33); // quoteMint
  buf[233] = decimals0;
  buf[234] = decimals1;
  writeU128LE(buf, 253, sqrtPriceX64);
  return buf;
}

// Parse
{
  const data = makeRaydiumClmmData(9, 6, 1n << 64n);
  const pool = parseDexPool("raydium-clmm", PublicKey.default, data);
  assert(pool.dexType === "raydium-clmm", "raydium parse type");
}

// Parse too short
assertThrows(
  () => parseDexPool("raydium-clmm", PublicKey.default, new Uint8Array(100)),
  "too short",
  "raydium parse too short"
);

// Normal price: sqrt = 2^64 → price = 1.0 (with equal decimals)
// sqrt_price_x64 = 2^64 means sqrt(price) = 1, so price = 1
// With decimals0 = decimals1, price_e6 should be 1_000_000
{
  const sqrtPriceX64 = 1n << 64n; // sqrt = 1.0 in Q64.64
  const data = makeRaydiumClmmData(6, 6, sqrtPriceX64);
  const price = computeDexSpotPriceE6("raydium-clmm", data);
  // price = (2^64)^2 * 10^(6+6-6) / 2^128 = 1 * 10^6 = 1_000_000
  assert(price === 1_000_000n, `raydium price=1: expected 1000000, got ${price}`);
}

// Micro-price (THE BUG CASE): sqrt < 2^64
// This is the critical test — previously sqrtHi = 0, returning 0
{
  // sqrt_price_x64 = 2^32 (much less than 2^64)
  // price = (2^32)^2 / 2^128 = 2^64 / 2^128 = 2^-64 ≈ 5.4e-20
  // With decimals0=9, decimals1=6: scale = 10^(6+9-6) = 10^9
  // price_e6 = 5.4e-20 * 1e9 = 5.4e-11 → still 0 at integer level
  // Let's use a more realistic micro-price:
  // sqrt_price_x64 = 2^48 → price = 2^96 / 2^128 = 2^-32 ≈ 2.3e-10
  // With d0=9, d1=6: price_e6 = 2.3e-10 * 1e9 = 0.23 → 0 (still small)
  // Use sqrt_price_x64 = 2^56 → price = 2^112/2^128 = 2^-16 ≈ 1.5e-5
  // With d0=9, d1=6: price_e6 = 1.5e-5 * 1e9 = 15258
  const sqrtPriceX64 = 1n << 56n;
  const data = makeRaydiumClmmData(9, 6, sqrtPriceX64);
  const price = computeDexSpotPriceE6("raydium-clmm", data);
  // Exact: (2^56)^2 / 2^128 * 10^9 = 2^112 / 2^128 * 1e9 = 1e9 / 2^16 = 15258.7...
  // With our method: scaled = 2^56 * 1e6 = ... >> 64 gives term, etc.
  // The key assertion: price MUST be > 0 (the old code would give 0)
  assert(price > 0n, `raydium micro-price must be > 0, got ${price}`);
  // Should be approximately 15258
  assert(price >= 15000n && price <= 16000n, `raydium micro-price ~15258, got ${price}`);
}

// Extreme: sqrt = 0 returns 0
{
  const data = makeRaydiumClmmData(6, 6, 0n);
  const price = computeDexSpotPriceE6("raydium-clmm", data);
  assert(price === 0n, "raydium zero sqrt returns 0");
}

// Large sqrt — won't overflow with BigInt
{
  const sqrtPriceX64 = (1n << 96n); // large sqrt
  const data = makeRaydiumClmmData(6, 6, sqrtPriceX64);
  const price = computeDexSpotPriceE6("raydium-clmm", data);
  // price = (2^96)^2 / 2^128 * 1e6 = 2^64 * 1e6 = 18446744073709551616000000
  assert(price > 0n, `raydium large sqrt > 0, got ${price}`);
}

// Negative decimal diff (decimals1 > decimals0)
{
  const sqrtPriceX64 = 1n << 64n;
  const data = makeRaydiumClmmData(6, 9, sqrtPriceX64);
  const price = computeDexSpotPriceE6("raydium-clmm", data);
  // price = 1 * 10^(6+6-9) = 10^3 = 1000
  assert(price === 1000n, `raydium neg decimal diff: expected 1000, got ${price}`);
}

// Data too short
assertThrows(
  () => computeDexSpotPriceE6("raydium-clmm", new Uint8Array(100)),
  "too short",
  "raydium data too short"
);

console.log("  ✓ Raydium CLMM");

// ===========================================================================
// Meteora DLMM
// ===========================================================================

console.log("--- Meteora DLMM ---");

function makeMeteoraData(binStep: number, activeId: number): Uint8Array {
  const buf = new Uint8Array(200);
  fillPubkey(buf, 81, 1);   // baseMint
  fillPubkey(buf, 113, 33); // quoteMint
  writeU16LE(buf, 74, binStep);
  writeI32LE(buf, 77, activeId);
  return buf;
}

// Parse
{
  const data = makeMeteoraData(10, 0);
  const pool = parseDexPool("meteora-dlmm", PublicKey.default, data);
  assert(pool.dexType === "meteora-dlmm", "meteora parse type");
}

// Parse too short
assertThrows(
  () => parseDexPool("meteora-dlmm", PublicKey.default, new Uint8Array(50)),
  "too short",
  "meteora parse too short"
);

// active_id = 0 → price = 1.0 → price_e6 = 1_000_000
{
  const data = makeMeteoraData(10, 0);
  const price = computeDexSpotPriceE6("meteora-dlmm", data);
  assert(price === 1_000_000n, `meteora activeId=0: expected 1000000, got ${price}`);
}

// Positive active_id: price = (1 + 10/10000)^100 = 1.001^100 ≈ 1.10511
{
  const data = makeMeteoraData(10, 100);
  const price = computeDexSpotPriceE6("meteora-dlmm", data);
  // Should be approximately 1_105_116 (1.105116 * 1e6)
  assert(price >= 1_100_000n && price <= 1_110_000n, `meteora positive activeId ~1105116, got ${price}`);
}

// Negative active_id: price = 1 / (1.001^100) ≈ 0.90484
{
  const data = makeMeteoraData(10, -100);
  const price = computeDexSpotPriceE6("meteora-dlmm", data);
  assert(price >= 900_000n && price <= 910_000n, `meteora negative activeId ~904837, got ${price}`);
}

// Zero bin_step returns 0
{
  const data = makeMeteoraData(0, 100);
  const price = computeDexSpotPriceE6("meteora-dlmm", data);
  assert(price === 0n, "meteora zero bin_step returns 0");
}

// Large positive exponent
{
  const data = makeMeteoraData(1, 10000);
  const price = computeDexSpotPriceE6("meteora-dlmm", data);
  // (1 + 1/10000)^10000 ≈ e ≈ 2.718 → price_e6 ≈ 2_718_281
  assert(price >= 2_700_000n && price <= 2_730_000n, `meteora large exp ~2718281, got ${price}`);
}

// Data too short
assertThrows(
  () => computeDexSpotPriceE6("meteora-dlmm", new Uint8Array(50)),
  "too short",
  "meteora data too short"
);

console.log("  ✓ Meteora DLMM");

// ===========================================================================
// parseDexPool — all 3 types
// ===========================================================================

console.log("--- parseDexPool dispatch ---");

{
  const ps = parseDexPool("pumpswap", PublicKey.default, makePumpSwapPoolData());
  assert(ps.dexType === "pumpswap", "parseDexPool pumpswap");
  
  const ry = parseDexPool("raydium-clmm", PublicKey.default, makeRaydiumClmmData(6, 6, 1n << 64n));
  assert(ry.dexType === "raydium-clmm", "parseDexPool raydium");
  
  const mt = parseDexPool("meteora-dlmm", PublicKey.default, makeMeteoraData(10, 0));
  assert(mt.dexType === "meteora-dlmm", "parseDexPool meteora");
}

console.log("  ✓ parseDexPool dispatch");

console.log("\n✅ All dex-oracle tests passed!");
