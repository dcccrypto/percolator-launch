import { describe, it, expect, beforeEach } from "vitest";
import {
  loadNotices,
  loadSnapshot,
  MAX_SNAPSHOT_AGE_MS,
  decideMissing,
  saveNotices,
  saveSnapshot,
  seenFromPositions,
  tradedSince,
  vanishedSince,
  type PositionLike,
} from "@/lib/closed-positions";
import { checkTrades } from "@/hooks/useClosedPositionNotices";
import { noticeCopy } from "@/components/layout/ClosedPositionNotice";

const WALLET = "DYvC67UeMeKkLiufhHxpAH8eyso3ZmPD3Y2jTo6PXZbf";
const OTHER = "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7";
const SLAB = "EEEmo3dBS121szmBziftTEoYJWkKUFnusXkB3ZhyqmrN";
const pk = (s: string) => ({ toBase58: () => s });

function pos(over: Partial<PositionLike> & { size?: bigint; owner?: string } = {}): PositionLike {
  return {
    slabAddress: SLAB,
    symbol: "BATON",
    idx: 3,
    oraclePriceE6: 14_900n,
    liquidationPriceE6: 16_100n,
    account: { positionSize: over.size ?? -1_000_000n, owner: pk(over.owner ?? WALLET) },
    ...over,
  };
}

describe("seenFromPositions", () => {
  it("remembers the wallet's own open, unwrapped positions with side and size", () => {
    const seen = seenFromPositions([pos()], WALLET);
    const k = `${SLAB}:3`;
    expect(Object.keys(seen)).toEqual([k]);
    expect(seen[k]).toMatchObject({ side: "short", sizeAbs: "1000000", symbol: "BATON", liqPriceE6: "16100" });
  });

  it("ignores flat, NFT-wrapped and other wallets' positions", () => {
    const seen = seenFromPositions(
      [pos({ size: 0n }), pos({ idx: 4, nftWrapped: true }), pos({ idx: 5, owner: OTHER })],
      WALLET,
    );
    expect(seen).toEqual({});
  });
});

describe("vanishedSince", () => {
  it("returns remembered positions that are no longer open, and only those", () => {
    const a = seenFromPositions([pos()], WALLET);
    const b = seenFromPositions([pos({ idx: 9 })], WALLET);
    const prev = { v: 1 as const, savedAt: 1_000, positions: { ...a, ...b } };
    expect(vanishedSince(prev, b).map((p) => p.key)).toEqual([`${SLAB}:3`]);
    expect(vanishedSince(prev, { ...a, ...b })).toEqual([]);
  });
});

describe("tradedSince", () => {
  const t = (iso: string, slab = SLAB) => ({ slab_address: slab, created_at: iso });
  it("counts a trade on the market after the snapshot (within skew)", () => {
    const since = Date.parse("2026-10-10T00:00:00Z");
    expect(tradedSince([t("2026-10-10T00:05:00Z")], SLAB, since)).toBe(true);
    expect(tradedSince([t("2026-10-09T23:59:00Z")], SLAB, since)).toBe(true); // within 2 min skew
  });
  it("ignores older trades and other markets", () => {
    const since = Date.parse("2026-10-10T00:00:00Z");
    expect(tradedSince([t("2026-10-09T16:11:38Z")], SLAB, since)).toBe(false);
    expect(tradedSince([t("2026-10-10T00:05:00Z", OTHER)], SLAB, since)).toBe(false);
  });
});

describe("checkTrades", () => {
  const since = Date.parse("2026-10-10T00:00:00Z");
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("no trade since it was last seen -> no-trade (the protocol closed it)", async () => {
    const r = await checkTrades(WALLET, SLAB, since, respond(200, { trades: [{ slab_address: SLAB, created_at: "2026-10-09T16:11:38Z" }], total: 1 }));
    expect(r).toBe("no-trade");
  });
  it("a trade since -> user-traded (they closed it themselves, maybe on another device)", async () => {
    const r = await checkTrades(WALLET, SLAB, since, respond(200, { trades: [{ slab_address: SLAB, created_at: "2026-10-10T01:00:00Z" }], total: 2 }));
    expect(r).toBe("user-traded");
  });
  it("no indexed trades at all, an error, or a bad body -> unknown (never a false notice)", async () => {
    expect(await checkTrades(WALLET, SLAB, since, respond(200, { trades: [], total: 0 }))).toBe("unknown");
    expect(await checkTrades(WALLET, SLAB, since, respond(503, {}))).toBe("unknown");
    expect(await checkTrades(WALLET, SLAB, since, respond(200, { nope: true }))).toBe("unknown");
    expect(await checkTrades(WALLET, SLAB, since, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe("unknown");
  });
});

describe("storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a snapshot and notices per wallet", () => {
    const seen = seenFromPositions([pos()], WALLET);
    saveSnapshot(WALLET, seen, 5_000);
    expect(loadSnapshot(WALLET, 6_000)?.positions).toEqual(seen);
    expect(loadSnapshot(OTHER, 6_000)).toBeNull();
    const n = { ...seen[`${SLAB}:3`], lastSeenAt: 5_000, detectedAt: 6_000 };
    saveNotices(WALLET, [n]);
    expect(loadNotices(WALLET)).toEqual([n]);
    expect(loadNotices(OTHER)).toEqual([]);
  });

  it("drops a snapshot too old to explain anything, and survives garbage", () => {
    saveSnapshot(WALLET, {}, 0);
    expect(loadSnapshot(WALLET, MAX_SNAPSHOT_AGE_MS + 1)).toBeNull();
    localStorage.setItem(`pco-closed-notices:v1:${WALLET}`, "{not json");
    expect(loadNotices(WALLET)).toEqual([]);
  });
});

describe("noticeCopy", () => {
  it("names the market and side, says it was likely liquidated, and where leftover margin is", () => {
    const seen = seenFromPositions([pos()], WALLET)[`${SLAB}:3`];
    const c = noticeCopy({ ...seen, lastSeenAt: 0, detectedAt: 0 }, 3 * 3_600_000);
    expect(c.title).toBe("Your BATON short was closed");
    expect(c.body).toContain("3 h ago");
    expect(c.body).toContain("most likely a liquidation");
    expect(c.body).toContain("Withdraw tab");
    expect(c.body).toContain("$0.016100");
  });
});

describe("decideMissing", () => {
  const M = 60_000;
  it("drops a position the trader closed themselves", () => {
    expect(decideMissing("user-traded", { lastOpenAt: 0, missingSince: 0 }, 10 * M)).toBe("drop");
  });
  it("waits while the trader's own close could still be on its way to the indexer", () => {
    // seen open 1 min ago, missing for 30 s
    expect(decideMissing("no-trade", { lastOpenAt: 9 * M, missingSince: 9.5 * M }, 10 * M)).toBe("wait");
    // missing long enough, but last seen open only 2 min ago
    expect(decideMissing("no-trade", { lastOpenAt: 8 * M, missingSince: 8 * M }, 10 * M)).toBe("wait");
  });
  it("notices a protocol close once enough time has passed (e.g. coming back after a day)", () => {
    expect(decideMissing("no-trade", { lastOpenAt: 0, missingSince: 10 * M - M }, 10 * M)).toBe("notice");
    expect(decideMissing("no-trade", { lastOpenAt: 0, missingSince: 24 * 60 * M }, 24 * 60 * M + 30_000)).toBe("wait");
  });
  it("never notices on an unknown answer; gives up after a long wait", () => {
    expect(decideMissing("unknown", { lastOpenAt: 0, missingSince: 0 }, 5 * M)).toBe("wait");
    expect(decideMissing("unknown", { lastOpenAt: 0, missingSince: 0 }, 31 * M)).toBe("drop");
  });
});
