/**
 * Oracle parsing/validation tests
 *
 * Tests for parseChainlinkPrice() which extracts price data from
 * Chainlink aggregator account buffers with proper validation.
 *
 * Ported from Toly's percolator-cli (aeyakovenko/percolator-cli, Feb 16 2026)
 * with adaptations for browser-compatible Uint8Array API.
 */

import {
  parseChainlinkPrice,
  isValidChainlinkOracle,
  CHAINLINK_MIN_SIZE,
  CHAINLINK_DECIMALS_OFFSET,
  CHAINLINK_ANSWER_OFFSET,
} from "../src/solana/oracle.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertThrows(fn: () => void, expectedMsg: string, testName: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${testName} - expected to throw`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("FAIL:")) {
      throw e;
    }
    if (e instanceof Error && e.message.includes(expectedMsg)) {
      // OK
    } else {
      throw new Error(`FAIL: ${testName} - expected "${expectedMsg}" in error, got: ${e}`);
    }
  }
}

/**
 * Build a valid Chainlink aggregator buffer for testing.
 * Chainlink layout: decimals at offset 138 (u8), answer at offset 216 (i64 LE)
 */
function buildChainlinkBuffer(decimals: number, answer: bigint, size = 256): Uint8Array {
  const buf = new Uint8Array(size);
  buf[CHAINLINK_DECIMALS_OFFSET] = decimals;
  const dv = new DataView(buf.buffer);
  dv.setBigInt64(CHAINLINK_ANSWER_OFFSET, answer, true);
  return buf;
}

console.log("Testing Chainlink oracle parsing...\n");

// --- parseChainlinkPrice ---

// Valid oracle data
{
  const buf = buildChainlinkBuffer(8, 10012345678n); // $100.12345678
  const result = parseChainlinkPrice(buf);
  assert(result.decimals === 8, "decimals parsed correctly");
  assert(result.price === 10012345678n, "price parsed correctly");
  console.log("✓ parses valid oracle data");
}

// Different decimal values
{
  const buf6 = buildChainlinkBuffer(6, 100_000_000n);
  const r6 = parseChainlinkPrice(buf6);
  assert(r6.decimals === 6, "6 decimals");
  assert(r6.price === 100_000_000n, "price with 6 decimals");

  const buf0 = buildChainlinkBuffer(0, 42n);
  const r0 = parseChainlinkPrice(buf0);
  assert(r0.decimals === 0, "0 decimals");
  assert(r0.price === 42n, "price with 0 decimals");

  console.log("✓ handles various decimal values");
}

// Accepts 18 decimals (maximum)
{
  const buf18 = buildChainlinkBuffer(18, 1000n);
  const r18 = parseChainlinkPrice(buf18);
  assert(r18.decimals === 18, "accepts 18 decimals");
  console.log("✓ accepts 18 decimals");
}

// Accepts minimal 224-byte buffer
{
  const minimal = buildChainlinkBuffer(8, 1000n, CHAINLINK_MIN_SIZE);
  const minResult = parseChainlinkPrice(minimal);
  assert(minResult.price === 1000n, "accepts minimal 224-byte buffer");
  console.log("✓ accepts minimal 224-byte buffer");
}

// Rejects undersized buffers
{
  assertThrows(
    () => parseChainlinkPrice(new Uint8Array(100)),
    "too small",
    "rejects buffer < 224 bytes"
  );
  assertThrows(
    () => parseChainlinkPrice(new Uint8Array(223)),
    "too small",
    "rejects buffer of exactly 223 bytes"
  );
  console.log("✓ rejects undersized buffers");
}

// Rejects empty buffer
{
  assertThrows(
    () => parseChainlinkPrice(new Uint8Array(0)),
    "too small",
    "rejects empty buffer"
  );
  console.log("✓ rejects empty buffer");
}

// Rejects zero price
{
  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(8, 0n)),
    "non-positive",
    "rejects zero price"
  );
  console.log("✓ rejects zero price");
}

// Rejects negative price
{
  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(8, -100n)),
    "non-positive",
    "rejects negative price"
  );
  console.log("✓ rejects negative price");
}

// Rejects decimals > 18
{
  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(19, 1000n)),
    "decimals",
    "rejects decimals > 18"
  );
  assertThrows(
    () => parseChainlinkPrice(buildChainlinkBuffer(255, 1000n)),
    "decimals",
    "rejects decimals = 255"
  );
  console.log("✓ rejects unreasonable decimals");
}

// --- isValidChainlinkOracle ---

console.log("\nTesting isValidChainlinkOracle...\n");

{
  assert(isValidChainlinkOracle(buildChainlinkBuffer(8, 10012345678n)) === true, "valid oracle returns true");
  assert(isValidChainlinkOracle(new Uint8Array(100)) === false, "too-small returns false");
  assert(isValidChainlinkOracle(buildChainlinkBuffer(8, 0n)) === false, "zero price returns false");
  assert(isValidChainlinkOracle(buildChainlinkBuffer(255, 1000n)) === false, "bad decimals returns false");
  console.log("✓ isValidChainlinkOracle works correctly");
}

// --- Constants ---

console.log("\nTesting exported constants...\n");

{
  assert(CHAINLINK_MIN_SIZE === 224, "CHAINLINK_MIN_SIZE = 224");
  assert(CHAINLINK_DECIMALS_OFFSET === 138, "CHAINLINK_DECIMALS_OFFSET = 138");
  assert(CHAINLINK_ANSWER_OFFSET === 216, "CHAINLINK_ANSWER_OFFSET = 216");
  console.log("✓ exported constants correct");
}

console.log("\n✅ All oracle tests passed!");
