// @vitest-environment node
/**
 * Tag 39 (ResolveStalePermissionless) in the app: wire, status from market bytes, copy. The market is REAL devnet account data:
 * CHILLHOUSE-T 56pWj8zY… (v2.2 wrapper 6kpg2wi7), read 2026-10-17 at slot 512136545 while the v2.2 keeper was down, so it is
 * past the 18,000-slot window. With SDK_V22_DIST=<dir of the built SDK candidate> the same results are recomputed by the SDK.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  STALE_SETTLE_COPY,
  buildResolveStalePermissionlessIxV22,
  encodeResolveStalePermissionlessV22,
  showStaleSettle,
  staleMinutes,
  staleResolveRefusalCopy,
  staleResolveStatusV22,
} from "@/lib/v22/stale-resolve";
import { resolveMarketGeometry } from "@/lib/v22/sdk/layout";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const MARKET = new PublicKey("56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y");
const raw = (): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));
const SNAPSHOT_SLOT = 512_136_545n;

describe("encode / build", () => {
  it("is [39, now_slot u64 LE], 9 bytes, one writable non-signer account", () => {
    const d = encodeResolveStalePermissionlessV22(512_136_545n);
    expect(Array.from(d)).toEqual([39, 0x61, 0x95, 0x86, 0x1e, 0, 0, 0, 0]);
    const ix = buildResolveStalePermissionlessIxV22(WRAPPER, MARKET, 7n);
    expect(ix.programId.equals(WRAPPER)).toBe(true);
    expect(ix.keys).toEqual([{ pubkey: MARKET, isSigner: false, isWritable: true }]);
    expect(ix.data.length).toBe(9);
  });
  it("refuses a slot that is not a u64", () => {
    expect(() => encodeResolveStalePermissionlessV22(-1n)).toThrow();
    expect(() => encodeResolveStalePermissionlessV22(1n << 64n)).toThrow();
    expect(() => encodeResolveStalePermissionlessV22(1.5)).toThrow();
  });
});

describe("status from the market bytes (CHILLHOUSE-T)", () => {
  const m = raw();
  const live = staleResolveStatusV22(m, SNAPSHOT_SLOT)!;
  it("reads the stale window and the last good slot from the account", () => {
    expect(live.staleSlots).toBe(18_000n);
    expect(live.lastGoodOracleSlot).toBeGreaterThan(511_000_000n);
    expect(live.lastGoodOracleSlot).toBeLessThan(SNAPSHOT_SLOT);
    expect(live.mode).toBe(0);
  });
  it("matured at the snapshot (keeper down): canResolve, no refusal", () => {
    expect(live.canResolve).toBe(true);
    expect(live.refusalCode).toBeNull();
    expect(showStaleSettle(live)).toBe(true);
    expect(live.ageSlots).toBeGreaterThanOrEqual(18_000n);
  });
  it("edge: one slot short of the window refuses 27 and shows nothing; exactly on it passes", () => {
    const at = live.lastGoodOracleSlot + 18_000n;
    const short = staleResolveStatusV22(m, at - 1n)!;
    expect(short.refusalCode).toBe(27);
    expect(short.slotsRemaining).toBe(1n);
    expect(showStaleSettle(short)).toBe(false);
    const on = staleResolveStatusV22(m, at)!;
    expect(on.canResolve).toBe(true);
    expect(on.slotsRemaining).toBe(0n);
  });
  it("a fresh price (cluster right after the last good slot) is never shown", () => {
    expect(showStaleSettle(staleResolveStatusV22(m, live.lastGoodOracleSlot + 150n))).toBe(false);
  });
  it("an already-resolved market (mode != Live) refuses 21 and is not shown", () => {
    const g = resolveMarketGeometry(m, { parser: "t", strictLength: false });
    const resolved = new Uint8Array(m);
    resolved[g.groupOff + g.layout.group.mode] = 1;
    const s = staleResolveStatusV22(resolved, SNAPSHOT_SLOT)!;
    expect(s.refusalCode).toBe(21);
    expect(showStaleSettle(s)).toBe(false);
  });
  it("a cluster behind the market's own slot refuses 19", () => {
    const g = resolveMarketGeometry(m, { parser: "t", strictLength: false });
    const ahead = new Uint8Array(m);
    new DataView(ahead.buffer).setBigUint64(g.groupOff + g.layout.group.currentSlot, SNAPSHOT_SLOT + 1000n, true);
    expect(staleResolveStatusV22(ahead, SNAPSHOT_SLOT)!.refusalCode).toBe(19);
  });
  it("window 0 means permissionless resolve is off: never shown", () => {
    // config offset 16 + 136 (permissionless_resolve_stale_slots)
    const off = new Uint8Array(m);
    new DataView(off.buffer).setBigUint64(16 + 136, 0n, true);
    const s = staleResolveStatusV22(off, SNAPSHOT_SLOT)!;
    expect(s.maturesAtSlot).toBeNull();
    expect(s.refusalCode).toBe(27);
    expect(showStaleSettle(s)).toBe(false);
  });
  it("claims nothing about bytes that are not a v2.2 market, or an unknown cluster slot", () => {
    expect(staleResolveStatusV22(null, SNAPSHOT_SLOT)).toBeNull();
    expect(staleResolveStatusV22(new Uint8Array(100), SNAPSHOT_SLOT)).toBeNull();
    expect(staleResolveStatusV22(m, null)).toBeNull();
    const foreign = new Uint8Array(m);
    foreign[8] = 0x7f;
    expect(staleResolveStatusV22(foreign, SNAPSHOT_SLOT)).toBeNull();
  });
  // Golden vectors produced by the SDK candidate itself (percolator-sdk a18c199 `staleResolveStatusV22`) on these exact bytes: always asserted,
  // no environment needed (a silently skipped cross-check proves nothing).
  const SDK_GOLDEN = [
    { offset: 122029n, canResolve: true, refusalCode: null, slotsRemaining: 0n },
    { offset: 17999n, canResolve: false, refusalCode: 27, slotsRemaining: 1n },
    { offset: 18000n, canResolve: true, refusalCode: null, slotsRemaining: 0n },
    { offset: 5n, canResolve: false, refusalCode: 27, slotsRemaining: 17995n },
    { offset: 0n, canResolve: false, refusalCode: 27, slotsRemaining: 18000n },
  ] as const;
  it("equals the SDK candidate's results on the same bytes (golden vectors from the SDK, incl. the exact edge)", () => {
    expect(live.lastGoodOracleSlot).toBe(512_014_516n);
    for (const g of SDK_GOLDEN) {
      const a = staleResolveStatusV22(m, live.lastGoodOracleSlot + g.offset)!;
      expect({ c: a.canResolve, r: a.refusalCode, n: a.slotsRemaining, s: a.staleSlots }).toEqual({ c: g.canResolve, r: g.refusalCode, n: g.slotsRemaining, s: 18_000n });
    }
    // and the wire: [39, 512136545 u64 LE]
    expect(Buffer.from(encodeResolveStalePermissionlessV22(SNAPSHOT_SLOT)).toString("hex")).toBe("276195861e00000000");
  });

  // With the built SDK on hand, recompute everything live too (visible skip, never silent).
  it.skipIf(!process.env.SDK_V22_DIST || !existsSync(`${process.env.SDK_V22_DIST}/dist/index.js`))("and recomputed live by the SDK dist (SDK_V22_DIST)", async () => {
    const sdk = (await import(/* @vite-ignore */ `${process.env.SDK_V22_DIST}/dist/index.js`)) as {
      staleResolveStatusV22: (d: Uint8Array, s: bigint) => { canResolve: boolean; refusalCode: number | null; staleSlots: bigint; lastGoodOracleSlot: bigint; slotsRemaining: bigint | null };
      encodeResolveStalePermissionless: (s: bigint) => Uint8Array;
    };
    for (const slot of [SNAPSHOT_SLOT, live.lastGoodOracleSlot + 17_999n, live.lastGoodOracleSlot + 18_000n, live.lastGoodOracleSlot + 5n]) {
      const a = staleResolveStatusV22(m, slot)!;
      const b = sdk.staleResolveStatusV22(m, slot);
      expect({ c: a.canResolve, r: a.refusalCode, s: a.staleSlots, l: a.lastGoodOracleSlot, n: a.slotsRemaining }).toEqual({ c: b.canResolve, r: b.refusalCode, s: b.staleSlots, l: b.lastGoodOracleSlot, n: b.slotsRemaining });
    }
    expect(Buffer.from(encodeResolveStalePermissionlessV22(SNAPSHOT_SLOT)).equals(Buffer.from(sdk.encodeResolveStalePermissionless(SNAPSHOT_SLOT)))).toBe(true);
  });
});

describe("copy", () => {
  it("the line names the minutes and offers the way out; whole minutes, rounded down", () => {
    expect(staleMinutes(18_000n)).toBe(120);
    expect(staleMinutes(18_149n)).toBe(120);
    expect(STALE_SETTLE_COPY.line(120)).toBe("This market has had no price for over 120 minutes and can be settled. Settle it to get your funds back.");
  });
  it("refusals 21 / 19 / 27 each get a calm line; other codes get none (the generic line applies)", () => {
    expect(staleResolveRefusalCopy(27)).toBe(STALE_SETTLE_COPY.notYet);
    expect(staleResolveRefusalCopy(19)).toBe(STALE_SETTLE_COPY.behind);
    expect(staleResolveRefusalCopy(21)).toBe(STALE_SETTLE_COPY.alreadySettled);
    expect(staleResolveRefusalCopy(99)).toBeNull();
    for (const c of Object.values(STALE_SETTLE_COPY)) {
      if (typeof c === "string") expect(c).not.toMatch(/slot|tag|Custom|oracle|CloseResolved|portfolio|0x/i);
    }
  });
});
