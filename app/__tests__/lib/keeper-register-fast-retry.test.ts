/**
 * percolator-indexer#223: what the app controls between "launch finished" and "market listed".
 *  - a 409 ("the creation tx / finished market is not visible to the server's RPC yet") is retried on
 *    a short ladder (1.5 s first, not 5 s); 5xx / 429 / network keep the old, slower schedule;
 *  - a landed registration announces itself so this page's lists refetch past the CDN;
 *  - a resume pass can be limited to the slabs a previous pass left as "try again".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KEEPER_REGISTER_BACKOFF_MS,
  KEEPER_REGISTER_NOT_YET_BACKOFF_MS,
  KEEPER_REGISTER_STEADY_MS,
  MARKET_REGISTERED_EVENT,
  markRegistered,
  postKeeperRegistration,
  resumePendingRegistrations,
  runKeeperRegistration,
  type KeeperRegisterAttempt,
  type KeyStore,
} from "@/lib/keeper-register-client";

const REQ = { slabAddress: "S", dexPoolAddress: "P", proofTx: "sig" };
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

async function waitsFor(statuses: number[]): Promise<number[]> {
  const queue = [...statuses];
  const fetchImpl = vi.fn(async () => {
    const st = queue.shift();
    return st === undefined || st === 200 ? res(200, { registered: true }) : res(st, { error: "x" });
  });
  const waits: number[] = [];
  await runKeeperRegistration({
    attempt: () => postKeeperRegistration(REQ, fetchImpl as unknown as typeof fetch),
    onStatus: () => undefined,
    sleep: async (ms) => { waits.push(ms); },
    maxServerRetries: 99,
  });
  return waits;
}

describe("a 409 (not visible yet) is retried on a short ladder", () => {
  it("409, 409, 409, then registered: waits 1.5, 2.5, 4 s", async () => {
    expect(await waitsFor([409, 409, 409])).toEqual([1_500, 2_500, 4_000]);
  });

  it("the ladder is bounded (about 2.2 minutes), then the ordinary schedule takes over", async () => {
    const n = KEEPER_REGISTER_NOT_YET_BACKOFF_MS.length;
    const waits = await waitsFor(Array<number>(n + 2).fill(409));
    expect(waits.slice(0, n)).toEqual([...KEEPER_REGISTER_NOT_YET_BACKOFF_MS]);
    // attempt index n and n+1 are past the ladder: the standard schedule by attempt number
    expect(waits.slice(n)).toEqual([KEEPER_REGISTER_BACKOFF_MS.length > n ? KEEPER_REGISTER_BACKOFF_MS[n] : KEEPER_REGISTER_STEADY_MS, KEEPER_REGISTER_STEADY_MS]);
    expect(KEEPER_REGISTER_NOT_YET_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThan(150_000);
  });

  it("CONTROL: 503 and 429 keep the old schedule (5, 10 s), so a busy server or a full ceiling is not hammered", async () => {
    expect(await waitsFor([503, 503])).toEqual([5_000, 10_000]);
    expect(await waitsFor([429, 429])).toEqual([5_000, 10_000]);
  });

  it("a 409 first step is faster than the old 5 s first step (the point of the change)", () => {
    expect(KEEPER_REGISTER_NOT_YET_BACKOFF_MS[0]).toBeLessThan(KEEPER_REGISTER_BACKOFF_MS[0]);
  });
});

describe("a landed registration announces itself", () => {
  afterEach(() => vi.restoreAllMocks());

  it("markRegistered fires perc:market-registered with the slab on window", () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<{ slab: string }>).detail.slab);
    window.addEventListener(MARKET_REGISTERED_EVENT, on);
    markRegistered("SLAB1", null);
    window.removeEventListener(MARKET_REGISTERED_EVENT, on);
    expect(seen).toEqual(["SLAB1"]);
  });

  it("CONTROL: a registration that did not land announces nothing", async () => {
    const seen: string[] = [];
    const on = () => seen.push("x");
    window.addEventListener(MARKET_REGISTERED_EVENT, on);
    const store = mapStore({ "perc.keeperProofTx.S1": "sig", "perc.keeperPayload.S1": JSON.stringify({ dex_pool_address: "P" }) });
    await resumePendingRegistrations({ store, post: async () => ({ registered: false, retryable: true, message: "409" }) });
    window.removeEventListener(MARKET_REGISTERED_EVENT, on);
    expect(seen).toEqual([]);
  });
});

function mapStore(init: Record<string, string>): KeyStore {
  const m = new Map(Object.entries(init));
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe("a repeat resume pass is limited to what the last pass left as 'try again'", () => {
  const two = () => mapStore({
    "perc.keeperProofTx.A": "sa", "perc.keeperPayload.A": JSON.stringify({ dex_pool_address: "P" }),
    "perc.keeperProofTx.B": "sb", "perc.keeperPayload.B": JSON.stringify({ dex_pool_address: "P" }),
  });
  const later: KeeperRegisterAttempt = { registered: false, retryable: true, message: "429" };

  it("only: ['A'] posts A only", async () => {
    const posted: string[] = [];
    await resumePendingRegistrations({ store: two(), only: ["A"], post: async (r) => { posted.push(r.slabAddress); return later; } });
    expect(new Set(posted)).toEqual(new Set(["A"]));
  });

  it("CONTROL: without `only` both are posted", async () => {
    const posted: string[] = [];
    await resumePendingRegistrations({ store: two(), post: async (r) => { posted.push(r.slabAddress); return later; } });
    expect(new Set(posted)).toEqual(new Set(["A", "B"]));
  });
});

describe("Retry-After is carried through, so a full ceiling (300 s) is not retried at 60 s", () => {
  it("postKeeperRegistration reads it; resume reports the longest", async () => {
    const withHeader = { ok: false, status: 429, headers: new Headers({ "Retry-After": "300" }), json: async () => ({ error: "cap" }) } as Response;
    const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(withHeader) as unknown as typeof fetch);
    expect(a).toMatchObject({ retryable: true, retryAfterMs: 300_000 });
    // CONTROL: no header, no value
    expect((await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(429, { error: "cap" })) as unknown as typeof fetch)).retryAfterMs).toBeUndefined();
    const store = mapStore({ "perc.keeperProofTx.A": "s", "perc.keeperPayload.A": JSON.stringify({ dex_pool_address: "P" }) });
    const r = await resumePendingRegistrations({ store, post: async () => ({ registered: false, retryable: true, message: "cap", retryAfterMs: 300_000 }) });
    expect(r.retryAfterMs).toBe(300_000);
  });
});
