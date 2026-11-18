import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const getMarketsByAddress = vi.fn();
vi.mock("@/lib/v22/discovery", () => ({
  getMarketsByAddress: (...args: unknown[]) => getMarketsByAddress(...args),
}));

import { discoverMarketsViaProgramDirectory } from "@/lib/market-directory-discovery";

let counter = 0;
function pk(): PublicKey {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(0, ++counter + 1000);
  b[31] = 7;
  return new PublicKey(b);
}
const programId = pk();
const otherProgram = pk();

function keys(n: number): string[] {
  return Array.from({ length: n }, () => pk().toBase58());
}

function jsonResponse(markets: unknown[], init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "",
    json: async () => ({ markets }),
  } as unknown as Response;
}

/** Fake Connection: every account is owned by `owner`, except those in `missing`. */
function fakeConnection(owner: PublicKey, missing = new Set<string>()) {
  const calls: string[][] = [];
  const connection = {
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => {
      calls.push(ks.map((k) => k.toBase58()));
      return ks.map((k) => (missing.has(k.toBase58()) ? null : { owner, data: Buffer.alloc(0), lamports: 1 }));
    }),
    marker: "real",
  };
  return { connection: connection as unknown as import("@solana/web3.js").Connection, calls, raw: connection };
}

beforeEach(() => {
  getMarketsByAddress.mockReset();
  getMarketsByAddress.mockImplementation(async (_c, _p, addrs: PublicKey[]) => addrs.map((a) => ({ slab: a })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("discoverMarketsViaProgramDirectory", () => {
  it("returns [] on empty / missing markets array and on a non-ok response", async () => {
    const { connection } = fakeConnection(programId);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    expect(await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test/")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response));
    expect(await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([], { ok: false, status: 503 })));
    await expect(discoverMarketsViaProgramDirectory(connection, programId, "https://api.test")).rejects.toThrow(
      "503",
    );
  });

  it("filters bad entries, dedupes, drops non-owned accounts, and calls the SDK once", async () => {
    const [a, b, c] = keys(3);
    const { connection } = fakeConnection(programId, new Set([c]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { slab_address: a, program_id: programId.toBase58() },
          { slab_address: a },
          { slab_address: b },
          { slab_address: c },
          { slab_address: "not-a-key" },
          { slab_address: 5 },
          { slab_address: keys(1)[0], program_id: otherProgram.toBase58() },
        ]),
      ),
    );
    const out = await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    expect(getMarketsByAddress).toHaveBeenCalledTimes(1);
    expect((getMarketsByAddress.mock.calls[0][2] as PublicKey[]).map((k) => k.toBase58())).toEqual([a, b]);
    expect(out).toHaveLength(2);
  });

  it("returns [] when no listed account is program-owned or no valid address remains", async () => {
    const [a] = keys(1);
    const { connection } = fakeConnection(otherProgram);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ slab_address: a }])));
    expect(await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ slab_address: "nope" }])));
    expect(await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test")).toEqual([]);
    expect(getMarketsByAddress).not.toHaveBeenCalled();
  });

  it("batches the ownership read by 100 and serves the SDK from those reads (no second fetch)", async () => {
    const list = keys(150);
    const { connection, calls } = fakeConnection(programId);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(list.map((slab_address) => ({ slab_address })))));
    getMarketsByAddress.mockImplementation(async (c, _p, addrs: PublicKey[]) => {
      const infos = await c.getMultipleAccountsInfo(addrs);
      expect(infos.every(Boolean)).toBe(true);
      expect(c.marker).toBe("real"); // proxy forwards everything else
      // an unread key falls through to the real connection
      await c.getMultipleAccountsInfo([pk()], "confirmed");
      return [];
    });
    await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    expect(calls.map((x) => x.length)).toEqual([100, 50, 1]);
  });

  // Lead 1: more than 500 listed markets.
  it("LEAD 1: pages past the 500 limit until a short page", async () => {
    const all = keys(620);
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit"));
      expect(limit).toBeLessThanOrEqual(500);
      return jsonResponse(all.slice(offset, offset + limit).map((slab_address) => ({ slab_address })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { connection } = fakeConnection(programId);
    await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    const passed = getMarketsByAddress.mock.calls[0][2] as PublicKey[];
    expect(passed).toHaveLength(620);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("LEAD 1: a full last page costs one extra empty request, then stops", async () => {
    const all = keys(500);
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
      return jsonResponse(all.slice(offset, offset + 500).map((slab_address) => ({ slab_address })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { connection } = fakeConnection(programId);
    await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getMarketsByAddress.mock.calls[0][2]).toHaveLength(500);
  });

  it("LEAD 1: a page that ignores offset (repeats) cannot loop forever", async () => {
    const all = keys(500);
    const fetchMock = vi.fn(async () => jsonResponse(all.map((slab_address) => ({ slab_address }))));
    vi.stubGlobal("fetch", fetchMock);
    const { connection } = fakeConnection(programId);
    await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(getMarketsByAddress.mock.calls[0][2]).toHaveLength(500);
  });

  // Lead 2: stalled body.
  it("LEAD 2: a stalled response body is aborted by the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        statusText: "",
        json: () =>
          new Promise((_res, rej) => {
            init.signal!.addEventListener("abort", () => rej(new Error("aborted")));
          }),
      })),
    );
    const { connection } = fakeConnection(programId);
    const p = discoverMarketsViaProgramDirectory(connection, programId, "https://api.test", { timeoutMs: 1000 });
    const settled = p.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settled).toBe("aborted");
  });

  // Lead 3: proxy and nulls.
  it("LEAD 3: not a bug — the SDK only asks for owned (non-null) keys, so a cached null is never served", async () => {
    const [a, missing] = keys(2);
    const { connection, raw } = fakeConnection(programId, new Set([missing]));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ slab_address: a }, { slab_address: missing }])));
    getMarketsByAddress.mockImplementation(async (c, _p, addrs: PublicKey[]) => {
      expect(addrs.map((k) => k.toBase58())).toEqual([a]);
      const infos = await c.getMultipleAccountsInfo(addrs, { commitment: "finalized" });
      expect(infos[0]).not.toBeNull();
      return [];
    });
    await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    expect(raw.getMultipleAccountsInfo).toHaveBeenCalledTimes(1); // commitment arg ignored on the cache hit, same bytes
  });

  // Lead 4: truthy non-string program_id.
  it("LEAD 4: a truthy non-string program_id is dropped (intended: it cannot equal this program)", async () => {
    const [a, b] = keys(2);
    const { connection } = fakeConnection(programId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([{ slab_address: a, program_id: 123 }, { slab_address: b, program_id: "" }])),
    );
    await discoverMarketsViaProgramDirectory(connection, programId, "https://api.test");
    expect((getMarketsByAddress.mock.calls[0][2] as PublicKey[]).map((k) => k.toBase58())).toEqual([b]);
  });
});
