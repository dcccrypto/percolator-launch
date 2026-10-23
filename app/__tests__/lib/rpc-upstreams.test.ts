// @vitest-environment node
/**
 * Ordered RPC upstreams (lib/rpc-upstreams.ts): rotation, cooldown + primary re-probe, cluster check, redaction, env parsing.
 * All upstream hosts and keys below are fake; the assertions are that none of them ever comes back out.
 */
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import {
  MUTATING_RPC_METHODS,
  sendTransactionSignature,
  CLUSTER_GENESIS,
  DEFAULT_DEVNET_FALLBACK,
  UpstreamPool,
  UpstreamUnavailableError,
  UpstreamRateLimitedError,
  HEAVY_RPC_METHODS,
  STRIKE_WINDOW_MS,
  buildUpstreams,
  fallbackUrlsFor,
  isQuotaBody,
  parseFallbackUrls,
  redactJson,
  redactText,
  safeErrorText,
} from "@/lib/rpc-upstreams";

const PRIMARY_URL = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const FB1 = "https://rpc.fallback-one.test/SECRETPATHTOKEN1234567890";
const FB2 = "https://rpc.fallback-two.test/?token=FALLBACKTWOKEY12345";
const ENV = { DEVNET_RPC_FALLBACK_URLS: `${FB1}, ${FB2}` } as unknown as NodeJS.ProcessEnv;
const mk = (env = ENV) => buildUpstreams("devnet", { url: PRIMARY_URL, headers: { "Content-Type": "application/json", Origin: "https://o.test" } }, env);

type Reply = { status?: number; body?: unknown; text?: string; throws?: string };
function fakeNet(script: Record<string, Reply | ((n: number) => Reply)>, genesis: Record<string, string> = {}) {
  const calls: { url: string; method: string }[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; id: number };
    calls.push({ url, method: body.method });
    counts[url] = (counts[url] ?? 0) + 1;
    if (body.method === "getGenesisHash" && genesis[url] !== undefined) {
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: genesis[url] }) } as Response;
    }
    const r0 = script[url];
    const r = typeof r0 === "function" ? r0(counts[url]!) : r0 ?? { body: { jsonrpc: "2.0", id: body.id, result: "ok" } };
    if (r.throws) throw new Error(r.throws);
    return {
      status: r.status ?? 200,
      json: async () => {
        if (r.text !== undefined) throw new SyntaxError("Unexpected token < in JSON");
        return r.body ?? { jsonrpc: "2.0", id: body.id, result: "ok" };
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const REQ = { jsonrpc: "2.0", id: 7, method: "getSlot", params: [] };
const G = CLUSTER_GENESIS.devnet;

describe("env parsing", () => {
  it("devnet defaults to the public devnet RPC when unset; mainnet to none", () => {
    expect(fallbackUrlsFor("devnet", {} as NodeJS.ProcessEnv)).toEqual([DEFAULT_DEVNET_FALLBACK]);
    expect(fallbackUrlsFor("mainnet", {} as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("an explicit empty value turns the fallback off", () => {
    expect(fallbackUrlsFor("devnet", { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("https only, valid URLs only, deduplicated, capped", () => {
    expect(parseFallbackUrls("http://insecure.test, ftp://x.test, not a url, https://a.test, https://a.test,  ,https://b.test")).toEqual(["https://a.test", "https://b.test"]);
    expect(parseFallbackUrls(Array.from({ length: 9 }, (_, i) => `https://h${i}.test`).join(","))).toHaveLength(4);
  });
  it("reads the SERVER variables only (a NEXT_PUBLIC_ twin is ignored)", () => {
    const env = { NEXT_PUBLIC_DEVNET_RPC_FALLBACK_URLS: "https://leak.test" } as unknown as NodeJS.ProcessEnv;
    expect(fallbackUrlsFor("devnet", env)).toEqual([DEFAULT_DEVNET_FALLBACK]);
  });
  it("a fallback equal to the primary is dropped; the primary keeps the Origin header, fallbacks do not", () => {
    const l = buildUpstreams("devnet", { url: FB1, headers: { Origin: "https://o.test" } }, ENV);
    expect(l.map((u) => u.primary)).toEqual([true, false]);
    expect(mk()[0]!.headers.Origin).toBe("https://o.test");
    expect(mk()[1]!.headers.Origin).toBeUndefined();
  });
});

describe("rotation", () => {
  it("uses the primary while it is healthy and never touches a fallback", async () => {
    const net = fakeNet({});
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.map((c) => c.url)).toEqual([PRIMARY_URL]);
  });

  it.each([
    ["HTTP 429", { status: 429, body: { jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" } } }],
    ["HTTP 401", { status: 401, body: { error: "Unauthorized" } }],
    ["HTTP 503", { status: 503, body: {} }],
    ["a 200 with a max-usage JSON-RPC error", { body: { jsonrpc: "2.0", id: 7, error: { code: -32429, message: "max usage reached" } } }],
    ["a quota CODE (-32005) on a 200", { body: { jsonrpc: "2.0", id: 7, error: { code: -32005, message: "Node is unhealthy" } } }],
    ["a network error", { throws: "fetch failed ECONNRESET" }],
    ["a non-JSON body", { status: 200, text: "<html>" }],
  ] as [string, Reply][])("moves on after %s", async (_n, bad) => {
    const net = fakeNet({ [PRIMARY_URL]: bad }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.map((c) => c.url)).toEqual([PRIMARY_URL, FB1, FB1]); // primary, fallback genesis check, fallback call
  });

  it("an application-level JSON-RPC error (simulation failure) is an ANSWER, not a reason to switch", async () => {
    const sim = { jsonrpc: "2.0", id: 7, error: { code: -32002, message: "Transaction simulation failed: custom program error: 0x1b" } };
    const net = fakeNet({ [PRIMARY_URL]: { body: sim } });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toEqual(sim);
    expect(net.calls).toHaveLength(1);
    expect(isQuotaBody(sim)).toBe(false);
  });

  it("a batch fails over only when EVERY item is a quota error", () => {
    const q = { error: { code: -32429, message: "max usage" } };
    expect(isQuotaBody([q, q])).toBe(true);
    expect(isQuotaBody([q, { result: 1 }])).toBe(false);
  });

  it("walks the whole list: second fallback answers when the primary and the first fail", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 500 } }, { [FB1]: G, [FB2]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.filter((c) => c.method === "getSlot").map((c) => c.url)).toEqual([PRIMARY_URL, FB1, FB2]);
  });

  it("all dead: one generic error, nothing about the upstreams", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 500 }, [FB2]: { throws: `connect ECONNREFUSED ${FB2}` } }, { [FB1]: G, [FB2]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    const e = await pool.post(mk(), REQ, "devnet").catch((x) => x as Error);
    expect(e).toBeInstanceOf(UpstreamUnavailableError);
    expect(e.message).toBe("RPC upstream unavailable");
    expect(JSON.stringify([e.message, e.name, e.stack ?? ""])).not.toMatch(/primary-rpc|fallback-|PRIMARYKEY|SECRETPATH|FALLBACKTWO/);
  });

  it("the same request body goes to every upstream (the allowlist is applied before, once)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      if (b.method === "getGenesisHash") return { status: 200, json: async () => ({ result: G }) } as Response;
      seen.push(String(init.body));
      return url === PRIMARY_URL ? ({ status: 429, json: async () => ({}) } as Response) : ({ status: 200, json: async () => ({ result: 1 }) } as Response);
    }) as unknown as typeof fetch;
    await new UpstreamPool({ fetchImpl }).post(mk(), REQ, "devnet");
    expect(seen).toEqual([JSON.stringify(REQ), JSON.stringify(REQ)]);
  });
});

describe("cooldown and primary re-probe", () => {
  it("a failed primary is skipped during its cooldown, then probed FIRST again; one success resets it", async () => {
    let t = 1_000_000;
    let primaryDown = true;
    const net = fakeNet({ [PRIMARY_URL]: () => (primaryDown ? { status: 429 } : { body: { jsonrpc: "2.0", id: 7, result: "primary" } }), [FB1]: { body: { jsonrpc: "2.0", id: 7, result: "fb" } } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000 });
    const ups = mk();
    expect(await pool.post(ups, REQ, "devnet")).toMatchObject({ result: "fb" });
    expect(pool.isCooling(ups[0]!)).toBe(true);
    const primaryHits = () => net.calls.filter((c) => c.url === PRIMARY_URL).length;
    expect(primaryHits()).toBe(1);
    t += 10_000; // inside the cooldown: not probed
    await pool.post(ups, REQ, "devnet");
    expect(primaryHits()).toBe(1);
    t += 25_000; // cooldown over: probed first, still down -> doubles
    await pool.post(ups, REQ, "devnet");
    expect(primaryHits()).toBe(2);
    t += 40_000; // 60 s cooldown not over yet
    await pool.post(ups, REQ, "devnet");
    expect(primaryHits()).toBe(2);
    primaryDown = false;
    t += 30_000; // over: probed, healthy again
    expect(await pool.post(ups, REQ, "devnet")).toMatchObject({ result: "primary" });
    expect(pool.isCooling(ups[0]!)).toBe(false);
    expect(await pool.post(ups, REQ, "devnet")).toMatchObject({ result: "primary" }); // and it stays first
  });

  it("the cooldown is capped", async () => {
    let t = 0;
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t, cooldownBaseMs: 1_000, cooldownMaxMs: 4_000 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv);
    for (let i = 0; i < 8; i++) {
      await pool.post(ups, REQ, "devnet").catch(() => undefined);
      t += 4_001; // always past the (capped) cooldown
    }
    expect(net.calls.filter((c) => c.url === PRIMARY_URL)).toHaveLength(8);
  });

  it("when every upstream is cooling they are all still tried, soonest-ready first (no dead end)", async () => {
    let t = 0;
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 429 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t, cooldownBaseMs: 60_000 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await pool.post(ups, REQ, "devnet").catch(() => undefined);
    t += 5;
    const before = net.calls.length;
    await pool.post(ups, REQ, "devnet").catch(() => undefined);
    expect(net.calls.length).toBeGreaterThan(before);
  });
});

describe("cluster check on fallbacks", () => {
  it("a fallback on another cluster is never used, and the primary is not asked to prove anything", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } }, { [FB1]: CLUSTER_GENESIS.mainnet, [FB2]: G });
    const warn = vi.fn();
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, warn });
    expect(await pool.post(mk(), REQ, "devnet")).toMatchObject({ result: "ok" });
    expect(net.calls.some((c) => c.url === FB1 && c.method === "getSlot")).toBe(false);
    expect(net.calls.some((c) => c.url === FB2 && c.method === "getSlot")).toBe(true);
    expect(net.calls.some((c) => c.url === PRIMARY_URL && c.method === "getGenesisHash")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/fallback-one|SECRETPATH/);
  });

  it("the verdict is cached: one genesis call per fallback, however many requests", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => 0, cooldownBaseMs: 0 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    for (let i = 0; i < 4; i++) await pool.post(ups, REQ, "devnet");
    expect(net.calls.filter((c) => c.method === "getGenesisHash")).toHaveLength(1);
  });

  it("a wrong-cluster verdict is re-checked only after the long delay", async () => {
    let t = 0;
    let genesis = CLUSTER_GENESIS.mainnet;
    const base = fakeNet({ [PRIMARY_URL]: { status: 429 } });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      if (url === FB1 && b.method === "getGenesisHash") return { status: 200, json: async () => ({ result: genesis }) } as Response;
      return base.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl, now: () => t, cooldownBaseMs: 0, mismatchRecheckMs: 600_000, warn: () => undefined });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await expect(pool.post(ups, REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    genesis = G;
    t += 1_000;
    await expect(pool.post(ups, REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError); // cached verdict still wrong
    t += 600_000;
    await expect(pool.post(ups, REQ, "devnet")).resolves.toMatchObject({ result: "ok" });
  });

  it("a mainnet deployment checks against the mainnet genesis", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, warn: () => undefined });
    const ups = buildUpstreams("mainnet", { url: PRIMARY_URL, headers: {} }, { MAINNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await expect(pool.post(ups, REQ, "mainnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("a failed genesis call (cannot tell) is not cached as wrong: it is retried after the cooldown", async () => {
    let t = 0;
    let up = false;
    const base = fakeNet({ [PRIMARY_URL]: { status: 429 } });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      if (url === FB1 && b.method === "getGenesisHash") {
        if (!up) throw new Error("fetch failed");
        return { status: 200, json: async () => ({ result: G }) } as Response;
      }
      return base.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl, now: () => t, cooldownBaseMs: 1_000 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await expect(pool.post(ups, REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    up = true;
    t += 60_000;
    await expect(pool.post(ups, REQ, "devnet")).resolves.toMatchObject({ result: "ok" });
  });
});

describe("redaction", () => {
  const ups = mk();
  it("text: configured URLs, hosts, keys and any URL / key parameter are replaced", () => {
    const t = redactText(`connect ECONNREFUSED ${PRIMARY_URL} then https://other.test/x?api-key=ZZZ999 host rpc.fallback-one.test path SECRETPATHTOKEN1234567890`, ups);
    expect(t).not.toMatch(/primary-rpc|PRIMARYKEY|other\.test|ZZZ999|fallback-one|SECRETPATH/);
  });
  it("json: an upstream body that echoes a URL or key is scrubbed; a clean one is returned untouched (same object)", () => {
    const dirty = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `bad request to ${FB2}`, data: { key: "FALLBACKTWOKEY12345" } } };
    expect(JSON.stringify(redactJson(dirty, ups))).not.toMatch(/fallback-two|FALLBACKTWOKEY/);
    const clean = { jsonrpc: "2.0", id: 1, result: { value: 1 } };
    expect(redactJson(clean, ups)).toBe(clean);
  });
  it("error text for logs is short and URL-free", () => {
    const e = new TypeError(`fetch failed: getaddrinfo ENOTFOUND devnet.primary-rpc.test (${PRIMARY_URL})`);
    const t = safeErrorText(e, ups);
    expect(t).not.toMatch(/primary-rpc|PRIMARYKEY/);
    expect(t.length).toBeLessThanOrEqual(200);
  });
});

describe("cooling counts only transport errors, 401/403/408/429/5xx and quota CODES (never message text)", () => {
  const coolsPrimary = async (primary: Reply): Promise<boolean> => {
    const net = fakeNet({ [PRIMARY_URL]: primary }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    const ups = mk();
    await pool.post(ups, REQ, "devnet").catch(() => undefined);
    return pool.isCooling(ups[0]!);
  };
  it("a client-influenced echo can never cool the primary: error text containing 'quota' / 'rate limit' / 'max usage' on an ordinary code", async () => {
    for (const msg of ["Asset Not Found: quota", "bad param: rate limit", "no such key: max usage reached", "exhausted credits"]) {
      expect(await coolsPrimary({ body: { jsonrpc: "2.0", id: 7, error: { code: -32602, message: msg } } })).toBe(false);
    }
  });
  it("and the answer is passed through to the caller, not swallowed", async () => {
    const echo = { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Asset Not Found: quota" } };
    const net = fakeNet({ [PRIMARY_URL]: { body: echo } });
    expect(await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(mk(), REQ, "devnet")).toEqual(echo);
    expect(net.calls).toHaveLength(1);
  });
  it("a plain-text 4xx (the request's own fault) neither cools nor moves on; other 4xx JSON answers pass through", async () => {
    expect(await coolsPrimary({ status: 400, text: "bad request" })).toBe(false);
    expect(await coolsPrimary({ status: 413, text: "too large" })).toBe(false);
    const net = fakeNet({ [PRIMARY_URL]: { status: 404, body: { error: "nope" } } });
    expect(await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(mk(), REQ, "devnet")).toEqual({ error: "nope" });
    const net2 = fakeNet({ [PRIMARY_URL]: { status: 400, text: "x" } }, { [FB1]: G });
    await expect(new UpstreamPool({ fetchImpl: net2.fetchImpl }).post(mk(), REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(net2.calls.every((c) => c.url === PRIMARY_URL)).toBe(true);
  });
  it.each([
    ["HTTP 429", { status: 429 }],
    ["HTTP 401", { status: 401 }],
    ["HTTP 403", { status: 403 }],
    ["a quota code -32429", { body: { jsonrpc: "2.0", id: 7, error: { code: -32429, message: "x" } } }],
  ] as [string, Reply][])("a definite refusal cools at once: %s", async (_n, bad) => {
    expect(await coolsPrimary(bad)).toBe(true);
  });
  // AUD-RAPP #3563 L2: an ambiguous failure is a first strike; a second within the window cools; a heavy read never does.
  const AMBIGUOUS: [string, Reply][] = [
    ["HTTP 408", { status: 408 }],
    ["HTTP 500", { status: 500 }],
    ["a network error", { throws: "ECONNRESET" }],
    ["a 200 that is not JSON", { status: 200, text: "<html>" }],
  ];
  const strikes = async (bad: Reply, req: unknown, gapMs: number): Promise<boolean[]> => {
    let t = 1_000_000;
    const net = fakeNet({ [PRIMARY_URL]: bad }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl, now: () => t });
    const ups = mk();
    await pool.post(ups, req, "devnet").catch(() => undefined);
    const first = pool.isCooling(ups[0]!);
    t += gapMs;
    await pool.post(ups, req, "devnet").catch(() => undefined);
    return [first, pool.isCooling(ups[0]!)];
  };
  it.each(AMBIGUOUS)("an ambiguous failure (%s) cools only on a second strike within the window", async (_n, bad) => {
    expect(await strikes(bad, REQ, 5_000)).toEqual([false, true]);
    expect(await strikes(bad, REQ, STRIKE_WINDOW_MS + 1)).toEqual([false, false]);
  });
  it.each(AMBIGUOUS)("a heavy read's ambiguous failure (%s) never cools the primary, however often", async (_n, bad) => {
    for (const method of ["getProgramAccounts", "getSignaturesForAddress"]) {
      expect(await strikes(bad, { ...REQ, method }, 5_000)).toEqual([false, false]);
      // a batch with one heavy item counts as heavy
      expect(await strikes(bad, [REQ, { ...REQ, id: 8, method }], 5_000)).toEqual([false, false]);
    }
  });
  it("a heavy read still FAILS OVER (the caller is served), it just does not demote the primary", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 504 }, [FB1]: { body: { jsonrpc: "2.0", id: 7, result: "fb" } } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    const ups = mk();
    expect(await pool.post(ups, { ...REQ, method: "getProgramAccounts" }, "devnet")).toMatchObject({ result: "fb" });
    expect(pool.isCooling(ups[0]!)).toBe(false);
    expect(HEAVY_RPC_METHODS.has("getProgramAccounts")).toBe(true);
  });
});

describe("all-429 is surfaced as a rate limit (AUD-RAPP #3563)", () => {
  it("every attempt refused for rate (429 / -32429 / -32005): UpstreamRateLimitedError (still generic, still an UpstreamUnavailableError)", async () => {
    const net = fakeNet(
      { [PRIMARY_URL]: { status: 429 }, [FB1]: { body: { jsonrpc: "2.0", id: 7, error: { code: -32005, message: "x" } } }, [FB2]: { status: 429 } },
      { [FB1]: G, [FB2]: G },
    );
    const err = await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(mk(), REQ, "devnet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamRateLimitedError);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(String((err as Error).message)).not.toMatch(/test|key|http/i);
  });
  it("any non-rate failure among them: the generic UpstreamUnavailableError, not a rate limit", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 429 }, [FB1]: { status: 503 }, [FB2]: { status: 429 } }, { [FB1]: G, [FB2]: G });
    const err = await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(mk(), REQ, "devnet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err).not.toBeInstanceOf(UpstreamRateLimitedError);
  });
});

describe("mutating requests (sendTransaction) are never re-sent after an ambiguous failure", () => {
  const raw = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), Buffer.from("message-bytes")]);
  const SEND = { jsonrpc: "2.0", id: 9, method: "sendTransaction", params: [raw.toString("base64"), { encoding: "base64" }] };
  const SIG = bs58.encode(Buffer.alloc(64, 7));
  const sentTo = (net: ReturnType<typeof fakeNet>) => net.calls.filter((c) => c.method === "sendTransaction").map((c) => c.url);

  it("is classed as mutating; reads are not", () => {
    expect(MUTATING_RPC_METHODS.has("sendTransaction")).toBe(true);
    expect(MUTATING_RPC_METHODS.has("getSlot")).toBe(false);
    expect(sendTransactionSignature(SEND)).toBe(SIG);
  });

  it.each([
    ["a timeout / network error after the body was sent", { throws: "The operation timed out" }],
    ["HTTP 500", { status: 500 }],
    ["HTTP 503", { status: 503 }],
    ["HTTP 408", { status: 408 }],
    ["a 200 that is not JSON", { status: 200, text: "<html>" }],
  ] as [string, Reply][])("%s: the tx goes to ONE upstream only; the caller gets the generic error", async (_n, bad) => {
    const net = fakeNet({ [PRIMARY_URL]: bad }, { [FB1]: G, [FB2]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    await expect(pool.post(mk(), SEND, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(sentTo(net)).toEqual([PRIMARY_URL]);
  });

  it.each([
    ["HTTP 429", { status: 429 }],
    ["HTTP 401", { status: 401 }],
    ["HTTP 403", { status: 403 }],
    ["a quota code -32429", { body: { jsonrpc: "2.0", id: 9, error: { code: -32429, message: "max usage" } } }],
  ] as [string, Reply][])("a DEFINITE pre-processing rejection (%s) does move to the fallback", async (_n, bad) => {
    const net = fakeNet({ [PRIMARY_URL]: bad, [FB1]: { body: { jsonrpc: "2.0", id: 9, result: SIG } } }, { [FB1]: G });
    const r = await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(mk(), SEND, "devnet");
    expect(r).toEqual({ jsonrpc: "2.0", id: 9, result: SIG });
    expect(sentTo(net)).toEqual([PRIMARY_URL, FB1]);
  });

  const DUP = { jsonrpc: "2.0", id: 9, error: { code: -32002, message: "Transaction simulation failed: This transaction has already been processed" } };
  /** FB1 answers sendTransaction with `send`, and getSignatureStatuses with `status`. */
  const dupNet = (send: unknown, status: unknown) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { method: string };
      calls.push(`${url}:${b.method}`);
      const json = (x: unknown) => ({ status: 200, json: async () => x }) as Response;
      if (b.method === "getGenesisHash") return json({ result: G });
      if (url === PRIMARY_URL) return { status: 429, json: async () => ({}) } as Response;
      return b.method === "getSignatureStatuses" ? json(status) : json(send);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };
  const KNOWN = { jsonrpc: "2.0", id: 1, result: { value: [{ slot: 5, confirmations: 1, err: null }] } };

  it("'already processed' on the re-sent tx is a SUCCESS only with code -32002, the exact phrase AND a known signature", async () => {
    const n = dupNet(DUP, KNOWN);
    expect(await new UpstreamPool({ fetchImpl: n.fetchImpl }).post(mk(), SEND, "devnet")).toEqual({ jsonrpc: "2.0", id: 9, result: SIG });
    expect(n.calls.filter((c) => c.endsWith("getSignatureStatuses"))).toHaveLength(1);
  });

  it.each([
    ["a custom message that merely contains the words", { jsonrpc: "2.0", id: 9, error: { code: -32002, message: "account already processed by custom check" } }],
    ["the right phrase under another code", { jsonrpc: "2.0", id: 9, error: { code: -32000, message: "This transaction has already been processed" } }],
    ["the right code with another message", { jsonrpc: "2.0", id: 9, error: { code: -32002, message: "Transaction simulation failed: custom program error: 0x1b" } }],
    ["a client-influenced echo of the words in a different error", { jsonrpc: "2.0", id: 9, error: { code: -32602, message: "invalid param: already been processed" } }],
  ])("%s is NOT a success: the upstream's error goes back unchanged", async (_n, err) => {
    const n = dupNet(err, KNOWN);
    expect(await new UpstreamPool({ fetchImpl: n.fetchImpl }).post(mk(), SEND, "devnet")).toEqual(err);
    expect(n.calls.some((c) => c.endsWith("getSignatureStatuses"))).toBe(false);
  });

  it("the exact error but the signature is NOT known to the cluster (or failed): not a success", async () => {
    for (const status of [{ result: { value: [null] } }, { result: { value: [{ err: { InstructionError: [0, "x"] } }] } }]) {
      const n = dupNet(DUP, status);
      expect(await new UpstreamPool({ fetchImpl: n.fetchImpl }).post(mk(), SEND, "devnet")).toEqual(DUP);
    }
  });

  it("a read-only request still fails over on the same ambiguous failures (simulateTransaction too)", async () => {
    for (const method of ["getSlot", "simulateTransaction"]) {
      const net = fakeNet({ [PRIMARY_URL]: { status: 503 } }, { [FB1]: G });
      await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(mk(), { ...REQ, method }, "devnet");
      expect(net.calls.some((c) => c.url === FB1 && c.method === method)).toBe(true);
    }
  });
});

describe("amplification, deadline, redirects", () => {
  it("at most 3 upstream attempts per request, however many fallbacks exist", async () => {
    const env = { DEVNET_RPC_FALLBACK_URLS: "https://a.test,https://b.test,https://c.test,https://d.test" } as unknown as NodeJS.ProcessEnv;
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, env);
    const g = Object.fromEntries(ups.map((u) => [u.url, G]));
    const net = fakeNet(Object.fromEntries(ups.map((u) => [u.url, { status: 503 }])), g);
    await new UpstreamPool({ fetchImpl: net.fetchImpl }).post(ups, REQ, "devnet").catch(() => undefined);
    expect(net.calls.filter((c) => c.method === "getSlot")).toHaveLength(3);
  });

  it("concurrent requests share ONE cluster probe per fallback", async () => {
    const net = fakeNet({ [PRIMARY_URL]: { status: 503 } }, { [FB1]: G });
    const pool = new UpstreamPool({ fetchImpl: net.fetchImpl });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: FB1 } as unknown as NodeJS.ProcessEnv);
    await Promise.all(Array.from({ length: 20 }, () => pool.post(ups, REQ, "devnet")));
    expect(net.calls.filter((c) => c.method === "getGenesisHash")).toHaveLength(1);
  });

  it("an overall deadline: a hung upstream cannot take more than the budget in total", async () => {
    let t = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      t += 8_000; // each hung attempt burns 8 s of (fake) time
      void init;
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const calls: number[] = [];
    const counting = (async (u: string, i: RequestInit) => {
      calls.push(t);
      return fetchImpl(u, i);
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl: counting, now: () => t, deadlineMs: 20_000, maxAttempts: 9 });
    const ups = buildUpstreams("devnet", { url: PRIMARY_URL, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv);
    const many = [ups[0]!, { ...ups[0]!, id: "x2", primary: true }, { ...ups[0]!, id: "x3", primary: true }, { ...ups[0]!, id: "x4", primary: true }];
    await pool.post(many, REQ, "devnet").catch(() => undefined);
    expect(calls.length).toBeLessThanOrEqual(3); // 0 s, 8 s, 16 s start; the 4th would start at 24 s > the 20 s budget
  });

  it("redirects are refused (redirect: 'error') and the abort signal is honoured", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return { status: 200, json: async () => ({ result: 1 }) } as Response;
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl });
    await pool.post(mk(), REQ, "devnet");
    expect(seen[0]!.redirect).toBe("error");
    const ac = new AbortController();
    ac.abort();
    await expect(pool.post(mk(), REQ, "devnet", { signal: ac.signal })).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(seen).toHaveLength(1);
  });
});
