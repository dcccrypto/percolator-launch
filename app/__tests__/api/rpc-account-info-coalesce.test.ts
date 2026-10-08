import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/rpc/route";
import { createAccountInfoCoalescer, parseAccountInfoParams } from "../../lib/rpc-coalesce";
import { getRpcMetricsSnapshot, resetRpcMetricsForTest } from "../../lib/rpc-metrics";

const K = (n: number) => String(n).padStart(44, "A"); // 44-char stand-ins for base58 keys
const CFG = { encoding: "base64", commitment: "confirmed" };

type Body = { id: number; method: string; params: unknown[] };

/** Fake upstream: getMultipleAccounts -> one entry per key; getAccountInfo -> single entry. */
function fakeUpstream() {
  const calls: Body[] = [];
  const send = async (b: Body) => {
    calls.push(b);
    if (b.method === "getMultipleAccounts") {
      const keys = b.params[0] as string[];
      return { jsonrpc: "2.0", id: b.id, result: { context: { slot: 7 }, value: keys.map((k) => ({ lamports: k.length, data: [k, "base64"] })) } };
    }
    const k = b.params[0] as string;
    return { jsonrpc: "2.0", id: b.id, result: { context: { slot: 7 }, value: { lamports: k.length, data: [k, "base64"] } } };
  };
  return { calls, send: send as unknown as Parameters<typeof createAccountInfoCoalescer>[0] };
}

describe("createAccountInfoCoalescer", () => {
  it("merges concurrent same-config reads into ONE getMultipleAccounts and reshapes each reply", async () => {
    const u = fakeUpstream();
    const c = createAccountInfoCoalescer(u.send, 2);
    const rs = await Promise.all([1, 2, 3].map((n) => c.read(K(n), CFG, `id${n}`)));
    expect(u.calls).toHaveLength(1);
    expect(u.calls[0].method).toBe("getMultipleAccounts");
    expect(u.calls[0].params).toEqual([[K(1), K(2), K(3)], CFG]);
    rs.forEach((r, i) => {
      expect(r.id).toBe(`id${i + 1}`);
      expect(r.result).toEqual({ context: { slot: 7 }, value: { lamports: 44, data: [K(i + 1), "base64"] } });
    });
  });

  it("a lone read is sent unchanged as getAccountInfo", async () => {
    const u = fakeUpstream();
    const c = createAccountInfoCoalescer(u.send, 2);
    const r = await c.read(K(1), CFG, 9);
    expect(u.calls).toHaveLength(1);
    expect(u.calls[0]).toMatchObject({ method: "getAccountInfo", params: [K(1), CFG] });
    expect(r.id).toBe(9);
  });

  it("does not merge reads with different configs", async () => {
    const u = fakeUpstream();
    const c = createAccountInfoCoalescer(u.send, 2);
    await Promise.all([c.read(K(1), CFG, 1), c.read(K(2), { encoding: "jsonParsed" }, 2), c.read(K(3), CFG, 3)]);
    expect(u.calls).toHaveLength(2); // {1,3} merged, {2} alone
  });

  it("sends a duplicated key once and fans it out", async () => {
    const u = fakeUpstream();
    const c = createAccountInfoCoalescer(u.send, 2);
    const rs = await Promise.all([c.read(K(1), CFG, "a"), c.read(K(1), CFG, "b")]);
    expect(u.calls).toHaveLength(1);
    expect(u.calls[0].method).toBe("getAccountInfo");
    expect(rs.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("chunks at 100 keys per call", async () => {
    const u = fakeUpstream();
    const c = createAccountInfoCoalescer(u.send, 2);
    await Promise.all(Array.from({ length: 230 }, (_, i) => c.read(K(i), CFG, i)));
    expect(u.calls.map((x) => (x.params[0] as string[]).length)).toEqual([100, 100, 30]);
  });

  it("maps a null (missing) account to value null", async () => {
    const send = (async (b: Body) => ({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: [null, { lamports: 1 }] } })) as unknown as Parameters<typeof createAccountInfoCoalescer>[0];
    const c = createAccountInfoCoalescer(send, 2);
    const [a, b] = await Promise.all([c.read(K(1), CFG, 1), c.read(K(2), CFG, 2)]);
    expect((a.result as { value: unknown }).value).toBeNull();
    expect((b.result as { value: unknown }).value).toEqual({ lamports: 1 });
  });

  it("delivers an upstream error to every member, and survives a transport failure", async () => {
    const errSend = (async (b: Body) => ({ jsonrpc: "2.0", id: b.id, error: { code: -32005, message: "limited" } })) as unknown as Parameters<typeof createAccountInfoCoalescer>[0];
    const c1 = createAccountInfoCoalescer(errSend, 2);
    const rs = await Promise.all([c1.read(K(1), CFG, 1), c1.read(K(2), CFG, 2)]);
    rs.forEach((r) => expect(r.error).toEqual({ code: -32005, message: "limited" }));
    const c2 = createAccountInfoCoalescer((async () => { throw new Error("boom"); }) as never, 2);
    const rs2 = await Promise.all([c2.read(K(1), CFG, 1), c2.read(K(2), CFG, 2)]);
    rs2.forEach((r) => expect(r.error).toBeTruthy());
  });
});

describe("parseAccountInfoParams", () => {
  it("accepts [key] and [key, obj]; rejects anything else", () => {
    expect(parseAccountInfoParams([K(1)])).toEqual({ pubkey: K(1), config: undefined });
    expect(parseAccountInfoParams([K(1), CFG])).toEqual({ pubkey: K(1), config: CFG });
    expect(parseAccountInfoParams([K(1), CFG, 3])).toBeNull();
    expect(parseAccountInfoParams(["short"])).toBeNull();
    expect(parseAccountInfoParams([K(1), "x"])).toBeNull();
    expect(parseAccountInfoParams(undefined)).toBeNull();
  });
});

describe("/api/rpc getAccountInfo coalescing end-to-end", () => {
  const originalFetch = global.fetch;
  let upstreamBodies: Body[];
  beforeEach(() => {
    resetRpcMetricsForTest();
    upstreamBodies = [];
    global.fetch = vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Body;
      upstreamBodies.push(b);
      const keys = b.method === "getMultipleAccounts" ? (b.params[0] as string[]) : [b.params[0] as string];
      const vals = keys.map((k) => ({ lamports: 5, data: [k, "base64"] }));
      const result = b.method === "getMultipleAccounts" ? { context: { slot: 3 }, value: vals } : { context: { slot: 3 }, value: vals[0] };
      return { json: async () => ({ jsonrpc: "2.0", id: b.id, result }) } as Response;
    }) as typeof fetch;
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("a 12-read JSON-RPC batch costs ONE upstream getMultipleAccounts and every id gets its own account", async () => {
    const batch = Array.from({ length: 12 }, (_, i) => ({ jsonrpc: "2.0", id: 100 + i, method: "getAccountInfo", params: [K(500 + i), CFG] }));
    const res = await POST(new NextRequest("http://localhost/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://api.percolatorlaunch.com" },
      body: JSON.stringify(batch),
    }));
    const out = (await res.json()) as Array<{ id: number; result: { value: { data: string[] } } }>;
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0].method).toBe("getMultipleAccounts");
    out.forEach((r, i) => {
      expect(r.id).toBe(100 + i);
      expect(r.result.value.data[0]).toBe(K(500 + i));
    });
    const snap = getRpcMetricsSnapshot();
    expect(snap.methods.getAccountInfo.in).toBe(12);
    expect(snap.methods.getMultipleAccounts.upstream).toBe(1);
    expect(snap.methods.getAccountInfo.upstream ?? 0).toBe(0);
  });
});
