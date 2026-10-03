/**
 * F-3 / R1 routing in useClosePosition, on REAL bytes: a captured v18 market (ANSEM 5bVTTMRc,
 * set to Sieve's F-3 state a_short = 0.8617·ADL_ONE) and a captured TRADER portfolio (DAC2a44p,
 * long 22,736,956 q, market_id 1; its own market was not captured, so the ANSEM market with the
 * same market_id stands in). Owner = the connected wallet. (2SewEcvf is ANSEM's LP — a close
 * never targets an LP portfolio.)
 *   - reduce-only => the close goes to tag 44 (closeViaRebalanceReduce) with the fresh position,
 *     never to the matcher;
 *   - healthy market => the matcher close; if THAT fails wrapper-Custom(21) and a fresh read
 *     shows reduce-only (the poll lagged), it falls back to tag 44;
 *   - healthy market + a 21 that is NOT reduce-only => the original error is shown.
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

import { useClosePosition } from "@/hooks/useClosePosition";

beforeEach(() => {
  tradeMock.mockReset();
  rebalanceMock.mockClear();
});

describe("useClosePosition — F-3 reduce-only routing (real ANSEM bytes)", () => {
  it("reduce-only market => tag 44 with the fresh position; the matcher is never called", async () => {
    slabRaw = F3_MARKET;
    chainMarket = F3_MARKET;
    const { result } = renderHook(() => useClosePosition(SLAB));
    let r: unknown;
    await act(async () => {
      r = await result.current.closePosition(100);
    });
    expect(tradeMock).not.toHaveBeenCalled();
    expect(rebalanceMock).toHaveBeenCalledTimes(1);
    const arg = rebalanceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.beforeQ).toBe(22_736_956n);
    expect(arg.reduceQ).toBe(22_736_956n);
    expect((arg.portfolio as PublicKey).equals(PORTFOLIO_PK)).toBe(true);
    expect((arg.owner as PublicKey).equals(OWNER)).toBe(true);
    expect(arg.marketId).toBe(1n);
    expect(r).toEqual({ signature: "SIG44", fill: { kind: "full", filledQ: -22_736_956n } });
    expect(result.current.error).toBeNull();
  });

  it("stale poll (healthy) but the chain is reduce-only: the close's FRESH market read routes to tag 44 directly", async () => {
    // M-3: the close now reads the market fresh (it needs a_side / epoch for the effective
    // quantity), so a lagging poll no longer sends a doomed matcher close first.
    slabRaw = MARKET;
    chainMarket = F3_MARKET;
    tradeMock.mockRejectedValue(new Error(`Program ${PROGRAM.toBase58()} failed: custom program error: 0x15`));
    const { result } = renderHook(() => useClosePosition(SLAB));
    await act(async () => {
      await result.current.closePosition(50);
    });
    expect(tradeMock).not.toHaveBeenCalled();
    expect(rebalanceMock).toHaveBeenCalledTimes(1);
    expect((rebalanceMock.mock.calls[0][0] as Record<string, unknown>).reduceQ).toBe(11_368_478n);
  });

  it("healthy market, a 21 that is not the ADL state => the original error, no tag 44", async () => {
    slabRaw = MARKET;
    chainMarket = MARKET;
    tradeMock.mockRejectedValue(new Error(`Program ${PROGRAM.toBase58()} failed: custom program error: 0x15`));
    const { result } = renderHook(() => useClosePosition(SLAB));
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.closePosition(100);
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(rebalanceMock).not.toHaveBeenCalled();
  });

  it("tag 44 partial (capacity-limited) => resolves with the partial reason", async () => {
    slabRaw = F3_MARKET;
    chainMarket = F3_MARKET;
    rebalanceMock.mockResolvedValueOnce({ signature: "SIG44b", fill: { kind: "partial", filledQ: -5_000_000n } });
    const { result } = renderHook(() => useClosePosition(SLAB));
    await act(async () => {
      await result.current.closePosition(100);
    });
    expect(result.current.error).toMatch(/reduce-only after a bankruptcy/);
  });
});
