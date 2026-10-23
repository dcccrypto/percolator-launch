/**
 * AUD-T4-2: with the v2.2 flag on, the health slice is sized for the 4,059 B v2.2 market, so a 3,675 B v2.1 market used to
 * fail with a plain Error ("need 4059 bytes, got 3675"). It must be the typed UnknownLayoutError, which every caller already
 * routes to the calm "unsupported layout" UI (isUnsupportedLayout). Mode-independent: each case sets the flag itself and
 * re-imports, because MARKET_HEALTH_SLICE_LEN is fixed at module load.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const MAGIC = 0x5045_5243_5631_3600n; // "PERCV16\0"
function marketHeader(len: number, version: number): Uint8Array {
  const d = new Uint8Array(len);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(0, MAGIC, true);
  dv.setUint16(8, version, true);
  d[10] = 1; // ACCOUNT_KIND.Market
  return d;
}

async function load(v22: boolean) {
  vi.resetModules();
  if (v22) process.env.NEXT_PUBLIC_DEVNET_V22 = "1";
  else delete process.env.NEXT_PUBLIC_DEVNET_V22;
  const flag = await import("@/lib/v22/flag");
  flag.__setDevnetV22ForTest(v22);
  const mh = await import("@/lib/market-health");
  const layout = await import("@/lib/v22/layout");
  return { ...mh, isUnsupportedLayout: layout.isUnsupportedLayout, flag };
}

const prevEnv = process.env.NEXT_PUBLIC_DEVNET_V22;
afterEach(async () => {
  if (prevEnv === undefined) delete process.env.NEXT_PUBLIC_DEVNET_V22;
  else process.env.NEXT_PUBLIC_DEVNET_V22 = prevEnv;
  (await import("@/lib/v22/flag")).__setDevnetV22ForTest(null);
  vi.resetModules();
});

describe("decodeMarketHealth on a 3,675 B v2.1 market (AUD-T4-2)", () => {
  it("flag on: the typed UnknownLayoutError (TOO_SHORT), recognised by isUnsupportedLayout", async () => {
    const { decodeMarketHealth, isUnsupportedLayout, MARKET_HEALTH_SLICE_LEN } = await load(true);
    expect(MARKET_HEALTH_SLICE_LEN).toBe(4_059);
    let err: unknown = null;
    try {
      decodeMarketHealth(marketHeader(3_675, 18), 0n, null);
    } catch (e) {
      err = e;
    }
    expect(isUnsupportedLayout(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("TOO_SHORT");
    expect((err as Error).message).toContain("need 4059 bytes, got 3675");
  });
  it("flag on: an unknown VERSION is named as such, not as a short buffer", async () => {
    const { decodeMarketHealth, isUnsupportedLayout } = await load(true);
    let err: unknown = null;
    try {
      decodeMarketHealth(marketHeader(3_675, 99), 0n, null);
    } catch (e) {
      err = e;
    }
    expect(isUnsupportedLayout(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("UNKNOWN_VERSION");
  });
  it("flag off: a short buffer keeps the historical plain Error", async () => {
    const { decodeMarketHealth, isUnsupportedLayout, MARKET_HEALTH_SLICE_LEN } = await load(false);
    let err: unknown = null;
    try {
      decodeMarketHealth(new Uint8Array(100), 0n, null);
    } catch (e) {
      err = e;
    }
    expect(isUnsupportedLayout(err)).toBe(false);
    expect((err as Error).message).toBe(`decodeMarketHealth: need ${MARKET_HEALTH_SLICE_LEN} bytes, got 100`);
  });
});
