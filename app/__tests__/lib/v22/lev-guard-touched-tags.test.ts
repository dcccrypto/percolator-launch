// @vitest-environment node
/**
 * prog#611 (rc23 77b4060c): the W1 touched set stores 16-byte key prefixes with a cap of 256 (still 4096 B, account lengths
 * 4456 / 4472 unchanged). The vendored decoder read 8-byte tags with a cap of 512: it would have read tag 0 as the lower half of tag 0
 * and tag 1 as its upper half, and accepted touched_n in 257..512 that the program refuses.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  LEV_GUARD_ACCOUNT_LEN_BURST_V22, LEV_GUARD_ACCOUNT_LEN_V22, LEV_GUARD_FIELD_OFF_V22, LEV_GUARD_KEY_TAG_LEN_V22,
  LEV_GUARD_TOUCHED_CAP_V22, LEV_GUARD_TOUCHED_LEN_V22, LEV_GUARD_ACCOUNT_LEN_V2_V22, LEV_GUARD_BODY_LEN_V2_V22, decodeLevGuardV22, levKeyTagV22,
} from "@/lib/v22/sdk";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk/layout";

function synth(len = LEV_GUARD_ACCOUNT_LEN_BURST_V22): Uint8Array {
  const d = new Uint8Array(len);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = 17;
  d[16 + LEV_GUARD_FIELD_OFF_V22.version] = 1;
  return d;
}
const setN = (d: Uint8Array, n: number): void => new DataView(d.buffer).setUint16(16 + LEV_GUARD_FIELD_OFF_V22.touchedN, n, true);

describe("W1 touched set: 16-byte tags, cap 256 (prog#611)", () => {
  it("geometry: 16 x 256 == 4096 and the account lengths did not move", () => {
    expect(LEV_GUARD_KEY_TAG_LEN_V22).toBe(16);
    expect(LEV_GUARD_TOUCHED_CAP_V22).toBe(256);
    expect(LEV_GUARD_TOUCHED_LEN_V22).toBe(4096);
    expect(LEV_GUARD_ACCOUNT_LEN_BURST_V22).toBe(4472);
    expect(LEV_GUARD_ACCOUNT_LEN_V22).toBe(4472 - 16);
  });
  it("accepts touched_n = 256 and refuses 257 (the old cap 512 accepted it)", () => {
    const ok = synth(); setN(ok, 256);
    expect(decodeLevGuardV22(ok).touchedTags).toHaveLength(256);
    const bad = synth(); setN(bad, 257);
    expect(() => decodeLevGuardV22(bad)).toThrow();
  });
  it("reads each tag as 16 bytes at a 16-byte stride, LE", () => {
    const d = synth();
    const t = 16 + 360;
    for (let i = 0; i < 16; i++) { d[t + i] = 0x10 + i; d[t + 16 + i] = 0xa0 + i; }
    setN(d, 2);
    const g = decodeLevGuardV22(d);
    const le = (a: number): bigint => { let x = 0n; for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(a + i); return x; };
    expect(g.touchedTags).toEqual([le(0x10), le(0xa0)]);
  });
  it("the last tag (index 255) is read from the end of the region", () => {
    const d = synth();
    d[d.length - 1] = 0x7f; // top byte of tag 255
    setN(d, 256);
    expect(decodeLevGuardV22(d).touchedTags[255]).toBe(0x7fn << 120n);
  });
  it("levKeyTagV22 separates two keys that share an 8-byte prefix, and is a 16-byte prefix", () => {
    const a = new Uint8Array(32).fill(7); a[8] = 1;
    const b = new Uint8Array(32).fill(7); b[8] = 2;
    expect(levKeyTagV22(new PublicKey(a))).not.toBe(levKeyTagV22(new PublicKey(b)));
    const c = new Uint8Array(32).fill(7); c[16] = 1;
    const e = new Uint8Array(32).fill(7); e[16] = 2;
    expect(levKeyTagV22(new PublicKey(c))).toBe(levKeyTagV22(new PublicKey(e)));
  });
  it("a cut key is found by its tag in a decoded guard (round trip)", () => {
    const key = new PublicKey(new Uint8Array(32).map((_, i) => 0x30 + i));
    const d = synth();
    d.set(key.toBytes().subarray(0, 16), 16 + 360);
    setN(d, 1);
    expect(decodeLevGuardV22(d).touchedTags.includes(levKeyTagV22(key))).toBe(true);
  });
});

// percolator-prog #721 / SDK #491: the v2 guard is a 488 B record (body 4584, account 4600).
describe("v2 guard (4600 B account, prog#721)", () => {
  const v2 = (): Uint8Array => {
    const v1 = synth();
    const d = new Uint8Array(4600);
    d.set(v1.subarray(0, 16 + 360), 0);
    d.set(v1.subarray(16 + 360, 16 + 360 + 4096), 16 + 488);
    d[16 + LEV_GUARD_FIELD_OFF_V22.version] = 2;
    const dv = new DataView(d.buffer);
    for (let i = 0; i < 8; i++) { dv.setBigUint64(16 + 360 + 8 * i, BigInt(2000 + i), true); dv.setBigUint64(16 + 424 + 8 * i, BigInt(500 - i), true); }
    return d;
  };
  it("geometry: body 4584, account 4600", () => {
    expect(LEV_GUARD_BODY_LEN_V2_V22).toBe(4584);
    expect(LEV_GUARD_ACCOUNT_LEN_V2_V22).toBe(4600);
  });
  it("decodes the marks, derives the reference from the oldest mark and reads the touched tags after the 488 B record", () => {
    const d = v2();
    d.set(new Uint8Array(16).fill(0x11), 16 + 488);
    new DataView(d.buffer).setUint16(16 + LEV_GUARD_FIELD_OFF_V22.touchedN, 1, true);
    const g = decodeLevGuardV22(d);
    expect(g.version).toBe(2);
    expect(g.pbMarksPx).toEqual([2000n, 2001n, 2002n, 2003n, 2004n, 2005n, 2006n, 2007n]);
    expect(g.pbMarksSlot[7]).toBe(493n);
    expect(g.pbRefPx).toBe(2007n);
    expect(g.pbRefSlot).toBe(493n);
    expect(g.touchedTags).toEqual([0x11111111111111111111111111111111n]);
  });
  it("refuses a v1 version byte, non-zero _pad4, and lengths 4599 / 4601", () => {
    const d = v2();
    const bad = (f: (x: Uint8Array) => void): Uint8Array => { const c = d.slice(); f(c); return c; };
    expect(() => decodeLevGuardV22(bad((x) => { x[16 + 74] = 1; }))).toThrow();
    expect(() => decodeLevGuardV22(bad((x) => { x[16 + 130] = 1; }))).toThrow();
    expect(() => decodeLevGuardV22(d.slice(0, 4599))).toThrow();
    expect(() => decodeLevGuardV22(new Uint8Array([...d, 0]))).toThrow();
  });
  it("v1 records keep decoding with empty marks (4456 and 4472)", () => {
    for (const len of [4456, 4472]) {
      const g = decodeLevGuardV22(synth(len));
      expect(g.version).toBe(1);
      expect(g.pbMarksPx).toEqual([]);
    }
  });
  it("a v1 version byte on a 4472 B account is still accepted and v2 byte on it refused", () => {
    const d = synth(); d[16 + 74] = 2;
    expect(() => decodeLevGuardV22(d)).toThrow();
  });
});
