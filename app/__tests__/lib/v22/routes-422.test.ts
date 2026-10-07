/**
 * Flag ON: a market account with a wrapper VERSION this build does not decode is answered with HTTP 422 and the
 * calm `unsupported_layout` body (never a 500, never partial numbers). Flag OFF: unchanged (404 "Market not found").
 * v2.2 and v2.1 markets keep working under the flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LAYOUT_V21, LAYOUT_V22 } from "@/lib/v22/sdk";
import { stampHeader, syntheticMarket } from "./_stamp";

const PROGRAM = Keypair.generate().publicKey;
const state: { data: Uint8Array | null } = { data: null };

vi.mock("@/lib/config", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getConfig: () => ({ programId: PROGRAM.toBase58() }) }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async () => (state.data ? { owner: PROGRAM, data: Buffer.from(state.data), lamports: 1, executable: false } : null),
  }),
}));

const slab = Keypair.generate().publicKey.toBase58();
const ctx = { params: Promise.resolve({ slab }) };
const unknown = () => stampHeader(new Uint8Array(4200), 1, 20);

beforeEach(() => { state.data = null; });
afterEach(() => __setDevnetV22ForTest(null));

describe("single-market routes: unknown VERSION", () => {
  it("insurance: 422 under the flag, 404 with it off", async () => {
    const { GET } = await import("@/app/api/insurance/[slab]/route");
    state.data = unknown();
    __setDevnetV22ForTest(true);
    const r = await GET(new Request("http://x"), ctx);
    expect(r.status).toBe(422);
    const b = await r.json();
    expect(b.error).toBe("unsupported_layout");
    expect(b.version).toBe(20);
    expect(JSON.stringify(b)).not.toMatch(/balance|totalRisk/);
    __setDevnetV22ForTest(false);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });
  it("open-interest: 422 under the flag", async () => {
    const { GET } = await import("@/app/api/open-interest/[slab]/route");
    state.data = unknown();
    __setDevnetV22ForTest(true);
    const r = await GET(new Request("http://x") as never, ctx);
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe("unsupported_layout");
  });
  it("funding: 422 under the flag", async () => {
    const { GET } = await import("@/app/api/funding/[slab]/route");
    state.data = unknown();
    __setDevnetV22ForTest(true);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(422);
  });
});

describe("single-market routes: known VERSIONs still serve under the flag", () => {
  it.each([["v2.2", LAYOUT_V22], ["v2.1", LAYOUT_V21]])("insurance reads a %s market", async (_n, L) => {
    const { GET } = await import("@/app/api/insurance/[slab]/route");
    state.data = syntheticMarket(L, 1, { insurance: 5_000_000n });
    __setDevnetV22ForTest(true);
    const r = await GET(new Request("http://x"), ctx);
    expect(r.status).toBe(200);
    expect((await r.json()).balance).toBe("5000000");
  });
  it("NEGATIVE CONTROL: the same v2.2 bytes are NOT served with the flag off", async () => {
    const { GET } = await import("@/app/api/insurance/[slab]/route");
    state.data = syntheticMarket(LAYOUT_V22, 1, { insurance: 5_000_000n });
    __setDevnetV22ForTest(false);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });
});
