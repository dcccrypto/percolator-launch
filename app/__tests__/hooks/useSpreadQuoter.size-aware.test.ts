/**
 * Review of #3820 (HIGH 1): the hook itself builds the ext-v3 caps from the real market + LP bytes and quotes the order's size. Real-shaped
 * bytes (v22-spread-size-aware-sol.json); only the RPC and the LP resolution are mocked.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/v22-spread-size-aware-sol.json";

const mocks = vi.hoisted(() => ({ resolveLp: vi.fn(), getMultiple: vi.fn(), getSlot: vi.fn() }));
const MARKET = fixture.market;
const PROG = new PublicKey("5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe");
const connection = { getMultipleAccountsInfo: mocks.getMultiple, getSlot: mocks.getSlot };
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ slabAddress: MARKET, programId: PROG }) }));
vi.mock("@/hooks/useTrade", () => ({ resolveLpTradeAccounts: mocks.resolveLp }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));

import { useSpreadQuoter } from "@/hooks/useSpreadQuoter";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const b = (s: string) => ({ data: Buffer.from(s, "base64") });
const PX = BigInt(fixture.oracle.priceE6);
const q = (usd: number) => BigInt(Math.round((usd / (Number(PX) / 1e6)) * 1e6));

describe("useSpreadQuoter on real market bytes", () => {
  beforeEach(() => {
    __setDevnetV22ForTest(true);
    mocks.resolveLp.mockResolvedValue({ matcherCtx: new PublicKey(fixture.ctx), accountB: new PublicKey(fixture.lp) });
    mocks.getSlot.mockResolvedValue(Number(fixture.oracle.slot));
  });
  afterEach(() => { __setDevnetV22ForTest(null); vi.clearAllMocks(); });

  it("quotes the ORDER'S size from the wrapper's capital-derived depth: 24 / 30 / 38 bps at $100 / $650 / $1,255 (the context alone says 23)", async () => {
    mocks.getMultiple.mockResolvedValue([b(fixture.marketB64), b(fixture.ctxB64), b(fixture.lpB64)]);
    const { result } = renderHook(() => useSpreadQuoter(true, 0, 0));
    await waitFor(() => expect(result.current(q(100), true)).not.toBeNull());
    const bps = (usd: number, reducing = false) => { const e = result.current(q(usd), true, reducing)!; return e.kind === "quote" ? e.bps : -1; };
    expect(bps(100)).toBe(24);
    expect(bps(650)).toBe(30);
    expect(bps(1255)).toBe(38);
    expect(result.current.unavailable).toBe(false);
    // the reduce flag reaches the matcher math: a reduce-only $2,000 is 52, the same order not reducing is 39 (clipped at the LP's room)
    expect(bps(2000, true)).toBe(52);
    expect(bps(2000, false)).toBe(39);
    // it asked for the LP portfolio too (3 accounts) and the slot
    expect(mocks.getMultiple.mock.calls[0][0]).toHaveLength(3);
    expect(mocks.getSlot).toHaveBeenCalled();
  });

  it("a growth asset whose caps cannot be rebuilt (LP bytes unreadable) is UNAVAILABLE, never a context-depth quote", async () => {
    mocks.getMultiple.mockResolvedValue([b(fixture.marketB64), b(fixture.ctxB64), { data: Buffer.alloc(16) }]);
    const { result } = renderHook(() => useSpreadQuoter(true, 0, 0));
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current(q(1255), true)).toBeNull();
  });
});
