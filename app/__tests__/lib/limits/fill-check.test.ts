// @vitest-environment node
/**
 * P1 zero-fill coupling: after confirm, the MEASURED position delta decides
 * what the ticket shows. The post-trade read must be pinned to the tx's slot
 * (minContextSlot) so the /api/rpc cache can't return pre-trade bytes.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { measureFill, recordFillResult, takeFillResult } from "@/lib/limits/fill-check";
import * as C from "@/lib/limits/constants";
import { blankPortfolio } from "../../helpers/v22-fixtures";


function portfolioWithPosition(q: bigint, marketId = 1n): Uint8Array {
  const d = new Uint8Array(blankPortfolio()); // v2.2 (VERSION 19, 10,603 B); the leg fields used here do not move from v2.1
  const dv = new DataView(d.buffer);
  const l = C.PF_LEGS;
  if (q !== 0n) {
    d[l + C.LEG_ACTIVE] = 1;
    dv.setUint32(l + C.LEG_ASSET_INDEX, 0, true);
    dv.setBigUint64(l + C.LEG_MARKET_ID, marketId, true);
    d[l + C.LEG_SIDE] = q > 0n ? 0 : 1;
    const mag = q < 0n ? -q : q;
    dv.setBigUint64(l + C.LEG_BASIS_POS_Q, mag & 0xffff_ffff_ffff_ffffn, true);
    dv.setBigUint64(l + C.LEG_BASIS_POS_Q + 8, mag >> 64n, true);
  }
  return d;
}

function conn(afterQ: bigint | null, slot: number | null) {
  const getAccountInfo = vi.fn(async () => (afterQ === null ? null : { data: Buffer.from(portfolioWithPosition(afterQ)) }));
  const getSignatureStatuses = vi.fn(async () => ({ value: [slot === null ? null : { slot }] }));
  return { c: { getAccountInfo, getSignatureStatuses } as unknown as Connection, getAccountInfo };
}

const PF = Keypair.generate().publicKey;

describe("measureFill", () => {
  it("ZERO fill: confirmed tx, position unchanged", async () => {
    const { c } = conn(0n, 123);
    expect(await measureFill(c, PF, "sig", 0n, 100n, 1n)).toEqual({ kind: "zero", filledQ: 0n });
  });
  it("partial and full fills", async () => {
    expect(await measureFill(conn(40n, 1).c, PF, "s", 0n, 100n, 1n)).toEqual({ kind: "partial", filledQ: 40n });
    expect(await measureFill(conn(100n, 1).c, PF, "s", 0n, 100n, 1n)).toEqual({ kind: "full", filledQ: 100n });
  });
  it("pins the read to the tx slot (minContextSlot) at confirmed commitment", async () => {
    const { c, getAccountInfo } = conn(100n, 777);
    await measureFill(c, PF, "s", 0n, 100n, 1n);
    expect(getAccountInfo).toHaveBeenCalledWith(PF, { commitment: "confirmed", minContextSlot: 777 });
  });
  it("unknown (never assumes the requested size) when the slot or account is missing, or before is unknown", async () => {
    expect((await measureFill(conn(100n, null).c, PF, "s", 0n, 100n, 1n)).kind).toBe("unknown");
    expect((await measureFill(conn(null, 5).c, PF, "s", 0n, 100n, 1n)).kind).toBe("unknown");
    expect((await measureFill(conn(100n, 5).c, PF, "s", null, 100n, 1n)).kind).toBe("unknown");
  });
  it("registry hands the result to the ticket exactly once", () => {
    recordFillResult("abc", { kind: "zero", filledQ: 0n });
    expect(takeFillResult("abc")).toEqual({ kind: "zero", filledQ: 0n });
    expect(takeFillResult("abc")).toBeNull();
  });
});
