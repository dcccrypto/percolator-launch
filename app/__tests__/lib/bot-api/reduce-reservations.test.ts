// @vitest-environment node
/** In-flight reduce-only reservations (lib/bot-api/reduce-reservations.ts): sizing, TTL expiry, release, attach. */
import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/lib/bot-api/kv";
import { ApiError } from "@/lib/bot-api/errors";
import { RESERVATION_TTL_SEC, releaseByMessageHash, reservationFor, reserveReduce, reservedReduce } from "@/lib/bot-api/reduce-reservations";

const P = { owner: "owner1", market: "market1", account: "acct1" };
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("reduce-only reservations", () => {
  it("long 10: 6 then 6 refused (remaining 4); 6 then 4 fit", async () => {
    const c = clock();
    const kv = new MemoryKv(c.now);
    const a = await reserveReduce(P, 10n, 6n, kv, c.now);
    await a.attach(H1, 500);
    const e = await reserveReduce(P, 10n, 6n, kv, c.now).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("reduce_only_inflight");
    expect((e as ApiError).extra.details).toMatchObject({ positionQ: "10", reservedQ: "6", remainingQ: "4", sizeQ: "6" });
    await reserveReduce(P, 10n, 4n, kv, c.now);
    expect(await reservedReduce(P, kv, c.now())).toBe(10n);
  });
  it("positions are separate per owner, market and account", async () => {
    const c = clock();
    const kv = new MemoryKv(c.now);
    await reserveReduce(P, 10n, 10n, kv, c.now);
    await expect(reserveReduce({ ...P, account: "acct2" }, 10n, 10n, kv, c.now)).resolves.toBeDefined();
    await expect(reserveReduce({ ...P, market: "m2" }, 10n, 10n, kv, c.now)).resolves.toBeDefined();
  });
  it("an attached reservation expires after the TTL (longer than a blockhash lives), then the size is free again", async () => {
    const c = clock();
    const kv = new MemoryKv(c.now);
    await (await reserveReduce(P, 10n, 6n, kv, c.now)).attach(H1, 500);
    c.advance(RESERVATION_TTL_SEC * 1000 - 1);
    await expect(reserveReduce(P, 10n, 6n, kv, c.now)).rejects.toMatchObject({ code: "reduce_only_inflight" });
    c.advance(2);
    expect(await reservedReduce(P, kv, c.now())).toBe(0n);
    await expect(reserveReduce(P, 10n, 6n, kv, c.now)).resolves.toBeDefined();
  });
  it("release (failed build) and releaseByMessageHash (cancel, landed) free the size", async () => {
    const c = clock();
    const kv = new MemoryKv(c.now);
    const a = await reserveReduce(P, 10n, 6n, kv, c.now);
    await a.release();
    expect(await reservedReduce(P, kv, c.now())).toBe(0n);
    await (await reserveReduce(P, 10n, 6n, kv, c.now)).attach(H2, 777);
    expect(await reservationFor(H2, kv, c.now())).toMatchObject({ position: P, entry: { q: "6", lvbh: 777 } });
    expect(await releaseByMessageHash(H2, kv, c.now())).toBe(true);
    expect(await releaseByMessageHash(H2, kv, c.now())).toBe(false);
    expect(await reservedReduce(P, kv, c.now())).toBe(0n);
  });
  it("concurrent reserves for one position are serialised: only one of two 6s fits a 10", async () => {
    const kv = new MemoryKv();
    const rs = await Promise.allSettled([reserveReduce(P, 10n, 6n, kv), reserveReduce(P, 10n, 6n, kv)]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
