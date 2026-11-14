// @vitest-environment node
/**
 * risk F1: close and reduce-only are sized from the ADL-EFFECTIVE position (the quantity the engine applies a trade to),
 * not the leg's raw basis. Real devnet SOL market + its LP portfolio (a short, basis -555540, a_basis = ADL_ONE); the
 * market bytes are patched to ADL-scale the short side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicKey, Connection } from "@solana/web3.js";

const seen = vi.hoisted(() => ({ reqs: [] as Array<{ size: bigint }> }));
vi.mock("@/lib/v22/trade-build", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-build")>()),
  buildV22Trade: vi.fn(async (_c: unknown, req: { size: bigint }) => {
    seen.reqs.push(req);
    throw new (await import("@/lib/bot-api/errors")).ApiError("rpc_unavailable");
  }),
}));

import { effectiveTakerPosition } from "@/lib/v22/trade-build";
import { buildClose } from "@/lib/bot-api/builders/order";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { A_A_SHORT, A_EPOCH_SHORT, A_MODE_SHORT } from "@/lib/limits/constants";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { SOL, SOL_DATA, LP, LP_DATA, WRAPPER, pk } from "./fake-chain";

const ADL_ONE = 1_000_000_000_000_000n;
const OWNER = pk(9);

/** SOL market bytes with the short side's `a`, epoch and mode patched. */
function market(o: { aShort?: bigint; epochShort?: bigint; modeShort?: number } = {}): Uint8Array {
  const d = new Uint8Array(SOL_DATA);
  const e = marketOffsets(d, "test").engineOff(0);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (o.aShort !== undefined) {
    v.setBigUint64(e + A_A_SHORT, o.aShort & ((1n << 64n) - 1n), true);
    v.setBigUint64(e + A_A_SHORT + 8, o.aShort >> 64n, true);
  }
  if (o.epochShort !== undefined) v.setBigUint64(e + A_EPOCH_SHORT, o.epochShort, true);
  if (o.modeShort !== undefined) d[e + A_MODE_SHORT] = o.modeShort;
  return d;
}

const conn = (m: Uint8Array) =>
  ({
    getAccountInfo: async (k: PublicKey) => {
      if (k.equals(SOL)) return { owner: WRAPPER, data: Buffer.from(m), lamports: 1, executable: false };
      if (k.equals(LP)) return { owner: WRAPPER, data: LP_DATA, lamports: 1, executable: false };
      return null;
    },
  }) as unknown as Connection;
const meta = () => ({ rpcCalls: 0, sims: 0 });
const closeBody = (extra: Record<string, unknown> = {}) => ({ owner: OWNER.toBase58(), market: SOL.toBase58(), portfolio: LP.toBase58(), ...extra });
const pfBytes = new Uint8Array(LP_DATA);

beforeEach(() => {
  __setDevnetV22ForTest(true);
  seen.reqs = [];
});
afterEach(() => __setDevnetV22ForTest(null));

describe("effectiveTakerPosition", () => {
  it("equals the raw basis when the side has not been ADL-scaled", () => {
    expect(effectiveTakerPosition(pfBytes, decodeMarketEngineView(market()))).toEqual({ q: -555_540n, reset: false });
  });
  it("scales by the side's a / a_basis, rounding up like the engine", () => {
    const e = decodeMarketEngineView(market({ aShort: (ADL_ONE * 9n) / 10n }));
    expect(e!.aShort).toBe((ADL_ONE * 9n) / 10n);
    expect(effectiveTakerPosition(pfBytes, e)).toEqual({ q: -499_986n, reset: false }); // ceil(555540 x 0.9)
  });
  it("a prior-reset leg owns nothing; a leg from any other epoch is unreadable; an undecodable engine is unreadable", () => {
    expect(effectiveTakerPosition(pfBytes, decodeMarketEngineView(market({ epochShort: 1n, modeShort: 2 })))).toEqual({ q: 0n, reset: true });
    expect(effectiveTakerPosition(pfBytes, decodeMarketEngineView(market({ epochShort: 5n, modeShort: 0 }))).q).toBeNull();
    expect(effectiveTakerPosition(pfBytes, null).q).toBeNull();
  });
});

describe("POST /v1/positions/close sizing", () => {
  it("closes the ADL-effective quantity, not the raw basis", async () => {
    await expect(buildClose(conn(market({ aShort: (ADL_ONE * 9n) / 10n })), closeBody(), meta())).rejects.toMatchObject({ code: "rpc_unavailable" });
    expect(seen.reqs[0].size).toBe(499_986n); // buy back what the engine says is open; raw would be 555540
  });
  it("without ADL it is the raw basis (same number)", async () => {
    await expect(buildClose(conn(market()), closeBody(), meta())).rejects.toMatchObject({ code: "rpc_unavailable" });
    expect(seen.reqs[0].size).toBe(555_540n);
  });
  it("a partial close above the effective position is refused even when it is below the raw basis", async () => {
    await expect(buildClose(conn(market({ aShort: (ADL_ONE * 9n) / 10n })), closeBody({ size: "520000" }), meta())).rejects.toMatchObject({ code: "reduce_only_violation" });
    expect(seen.reqs).toHaveLength(0);
  });
  it("a prior-reset leg is no_position; an invalid leg is market_unreadable", async () => {
    await expect(buildClose(conn(market({ epochShort: 1n, modeShort: 2 })), closeBody(), meta())).rejects.toMatchObject({ code: "no_position" });
    await expect(buildClose(conn(market({ epochShort: 5n })), closeBody(), meta())).rejects.toMatchObject({ code: "market_unreadable" });
    expect(seen.reqs).toHaveLength(0);
  });
});
