/**
 * S-1 (v2.2 QA 2026-10-11): /stake listed 0 pools on the v2.2 preview. The pools route scanned the stake
 * program with the SDK 8.0.0 `STAKE_POOL_SIZE` (408, the v4 layout), and every v2.2 pool is a v5
 * `StakePool` of 480 bytes (stake RC aebbff6; the SDK port lib/v22/sdk/v22-stake.ts), so the dataSize
 * filter matched nothing. Flag on: scan 480 and list only accounts the v5 decoder accepts
 * (discriminator + version 5 + the program's own bounds). Flag off: exactly the old size, no check.
 * The v1..v4 prefix the route reads (slab@8 .. pool_mode@280) is unchanged in v5.
 */
import { STAKE_POOL_SIZE } from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "./flag";
import { STAKE_POOL_SIZE_V5, decodeStakePoolV5 } from "./sdk";

/** The `dataSize` the pools scan filters on. */
export function stakePoolScanSize(): number {
  return isDevnetV22Enabled() ? STAKE_POOL_SIZE_V5 : STAKE_POOL_SIZE;
}

/** Whether a scanned account is a pool the route may list (flag off: always). */
export function isListableStakePool(data: Uint8Array): boolean {
  if (!isDevnetV22Enabled()) return true;
  try {
    decodeStakePoolV5(data);
    return true;
  } catch {
    return false;
  }
}
