/**
 * /api/markets and /api/markets/[slab] wrote insurance_fund 0 when they couldn't read the market's
 * engine stats (a failed batched read, a parse error, the static devnet rows), so Earn and my-markets
 * showed a real "$0" for a fund nobody had read. Unknown is null now.
 * Real GET handler on a live devnet account; only Supabase, the RPC connection and (to force the
 * failure) the SDK's market-group parser are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const FX = path.join(__dirname, "..", "fixtures");
function load(file: string) {
  const j = JSON.parse(fs.readFileSync(path.join(FX, file), "utf8")) as { market: string; dataBase64: string };
  return { slab: j.market, data: new Uint8Array(Buffer.from(j.dataBase64, "base64")) };
}
const ANSEM = load("5bVTTMRc.ansem.market.json"); // 1000 bps -> 10x

const state = vi.hoisted(() => ({ row: {} as Record<string, unknown>, data: new Uint8Array(0), failOi: false }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const actual = await orig<typeof import("@percolatorct/sdk")>();
  return {
    ...actual,
    parseMarketGroupV17OI: (d: Uint8Array) => {
      if (state.failOi) throw new Error("bad market group");
      return actual.parseMarketGroupV17OI(d);
    },
  };
});

// No database (the contributor setup): the route reads the market straight from chain (onChainSlabFallback).
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => { throw new Error("Supabase not configured"); },
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    // Owned by the CURRENT wrapper (the route 404s any other owner since the relaunch).
    getAccountInfo: async () => {
      const { getConfig } = await vi.importActual<typeof import("@/lib/config")>("@/lib/config");
      const programId = getConfig().programId;
      return { data: Buffer.from(state.data), owner: { toBase58: () => programId } };
    },
  }),
}));
vi.mock("@/lib/lp-portfolio", () => ({ getMarketLpCapital: async () => null }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { GET } from "@/app/api/markets/[slab]/route";

async function call(m: { slab: string; data: Uint8Array }) {
  state.row = { slab_address: m.slab, symbol: "X", max_leverage: 10, last_price: 1, mark_price: 1, index_price: null, network: "devnet" };
  state.data = m.data;
  const res = await GET(new NextRequest(`http://x/api/markets/${m.slab}`), { params: Promise.resolve({ slab: m.slab }) });
  return (await res.json()).market as Record<string, unknown>;
}

describe("insurance when the engine stats can't be read", () => {
  beforeEach(() => { vi.clearAllMocks(); state.failOi = false; });

  it("/api/markets/[slab]: a failed parse leaves insurance unknown, not 0", async () => {
    state.failOi = true;
    const m = await call(ANSEM);
    expect(m.insurance_fund).toBeNull();
    expect(m.insurance_balance).toBeNull();
  });

  it("CONTROL: a readable market reports its insurance balance", async () => {
    const m = await call(ANSEM);
    expect(typeof m.insurance_fund).toBe("number");
  });

  it("/api/markets: the failed-read discovery row and the static devnet rows carry null, not 0", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "markets", "route.ts"), "utf8");
    expect(src).toContain("const insurance = v17Oi ? Number(v17Oi.insuranceBalance) : null;");
    expect(src).toMatch(/insurance_fund: null,\s*insurance_balance: null,/);
  });
});
