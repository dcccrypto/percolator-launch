/**
 * rc23 (src/fill_events_v22.rs, 77b4060c) emits three REDUCE reasons the vendored parser skipped as "unknown-reduce-reason":
 * 6 FORCE_CLOSE_ABANDONED, 7 RESOLVED_CLOSE, 8 LP_STOP (the W1 cut, tag 124 op 5). A trader cut by any of them got no record.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { REDUCE_REASON_V22, decodeWrapperEventV22 } from "@/lib/v22/sdk";
import { REDUCE_NOTICE_COPY, reduceNoticeCopy } from "@/lib/v22/reduce-copy";

const MARKET = new PublicKey(new Uint8Array(32).fill(5));
const PF = new PublicKey(new Uint8Array(32).fill(6));
function reduceBytes(reason: number, signedQ = -250n): Uint8Array {
  const b = Buffer.alloc(134);
  b[0] = 2; b[1] = 1; b[2] = 124;
  MARKET.toBuffer().copy(b, 3);
  PF.toBuffer().copy(b, 35);
  b.writeUInt16LE(0, 99);
  b[109] = reason;
  b.writeBigUInt64LE(signedQ & 0xffffffffffffffffn, 110);
  b.writeBigInt64LE(signedQ >> 64n, 118);
  b.writeBigUInt64LE(42_000_000n, 126);
  return new Uint8Array(b);
}

describe("REDUCE reasons 6, 7 and 8", () => {
  it("names match the program and the SDK", () => {
    expect(REDUCE_REASON_V22).toMatchObject({ FORCE_CLOSE_ABANDONED: 6, RESOLVED_CLOSE: 7, LP_STOP: 8 });
  });
  it.each([6, 7, 8])("reason %i decodes (it was skipped as unknown-reduce-reason)", (reason) => {
    const r = decodeWrapperEventV22(reduceBytes(reason));
    expect("event" in r).toBe(true);
    if ("event" in r && r.event.kind === "reduce") {
      expect(r.event.reason).toBe(reason);
      expect(r.event.signedReducedQ).toBe(-250n);
      expect(r.event.priceE6).toBe(42_000_000n);
      expect(r.event.portfolio.equals(PF)).toBe(true);
    }
  });
  it("CONTROL: reasons 1..5 still decode; 0 and 9 are still skipped", () => {
    for (const reason of [1, 2, 3, 4, 5]) expect("event" in decodeWrapperEventV22(reduceBytes(reason))).toBe(true);
    for (const reason of [0, 9, 255]) expect(decodeWrapperEventV22(reduceBytes(reason))).toEqual({ skip: "unknown-reduce-reason" });
  });
});

describe("a plain line for each reduction reason", () => {
  it("the stop cut says what happened and at what price, in plain words", () => {
    const t = reduceNoticeCopy(8)!;
    expect(t.title).toBe("Position reduced");
    expect(t.body).toBe("This market's liquidity hit its stop-loss, so positions on the winning side were cut at the market price. Each was cut by the same share, except a position that would be left below the market's minimum size, which was closed entirely.");
    expect(t.body).not.toMatch(/same percentage/);
  });
  it("every reason the parser knows has a line, and none uses engineering terms", () => {
    for (const reason of Object.values(REDUCE_REASON_V22)) {
      const t = reduceNoticeCopy(reason);
      expect(t, `reason ${reason}`).not.toBeNull();
      expect(`${t!.title} ${t!.body}`).not.toMatch(/\b(LP|bps|ADL|K-index|cranker|keeper|slab|PDA)\b/i);
    }
    expect(Object.keys(REDUCE_NOTICE_COPY).length).toBe(Object.values(REDUCE_REASON_V22).length);
  });
  it("an unknown reason has no line", () => {
    expect(reduceNoticeCopy(9)).toBeNull();
  });
});
