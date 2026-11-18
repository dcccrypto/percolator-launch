// @vitest-environment node
/**
 * Branch coverage for lib/rpc-upstreams.ts: defaults, bad/odd inputs, failover order, all-upstreams-failing, and the
 * guarantee that no URL / key reaches a log line. All hosts and keys are fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import {
  CLUSTER_GENESIS,
  UpstreamPool,
  UpstreamRateLimitedError,
  UpstreamUnavailableError,
  __setSharedUpstreamPoolForTest,
  buildUpstreams,
  isQuotaBody,
  parseFallbackUrls,
  redactJson,
  redactText,
  safeErrorText,
  secretsOf,
  sendTransactionSignature,
  sharedUpstreamPool,
  type UpstreamSpec,
} from "@/lib/rpc-upstreams";

const PRIMARY_URL = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const FB1 = "https://rpc.fallback-one.test/SECRETPATHTOKEN1234567890";
const FB2 = "https://rpc.fallback-two.test/?token=FALLBACKTWOKEY12345";
const G = CLUSTER_GENESIS.devnet;
const REQ = { jsonrpc: "2.0", id: 7, method: "getSlot", params: [] };
const ENV = { DEVNET_RPC_FALLBACK_URLS: `${FB1},${FB2}` } as unknown as NodeJS.ProcessEnv;
const mk = (env = ENV) => buildUpstreams("devnet", { url: PRIMARY_URL, headers: { "Content-Type": "application/json" } }, env);
const KEYS = ["PRIMARYKEY-0123456789", "SECRETPATHTOKEN1234567890", "FALLBACKTWOKEY12345", "primary-rpc.test", "fallback-one.test", "fallback-two.test"];

const ok = (json: unknown, status = 200) => ({ status, json: async () => json }) as Response;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __setSharedUpstreamPoolForTest(null);
});

describe("isQuotaBody / parse edge cases", () => {
  it("non-object bodies are not quota answers", () => {
    expect(isQuotaBody(null)).toBe(false);
    expect(isQuotaBody("x")).toBe(false);
    expect(isQuotaBody(undefined)).toBe(false);
  });
  it("bad and duplicate env URLs are dropped; undefined is empty", () => {
    expect(parseFallbackUrls(undefined)).toEqual([]);
    expect(parseFallbackUrls("https://, https://a.test,https://a.test,javascript:alert(1)")).toEqual(["https://a.test"]);
  });
  it("a fallback equal to the primary is dropped; bad entries never become upstreams", () => {
    const env = { DEVNET_RPC_FALLBACK_URLS: `${PRIMARY_URL},nonsense,http://plain.test,${FB1},${FB1}` } as unknown as NodeJS.ProcessEnv;
    expect(mk(env).map((u) => u.url)).toEqual([PRIMARY_URL, FB1]);
  });
});

describe("sendTransactionSignature", () => {
  const sigBytes = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
  const tx = (count: number, len = 65) => {
    const b = new Uint8Array(len);
    b[0] = count;
    b.set(sigBytes.subarray(0, Math.min(64, len - 1)), 1);
    return b;
  };
  it("defaults to base58 when no encoding is given", () => {
    expect(sendTransactionSignature({ params: [bs58.encode(tx(1))] })).toBe(bs58.encode(sigBytes));
  });
  it("reads base64 when asked", () => {
    expect(sendTransactionSignature({ params: [Buffer.from(tx(1)).toString("base64"), { encoding: "base64" }] })).toBe(bs58.encode(sigBytes));
  });
  it("returns null for missing / non-string / malformed payloads", () => {
    expect(sendTransactionSignature({})).toBeNull();
    expect(sendTransactionSignature({ params: [123] })).toBeNull();
    expect(sendTransactionSignature({ params: [bs58.encode(tx(0))] })).toBeNull();
    expect(sendTransactionSignature({ params: [bs58.encode(tx(200))] })).toBeNull();
    expect(sendTransactionSignature({ params: [bs58.encode(tx(1, 10))] })).toBeNull();
    expect(sendTransactionSignature({ params: ["0OIl-not-base58"] })).toBeNull();
    expect(sendTransactionSignature({ params: [""] })).toBeNull(); // empty: no count byte
    expect(sendTransactionSignature(null)).toBeNull(); // throws inside, caught
  });
});

describe("pool defaults and shared instance", () => {
  it("uses the global fetch and console.warn by default; the shared pool is a singleton that can be swapped", async () => {
    const f = vi.fn(async () => ok({ jsonrpc: "2.0", id: 7, result: 1 }));
    vi.stubGlobal("fetch", f);
    const pool = new UpstreamPool();
    expect(await pool.post(mk(), REQ, "devnet")).toEqual({ jsonrpc: "2.0", id: 7, result: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(PRIMARY_URL);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      const m = (JSON.parse(String(init?.body)) as { method: string }).method;
      return m === "getGenesisHash" ? ok({ result: CLUSTER_GENESIS.mainnet }) : ok({ error: { code: -32429 } });
    });
    await expect(new UpstreamPool().post(mk(), REQ, "devnet")).rejects.toBeInstanceOf(UpstreamRateLimitedError);
    expect(warn).toHaveBeenCalled(); // the default warn is console.warn
    for (const [line] of warn.mock.calls) for (const k of KEYS) expect(String(line)).not.toContain(k);

    const a = sharedUpstreamPool();
    expect(sharedUpstreamPool()).toBe(a);
    const mine = new UpstreamPool();
    __setSharedUpstreamPoolForTest(mine);
    expect(sharedUpstreamPool()).toBe(mine);
  });

  it("a non-numeric status is treated as 200; a live caller signal is combined with the timeout", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(init.signal);
      return { json: async () => ({ result: 5 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    const r = await new UpstreamPool({ fetchImpl }).postRaw(mk(), REQ, "devnet", { signal: ac.signal });
    expect(r.status).toBe(200);
    expect(seen[0]).toBeDefined();
    expect(seen[0]!.aborted).toBe(false);
    ac.abort();
    expect(seen[0]!.aborted).toBe(true);
  });

  it("a non-failure exception from fetch's result still counts as an ambiguous failure and fails over", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(url);
      const m = (JSON.parse(String(init.body)) as { method: string }).method;
      if (url === PRIMARY_URL) return null as unknown as Response; // res.status throws a TypeError
      return m === "getGenesisHash" ? ok({ result: G }) : ok({ result: "fb" });
    }) as unknown as typeof fetch;
    const r = await new UpstreamPool({ fetchImpl }).post(mk(), REQ, "devnet");
    expect(r).toEqual({ result: "fb" });
    expect(calls[0]).toBe(PRIMARY_URL);
    expect(calls).toContain(FB1);
  });
});

describe("already-processed re-send edge cases", () => {
  const SEND = { jsonrpc: "2.0", method: "sendTransaction", params: [Buffer.from(Uint8Array.from([1, ...Array.from({ length: 64 }, (_, i) => i + 1)])).toString("base64"), { encoding: "base64" }] };
  const DUP = { error: { code: -32002, message: "This transaction has already been processed" } };
  const net = (statusReply: () => Response) => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const m = (JSON.parse(String(init.body)) as { method: string }).method;
      if (m === "getGenesisHash") return ok({ result: G });
      if (url === PRIMARY_URL) return { status: 429, json: async () => ({}) } as Response;
      return m === "getSignatureStatuses" ? statusReply() : ok(DUP);
    }) as unknown as typeof fetch;
    return fetchImpl;
  };

  it("a request without an id answers with id null", async () => {
    const r = (await new UpstreamPool({ fetchImpl: net(() => ok({ result: { value: [{ err: null }] } })) }).post(mk(), SEND, "devnet")) as { id: unknown; result: string };
    expect(r.id).toBeNull();
    expect(r.result).toBe(bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1)));
  });

  it("if the signature lookup itself fails, the duplicate is not reported as success", async () => {
    const pool = new UpstreamPool({ fetchImpl: net(() => ({ status: 503, json: async () => ({}) }) as Response) });
    const r = (await pool.post(mk(), SEND, "devnet")) as { error?: { code: number } };
    expect(r.error?.code).toBe(-32002); // passed through unchanged, never turned into a success
  });
});

describe("failover order, all upstreams failing, and log hygiene", () => {
  it("tries primary, then fallbacks in configured order, and throws the generic error when all fail", async () => {
    const order: string[] = [];
    const warn = vi.fn();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const m = (JSON.parse(String(init.body)) as { method: string }).method;
      order.push(`${url === PRIMARY_URL ? "primary" : url === FB1 ? "fb1" : "fb2"}:${m}`);
      if (m === "getGenesisHash") return ok({ result: G });
      return { status: 503, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl, warn });
    const err = await pool.post(mk(), REQ, "devnet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err).not.toBeInstanceOf(UpstreamRateLimitedError);
    expect(order).toEqual(["primary:getSlot", "fb1:getGenesisHash", "fb1:getSlot", "fb2:getGenesisHash", "fb2:getSlot"]);
    expect(safeErrorText(err, mk())).toBe("UpstreamUnavailableError: RPC upstream unavailable");
    expect(warn).not.toHaveBeenCalled(); // no cluster mismatch here, so nothing is logged at all
  });

  it("a wrong-cluster fallback is skipped, warned about without any URL, and the next one answers", async () => {
    const lines: string[] = [];
    const used: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const m = (JSON.parse(String(init.body)) as { method: string }).method;
      if (m === "getGenesisHash") return ok({ result: url === FB1 ? CLUSTER_GENESIS.mainnet : G });
      used.push(url);
      return url === PRIMARY_URL ? ({ status: 429, json: async () => ({}) } as Response) : ok({ result: "from-fb2" });
    }) as unknown as typeof fetch;
    const pool = new UpstreamPool({ fetchImpl, warn: (l) => lines.push(l) });
    expect(await pool.post(mk(), REQ, "devnet")).toEqual({ result: "from-fb2" });
    expect(used).toEqual([PRIMARY_URL, FB2]); // the chosen upstream is fb2, never fb1
    expect(lines).toHaveLength(1);
    for (const l of lines) for (const k of [...KEYS, "https://"]) expect(l).not.toContain(k);
  });

  it("a plain-text 4xx is the request's own fault: no failover at all", async () => {
    const used: string[] = [];
    const fetchImpl = (async (url: string) => {
      used.push(url);
      return { status: 400, json: async () => { throw new SyntaxError("x"); } } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(new UpstreamPool({ fetchImpl }).post(mk(), REQ, "devnet")).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(used).toEqual([PRIMARY_URL]);
  });
});

describe("redaction edge cases", () => {
  it("secretsOf collects credentials, user info, long path segments and query values", () => {
    const ups: UpstreamSpec[] = [{ id: "a", url: "https://user1234:pass5678@creds.test/abcdefghijkl?k=queryvalue99", headers: {}, primary: true }, { id: "b", url: "not a url", headers: {}, primary: false }];
    const s = secretsOf(ups);
    expect(s).toEqual(expect.arrayContaining(["pass5678", "user1234", "abcdefghijkl", "queryvalue99", "creds.test"]));
    expect(s).toContain("not a url");
    const text = redactText("failed https://user1234:pass5678@creds.test/abcdefghijkl?k=queryvalue99 token=abc123", ups);
    for (const x of ["pass5678", "user1234", "queryvalue99", "abc123", "creds.test"]) expect(text).not.toContain(x);
  });

  it("redactJson returns unserialisable data as-is and passes clean data through untouched", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactJson(circular, mk())).toBe(circular);
    const clean = { a: 1 };
    expect(redactJson(clean, mk())).toBe(clean);
    expect(redactJson(undefined, mk())).toBeUndefined();
    const dirty = redactJson({ msg: `see ${FB2} and ${PRIMARY_URL}` }, mk());
    for (const k of KEYS) expect(JSON.stringify(dirty)).not.toContain(k);
  });

  it("safeErrorText stringifies non-Error values, redacts, and caps at 200 chars", () => {
    expect(safeErrorText("plain")).toBe("plain");
    expect(safeErrorText({ toString: () => `boom ${PRIMARY_URL}` }, mk())).not.toContain("PRIMARYKEY");
    expect(safeErrorText(new Error("x".repeat(500)))).toHaveLength(200);
  });
});
