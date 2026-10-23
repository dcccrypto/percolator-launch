// @vitest-environment node
/** getServerConnection (faucet, cosign, markets...) rotates to the fallback when the primary is dead, and leaks no upstream detail. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTER_GENESIS } from "@/lib/rpc-upstreams";

const PRIMARY = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const FB = "https://rpc.fallback-one.test/SECRETPATHTOKEN1234567890";
const realFetch = global.fetch;
let urls: string[];

async function conn(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  return (await import("@/lib/server-rpc")).getServerConnection();
}
const rpc = (result: unknown, id: unknown = 1) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  urls = [];
});
afterEach(() => {
  global.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("getServerConnection fallback", () => {
  it("primary dead (429): the same call is answered by the fallback", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      const { method: m, id } = JSON.parse(String(init?.body)) as { method: string; id: unknown };
      if (u === PRIMARY) return new Response(JSON.stringify({ error: { code: -32429, message: "max usage reached" } }), { status: 429 });
      return m === "getGenesisHash" ? rpc(CLUSTER_GENESIS.devnet, id) : rpc(4242, id);
    }) as typeof fetch;
    const c = await conn({ DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: FB });
    expect(await c.getSlot()).toBe(4242);
    expect(urls[0]).toBe(PRIMARY);
    expect(urls).toContain(FB);
  });

  it("everything dead: a generic error with no upstream host or key", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed ${PRIMARY} ${FB}`);
    }) as typeof fetch;
    const c = await conn({ DEVNET_RPC_URL: PRIMARY, DEVNET_RPC_FALLBACK_URLS: FB });
    const e = await c.getSlot().catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(`${e.message} ${e.stack ?? ""}`).not.toMatch(/primary-rpc|PRIMARYKEY|fallback-one|SECRETPATH/);
  });

  it("the rotating fetch returns the answering upstream's real status and body, and honours an abort", async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(url));
      const { id } = JSON.parse(String(init?.body)) as { id: unknown };
      if (String(url) === PRIMARY) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "bad params" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    vi.resetModules();
    const { makeRotatingFetch } = await import("@/lib/server-rpc");
    const { buildUpstreams, UpstreamPool, __setSharedUpstreamPoolForTest } = await import("@/lib/rpc-upstreams");
    __setSharedUpstreamPoolForTest(new UpstreamPool({ warn: () => undefined }));
    const ups = buildUpstreams("devnet", { url: PRIMARY, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv);
    const f = makeRotatingFetch([{ ...ups[0]!, url: "https://rpc.fallback-one.test/x", id: "z", primary: true }], "devnet");
    const res = await f("ignored", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "getSlot", params: [] }) });
    expect(res.status).toBe(400); // a request error passes through with its real status (not forced to 200)
    expect(await res.json()).toMatchObject({ error: { code: -32602 } });
    const ac = new AbortController();
    ac.abort();
    const before = seen.length;
    await expect(f("ignored", { method: "POST", body: "{}", signal: ac.signal })).rejects.toThrow("RPC upstream unavailable");
    expect(seen.length).toBe(before); // an aborted caller sends nothing
    await expect(f("ignored", { method: "POST", body: new Uint8Array(1) })).rejects.toThrow();
    __setSharedUpstreamPoolForTest(null);
  });
});

describe("getServerConnection: every upstream rate-limiting us is a 429, not a generic failure (AUD-RAPP #3563)", () => {
  it("the rotating fetch answers HTTP 429, so disableRetryOnRateLimit fails fast with a 429 and no upstream detail", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const { method: m, id } = JSON.parse(String(init?.body)) as { method: string; id: unknown };
      if (m === "getGenesisHash" && u === FB) return rpc(CLUSTER_GENESIS.devnet, id);
      return new Response(JSON.stringify({ error: { code: -32429, message: `max usage ${u}` } }), { status: 429 });
    }) as typeof fetch;
    vi.resetModules();
    vi.stubEnv("DEVNET_RPC_URL", PRIMARY);
    vi.stubEnv("DEVNET_RPC_FALLBACK_URLS", FB);
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    const m = await import("@/lib/server-rpc");
    const c = m.getServerConnection("confirmed", { disableRetryOnRateLimit: true });
    const e = await c.getSlot().catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/429/);
    expect(`${e.message} ${e.stack ?? ""}`).not.toMatch(/primary-rpc|PRIMARYKEY|fallback-one|SECRETPATH/);
  });
});
