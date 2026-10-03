/**
 * M-3: a close sizes from the ADL-EFFECTIVE quantity (engine 35ddd692 plan_delta applies a trade to
 * ceil(|basis| * a_side / a_basis), v16.rs:1677/:1695/:6075), read from a FRESH market read.
 * Real bytes: the captured ANSEM market + the DAC2a44p trader portfolio (long 22,736,956 basis,
 * a_basis = ADL_ONE, epoch 0), with the market's a_long / epoch / mode patched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

const FX = join(__dirname, "..", "fixtures");
const acct = (f: string) => new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(FX, f), "utf8")).dataBase64, "base64"));
const MARKET = acct("5bVTTMRc.ansem.market.json");
const PORTFOLIO = acct("DAC2a44p.portfolio.json");
const OWNER = new PublicKey(PORTFOLIO.slice(116, 148));
const PORTFOLIO_PK = new PublicKey("DAC2a44pToHS4n5dcfe82tLn1G3mNAVWq5tYKUFxQWr");
const SLAB = "5bVTTMRceF9qEERjPWvqxtrDighE846QkVXSJm4uC8Tk";
const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const ENGINE = 592 + 758 + 1024;
function patch(d: Uint8Array, o: { aLong?: bigint; epochLong?: bigint; modeLong?: number }) {
  const out = d.slice();
  const v = new DataView(out.buffer);
  if (o.aLong !== undefined) {
    v.setBigUint64(ENGINE + 49, o.aLong & 0xffff_ffff_ffff_ffffn, true);
    v.setBigUint64(ENGINE + 49 + 8, o.aLong >> 64n, true);
  }
  if (o.epochLong !== undefined) v.setBigUint64(ENGINE + 497, o.epochLong, true);
  if (o.modeLong !== undefined) out[ENGINE + 513] = o.modeLong;
  return out;
}
function withAShort(d: Uint8Array, aShort: bigint) {
  const out = d.slice();
  const v = new DataView(out.buffer);
  v.setBigUint64(ENGINE + 65, aShort & 0xffff_ffff_ffff_ffffn, true);
  v.setBigUint64(ENGINE + 65 + 8, aShort >> 64n, true);
  return out;
}
const ADL_ONE = 1_000_000_000_000_000n;
const F3_MARKET = withAShort(MARKET, (ADL_ONE * 8617n) / 10_000n);

let slabRaw: Uint8Array = F3_MARKET;
let chainMarket: Uint8Array = F3_MARKET;
const tradeMock = vi.fn();
const rebalanceMock = vi.fn(async () => ({ signature: "SIG44", fill: { kind: "full", filledQ: -22_736_956n } }));

vi.mock("@/hooks/useTrade", () => ({
  useTrade: () => ({ trade: tradeMock }),
  prewarmTradeSubmission: vi.fn(),
  findV17Portfolio: vi.fn(async () => PORTFOLIO_PK),
}));
vi.mock("@/lib/limits/rebalance-close", () => ({ closeViaRebalanceReduce: (p: unknown) => rebalanceMock(p) }));
const connection = {
  getProgramAccounts: vi.fn(async () => [{ pubkey: PORTFOLIO_PK, account: { data: Buffer.from(PORTFOLIO) } }]),
  getAccountInfo: vi.fn(async (pk: PublicKey) => (pk.toBase58() === SLAB ? { data: Buffer.from(chainMarket) } : { data: Buffer.from(PORTFOLIO) })),
};
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({ publicKey: OWNER, signTransaction: vi.fn() }),
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => ({ idx: 0, account: { positionSize: 22_736_956n } }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ accounts: [], raw: slabRaw, programId: PROGRAM, config: null, wrapperConfigV17: null }),
}));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/matcherCaps", () => ({ getMatcherCaps: vi.fn(async () => null), getLpInventoryState: vi.fn(async () => null) }));

import { useClosePosition, COPY_RESET_LEG } from "@/hooks/useClosePosition";
import { getMatcherCaps } from "@/lib/matcherCaps";

beforeEach(() => {
  tradeMock.mockReset();
  tradeMock.mockResolvedValue("SIGT");
  rebalanceMock.mockClear();
  vi.mocked(getMatcherCaps).mockResolvedValue(null);
});

const BASIS = 22_736_956n;
const A_HALF = ADL_ONE / 2n; // a_long halved by an ADL after the leg opened at a_basis = ADL_ONE
const EFFECTIVE = (BASIS * A_HALF + ADL_ONE - 1n) / ADL_ONE; // ceil = 11,368,478

const run = async (pct: number) => {
  const { result } = renderHook(() => useClosePosition(SLAB));
  let r: unknown;
  let thrown: unknown = null;
  await act(async () => {
    try {
      r = await result.current.closePosition(pct);
    } catch (e) {
      thrown = e;
    }
  });
  return { r, thrown, error: result.current.error };
};

describe("useClosePosition — ADL-effective close size (M-3)", () => {
  it("after an ADL, Close 100% reduces the EFFECTIVE quantity (tag 44), fill checked against basis", async () => {
    slabRaw = MARKET; // the poll still shows the healthy market
    chainMarket = patch(MARKET, { aLong: A_HALF });
    await run(100);
    expect(tradeMock).not.toHaveBeenCalled();
    const arg = rebalanceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.reduceQ).toBe(EFFECTIVE);
    expect(arg.beforeQ).toBe(BASIS);
  });

  it("Close 50% after an ADL is half of the EFFECTIVE position, not half of basis", async () => {
    slabRaw = MARKET;
    chainMarket = patch(MARKET, { aLong: A_HALF });
    await run(50);
    expect((rebalanceMock.mock.calls[0][0] as Record<string, unknown>).reduceQ).toBe(EFFECTIVE / 2n);
  });

  it("negative control (healthy market): effective == basis, matcher close of exactly -basis", async () => {
    slabRaw = MARKET;
    chainMarket = MARKET;
    await run(100);
    expect(rebalanceMock).not.toHaveBeenCalled();
    expect(tradeMock).toHaveBeenCalledTimes(1);
    expect((tradeMock.mock.calls[0][0] as { size: bigint }).size).toBe(-BASIS);
  });

  it("a prior-reset leg (ResetPending, epoch moved on by 1) sends nothing and says so", async () => {
    slabRaw = MARKET;
    chainMarket = patch(MARKET, { epochLong: 1n, modeLong: 2 });
    const { r, error } = await run(100);
    expect(tradeMock).not.toHaveBeenCalled();
    expect(rebalanceMock).not.toHaveBeenCalled();
    expect(r).toEqual({ signature: null });
    expect(error).toBe(COPY_RESET_LEG);
  });

  it("an epoch the engine would refuse (not a prior reset) blocks the close", async () => {
    slabRaw = MARKET;
    chainMarket = patch(MARKET, { epochLong: 2n, modeLong: 0 });
    const { thrown } = await run(100);
    expect((thrown as Error).message).toMatch(/Could not verify current on-chain position/);
    expect(tradeMock).not.toHaveBeenCalled();
    expect(rebalanceMock).not.toHaveBeenCalled();
  });

  it("M-2: a position of 4x the per-fill cap goes to trade() as 4 legs summing to -basis", async () => {
    slabRaw = MARKET;
    chainMarket = MARKET;
    vi.mocked(getMatcherCaps).mockResolvedValue({ maxFillAbs: BASIS / 4n + 1n, maxInventoryAbs: BASIS * 10n });
    await run(100);
    const p = tradeMock.mock.calls[0][0] as { size: bigint; sizes: bigint[] };
    expect(p.size).toBe(-BASIS);
    expect(p.sizes).toHaveLength(4);
    expect(p.sizes.reduce((a, b) => a + b, 0n)).toBe(-BASIS);
  });
});
