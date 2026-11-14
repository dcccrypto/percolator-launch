// @vitest-environment node
/** POST /api/v22/trade: validation, the devnet + v2.2 gate, refusal mapping, unsigned base64 output. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({ build: vi.fn(), allowed: true }));
vi.mock("@/lib/upstash-rate-limit", () => ({ createUpstashRateLimiter: () => ({ check: async () => ({ allowed: m.allowed, remaining: 0, retryAfterSecs: 30 }) }) }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({}) }));
vi.mock("@/lib/v22/trade-build", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/trade-build")>()), buildV22Trade: m.build }));

import { GET, POST, parseTradeBody } from "@/app/api/v22/trade/route";
import { TradeBuildRefusal } from "@/lib/v22/trade-build";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const owner = Keypair.generate().publicKey.toBase58();
const market = Keypair.generate().publicKey.toBase58();
const req = (body: unknown) => new NextRequest("http://x/api/v22/trade", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  __setDevnetV22ForTest(true);
  m.build.mockReset();
  m.allowed = true;
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
});

describe("parseTradeBody", () => {
  it("accepts a minimal body and the optional fields", () => {
    const r = parseTradeBody({ owner, market, size: "-2500000", slippageBps: 50, limitPriceE6: "1234", maxFeeBps: "200" });
    expect(typeof r).toBe("object");
    const o = r as Exclude<typeof r, string>;
    expect([o.size, o.slippageBps, o.limitPriceE6, o.maxFeeBps]).toEqual([-2_500_000n, 50n, 1234n, 200n]);
  });
  it.each([
    [null, "object"],
    [{ owner: "nope", market, size: "1" }, "owner"],
    [{ owner, market: "0".repeat(44), size: "1" }, "market"],
    [{ owner, market, size: "0" }, "size"],
    [{ owner, market, size: "1.5" }, "size"],
    [{ owner, market, size: "1e9" }, "size"],
    [{ owner, market, size: "1", slippageBps: 10_001 }, "slippageBps"],
    [{ owner, market, size: "1", limitPriceE6: "0" }, "limitPriceE6"],
    [{ owner, market, size: "1", limitPriceE6: "-5" }, "limitPriceE6"],
    [{ owner, market, size: "1", maxFeeBps: "x" }, "maxFeeBps"],
  ])("refuses %j (%s)", (body, word) => {
    const r = parseTradeBody(body);
    expect(typeof r).toBe("string");
    expect(r as string).toContain(word);
  });
});

describe("route", () => {
  it("403 off devnet and on a non-v2.2 build, nothing built", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    expect((await POST(req({ owner, market, size: "1" }))).status).toBe(403);
    expect((await GET()).status).toBe(403);
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    __setDevnetV22ForTest(false);
    expect((await POST(req({ owner, market, size: "1" }))).status).toBe(403);
    expect(m.build).not.toHaveBeenCalled();
  });

  it("GET describes the endpoint", async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect((await r.json()).method).toBe("POST");
  });

  it("400 on bad JSON and bad fields; 429 when rate limited", async () => {
    expect((await POST(req("{"))).status).toBe(400);
    expect((await POST(req({ owner, market, size: "0" }))).status).toBe(400);
    m.allowed = false;
    const r = await POST(req({ owner, market, size: "1" }));
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("30");
  });

  it("200 returns unsigned base64 transactions that deserialize with the owner as fee payer", async () => {
    const payer = Keypair.generate().publicKey;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
    tx.feePayer = payer;
    tx.recentBlockhash = "11111111111111111111111111111111";
    m.build.mockResolvedValue({ transactions: [{ purpose: "order", transaction: tx, computeUnitLimit: 800_000, unitsConsumed: 280_000 }], resubmitAfter: false, summary: { feeBps: "135" } });
    const r = await POST(req({ owner, market, size: "1000000" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const body = await r.json();
    const back = Transaction.from(Buffer.from(body.transactions[0].transaction, "base64"));
    expect(back.feePayer?.equals(payer)).toBe(true);
    expect(back.signatures.every((s) => s.signature === null)).toBe(true);
    expect(body.summary.feeBps).toBe("135");
  });

  it("maps a refusal to its status, code and logs; an unexpected error to 500 without detail", async () => {
    m.build.mockRejectedValueOnce(new TradeBuildRefusal("no_portfolio", "owner has no portfolio", 409));
    let r = await POST(req({ owner, market, size: "1" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "no_portfolio", message: "owner has no portfolio" });
    m.build.mockRejectedValueOnce(new TradeBuildRefusal("simulation_failed", "Custom 49", 422, ["Program log: x"]));
    r = await POST(req({ owner, market, size: "1" }));
    expect((await r.json()).logs).toEqual(["Program log: x"]);
    m.build.mockRejectedValueOnce(new Error("secret internal detail"));
    r = await POST(req({ owner, market, size: "1" }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret");
  });
});
