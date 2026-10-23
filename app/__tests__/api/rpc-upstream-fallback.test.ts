// @vitest-environment node
/**
 * /api/rpc with an ordered upstream fallback. The primary (DEVNET_RPC_URL, a keyed URL) is dead; the browser must still get answers,
 * and on EVERY error path nothing that identifies an upstream (host, key, URL) may be in the response body, a header, or a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CLUSTER_GENESIS } from "@/lib/rpc-upstreams";

const PRIMARY = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const FB = "https://rpc.fallback-one.test/SECRETPATHTOKEN1234567890";
const SECRET_RE = /primary-rpc|PRIMARYKEY|fallback-one|SECRETPATH|api-key/i;

type Handler = (url: string, body: { method: string; id: unknown }) => Promise<Partial<Response> & { json?: () => Promise<unknown> }> | (Partial<Response> & { json?: () => Promise<unknown> });
let handler: Handler;
let urls: string[];
const realFetch = global.fetch;
let logs: string[];

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://api.percolatorlaunch.com", ...headers },
    body: JSON.stringify(body),
  });
}
const ok = (result: unknown, id: unknown = 1) => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) });

async function route(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("RPC_COALESCE_ACCOUNT_INFO", "0");
  return (await import("../../app/api/rpc/route")).POST;
}

beforeEach(() => {
  urls = [];
  logs = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    const body = JSON.parse(String(init?.body)) as { method: string; id: unknown };
    return (await handler(u, body)) as Response;
  }) as typeof fetch;
  for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {})))).join(" ")));
});
afterEach(() => {
  global.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ENV = { DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: FB };
/** Body text + headers + every log line, for the secret scan. */
const everything = (res: Response, bodyText: string) => `${bodyText} ${JSON.stringify([...res.headers.entries()])} ${logs.join("\n")}`;

describe("/api/rpc upstream fallback", () => {
  it("a dead primary (429 'max usage') is answered by the fallback: the browser gets a result", async () => {
    handler = (u, b) => {
      if (u === PRIMARY) return { status: 429, json: async () => ({ jsonrpc: "2.0", error: { code: -32429, message: "max usage reached for api-key PRIMARYKEY-0123456789" }, id: null }) };
      return b.method === "getGenesisHash" ? ok(CLUSTER_GENESIS.devnet) : ok(123, b.id);
    };
    const POST = await route(ENV);
    const res = await POST(req({ jsonrpc: "2.0", id: 5, method: "getSlot", params: [] }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", id: 5, result: 123 });
    expect(urls[0]).toBe(PRIMARY);
    expect(urls).toContain(FB);
    expect(SECRET_RE.test(everything(res, text))).toBe(false);
  });

  it("a healthy primary never sees the fallback", async () => {
    handler = (_u, b) => ok(1, b.id);
    const POST = await route(ENV);
    await POST(req({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }));
    expect(urls).toEqual([PRIMARY]);
  });

  it("the primary is re-probed after its cooldown only (the second call goes straight to the fallback)", async () => {
    let primaryCalls = 0;
    handler = (u, b) => {
      if (u === PRIMARY) {
        primaryCalls++;
        // A definite refusal (429) cools at once; an ambiguous one (503) needs a second strike (lib/rpc-upstreams.ts, AUD-RAPP #3563).
        return { status: 429, json: async () => ({}) };
      }
      return b.method === "getGenesisHash" ? ok(CLUSTER_GENESIS.devnet) : ok(9, b.id);
    };
    const POST = await route(ENV);
    await POST(req({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }));
    await POST(req({ jsonrpc: "2.0", id: 2, method: "getEpochInfo", params: [] }));
    expect(primaryCalls).toBe(1);
  });

  it("the allowlist and the batch limit still apply first (no upstream is called for a blocked method)", async () => {
    handler = (_u, b) => ok(1, b.id);
    const POST = await route(ENV);
    const res = await POST(req({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] }));
    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
    const big = await POST(req(Array.from({ length: 41 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getSlot", params: [] }))));
    expect(big.status).toBe(400);
    expect(urls).toEqual([]);
  });

  it("an unauthorised caller is refused before any upstream (origin guard unchanged)", async () => {
    handler = (_u, b) => ok(1, b.id);
    const POST = await route(ENV);
    const res = await POST(req({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
  });

  describe("every error path: no upstream host, key or URL in the body, the headers or the logs", () => {
    const failures: [string, Handler][] = [
      ["all upstreams answer 429 with a body that echoes the key", (_u) => ({ status: 429, json: async () => ({ jsonrpc: "2.0", error: { code: -32429, message: `max usage reached ${PRIMARY} ${FB}` }, id: null }) })],
      ["fetch rejects with an error that names the URL", (u) => { throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${new URL(u).host} (${u})`); }],
      ["a timeout", (u) => { throw new DOMException(`The operation to ${u} timed out`, "TimeoutError"); }],
      ["a non-JSON body from every upstream", () => ({ status: 200, json: async () => { throw new SyntaxError(`Unexpected token < in JSON at ${PRIMARY}`); } })],
      ["HTML error pages with status 502", () => ({ status: 502, json: async () => { throw new SyntaxError("<html>"); } })],
      ["a fallback on the wrong cluster", (u, b) => (u === PRIMARY ? { status: 429, json: async () => ({}) } : b.method === "getGenesisHash" ? ok(CLUSTER_GENESIS.mainnet) : ok(1, b.id))],
    ];
    for (const [name, h] of failures) {
      it(name, async () => {
        handler = h;
        const POST = await route(ENV);
        // Every usable upstream refused for RATE: the generic body becomes the rate-limit one, with HTTP 429 (AUD-RAPP #3563).
        const rate = name === "all upstreams answer 429 with a body that echoes the key" || name === "a fallback on the wrong cluster";
        const single = await POST(req({ jsonrpc: "2.0", id: 3, method: "getSlot", params: [] }));
        const st = await single.text();
        expect(JSON.parse(st)).toEqual(
          rate
            ? { jsonrpc: "2.0", id: 3, error: { code: -32429, message: "Too many requests: the RPC is rate limited. Try again shortly." } }
            : { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "Upstream RPC request failed" } },
        );
        expect(single.status).toBe(rate ? 429 : 200);
        expect(SECRET_RE.test(everything(single, st))).toBe(false);
        const batch = await POST(req([{ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [] }, { jsonrpc: "2.0", id: 2, method: "getHealth", params: [] }]));
        const bt = await batch.text();
        expect(SECRET_RE.test(everything(batch, bt))).toBe(false);
        // Wrong cluster: by the batch the primary is cooling and the only ready fallback is unusable, so nothing is attempted: generic.
        expect(batch.status).toBe(name === "all upstreams answer 429 with a body that echoes the key" ? 429 : 200);
      });
    }

    it("a passed-through application error that echoes an upstream URL is scrubbed", async () => {
      handler = (_u, b) => ({ status: 200, json: async () => ({ jsonrpc: "2.0", id: b.id, error: { code: -32002, message: `Transaction simulation failed (relayed by ${PRIMARY})` } }) });
      const POST = await route(ENV);
      const res = await POST(req({ jsonrpc: "2.0", id: 4, method: "simulateTransaction", params: ["AAAA", { encoding: "base64" }] }));
      const j = (await res.json()) as { error: { code: number; message: string } };
      expect(j.error.code).toBe(-32002);
      expect(SECRET_RE.test(JSON.stringify(j))).toBe(false);
    });
  });

  it("sendTransaction after an AMBIGUOUS primary failure is not re-sent; after a definite rejection (429) it is", async () => {
    const tx = { jsonrpc: "2.0", id: 5, method: "sendTransaction", params: [Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 3), Buffer.from("m")]).toString("base64"), { encoding: "base64" }] };
    handler = (u, b) => {
      if (u === PRIMARY) throw new Error(`timed out talking to ${PRIMARY}`);
      return b.method === "getGenesisHash" ? ok(CLUSTER_GENESIS.devnet) : ok("SIG", b.id);
    };
    let POST = await route(ENV);
    let res = await POST(req(tx));
    let text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32603, message: "Upstream RPC request failed" } });
    expect(urls.filter((u) => u === FB)).toEqual([]); // the fallback never saw the transaction (nor a probe)
    expect(SECRET_RE.test(everything(res, text))).toBe(false);
    urls = [];
    handler = (u, b) => (u === PRIMARY ? { status: 429, json: async () => ({}) } : b.method === "getGenesisHash" ? ok(CLUSTER_GENESIS.devnet) : ok("SIG", b.id));
    POST = await route(ENV);
    res = await POST(req(tx));
    text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: "2.0", id: 5, result: "SIG" });
  });

  it("a client-influenced error echo ('quota') does not cool the primary: the next call still goes to it", async () => {
    let primaryCalls = 0;
    handler = (u, b) => {
      if (u === PRIMARY) {
        primaryCalls++;
        return { status: 200, json: async () => ({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "Asset Not Found: quota" } }) };
      }
      return ok(1, b.id);
    };
    const POST = await route(ENV);
    await POST(req({ jsonrpc: "2.0", id: 1, method: "getAsset", params: ["quota"] }));
    await POST(req({ jsonrpc: "2.0", id: 2, method: "getAsset", params: ["quota2"] }));
    expect(primaryCalls).toBe(2);
    expect(urls.includes(FB)).toBe(false);
  });

  it("a fallback list given only as a NEXT_PUBLIC_ variable is ignored (server env only); the devnet default is used instead", async () => {
    handler = (u, b) => (u === PRIMARY ? { status: 429, json: async () => ({}) } : b.method === "getGenesisHash" ? ok(CLUSTER_GENESIS.devnet) : ok(5, b.id));
    const POST = await route({ DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: undefined, NEXT_PUBLIC_DEVNET_RPC_FALLBACK_URLS: "https://leak.test/" });
    await POST(req({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }));
    expect(urls).toContain("https://api.devnet.solana.com");
    expect(urls.some((u) => u.includes("leak.test"))).toBe(false);
  });

  it("an http:// fallback is dropped (https only)", async () => {
    handler = (u) => ({ status: 429, json: async () => ({}) });
    const POST = await route({ DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: "http://insecure.test/rpc" });
    await POST(req({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }));
    expect(urls.some((u) => u.startsWith("http://"))).toBe(false);
  });

  it("the request body cannot choose an upstream", async () => {
    handler = (_u, b) => ok(1, b.id);
    const POST = await route(ENV);
    await POST(req({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [], url: "https://attacker.test", rpcUrl: "https://attacker.test" }));
    expect(urls.some((u) => u.includes("attacker.test"))).toBe(false);
  });
});

describe("/api/rpc: every upstream rate-limiting us is an HTTP 429 (AUD-RAPP #3563)", () => {
  const limited = (u: string, b: { method: string; id: unknown }) =>
    b.method === "getGenesisHash" && u !== PRIMARY ? ok(CLUSTER_GENESIS.devnet) : { status: 429, json: async () => ({ jsonrpc: "2.0", error: { code: -32429, message: `max usage ${u}` }, id: null }) };
  it("single request: HTTP 429 with a JSON-RPC -32429 error, no upstream detail", async () => {
    handler = limited;
    const POST = await route(ENV);
    const res = await POST(req({ jsonrpc: "2.0", id: 5, method: "getSlot", params: [] }));
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ id: 5, error: { code: -32429 } });
    expect(everything(res, text)).not.toMatch(SECRET_RE);
  });
  it("batch: 429 only when EVERY item is rate-limited; otherwise 200 with per-item results", async () => {
    handler = limited;
    let POST = await route(ENV);
    let res = await POST(req([{ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }, { jsonrpc: "2.0", id: 2, method: "getBlockHeight", params: [] }]));
    expect(res.status).toBe(429);
    handler = (u, b) => (b.method === "getSlot" ? limited(u, b) : ok(9, b.id));
    POST = await route(ENV);
    res = await POST(req([{ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }, { jsonrpc: "2.0", id: 2, method: "getBlockHeight", params: [] }]));
    expect(res.status).toBe(200);
    const items = (await res.json()) as { id: number; error?: { code: number }; result?: unknown }[];
    expect(items.find((x) => x.id === 1)?.error?.code).toBe(-32429);
    expect(items.find((x) => x.id === 2)?.result).toBe(9);
  });
  it("a non-rate failure (5xx everywhere) stays the generic -32603 with HTTP 200", async () => {
    handler = (u, b) => (b.method === "getGenesisHash" && u !== PRIMARY ? ok(CLUSTER_GENESIS.devnet) : { status: 503, json: async () => ({}) });
    const POST = await route(ENV);
    const res = await POST(req({ jsonrpc: "2.0", id: 5, method: "getSlot", params: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ error: { code: -32603 } });
  });
});
