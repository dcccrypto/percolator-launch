/**
 * settleMarket (the admin's "Settle and withdraw everything"): refuses before anything is signed unless the market is Live, not stale,
 * and nobody but this wallet and the Earn vault holds anything. Real v2.2 bytes (CHILLHOUSE-T market, QA flat-winner portfolio).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { EARN_FLOOR_COPY } from "@/lib/v22/resolved-claims";

const fx = (f: string): Record<string, string> => JSON.parse(readFileSync(path.join(__dirname, "../fixtures", f), "utf8")) as Record<string, string>;
const WALLET = new PublicKey("EXC8LS3YzsbyadhaQPqaeGjb2ttfGgDLno9jeCFWqqyi");
const SLAB = new PublicKey("GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL");
const GROUP = 592;

function market(o: { mode?: number; marketauth?: PublicKey } = {}): Uint8Array {
  const d = new Uint8Array(Buffer.from(fx("v22-growth/chillhouse-t.market.json").data!, "base64"));
  d[GROUP + 674] = o.mode ?? 0;
  d.set((o.marketauth ?? WALLET).toBytes(), 16);
  return d;
}
const lastGood = (d: Uint8Array): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(16 + 152, true);
const portfolio = (): Uint8Array => new Uint8Array(Buffer.from(fx("v22-flat-winner-portfolio-2026-10-11.json").b64!, "base64"));

const h = vi.hoisted(() => ({
  info: null as { data: Uint8Array; owner: unknown; lamports: number } | null,
  slot: 0n,
  accounts: [] as { pubkey: unknown; account: { data: Uint8Array } }[] | "throw",
  gate: vi.fn(),
  sendTx: vi.fn(),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: WALLET, signTransaction: vi.fn() }),
  useConnectionCompat: () => ({
    connection: {
      getAccountInfo: async () => h.info,
      getSlot: async () => Number(h.slot),
      getProgramAccounts: async () => {
        if (h.accounts === "throw") throw new Error("rpc");
        return h.accounts;
      },
    },
  }),
}));
// jsdom's TextEncoder breaks PDA derivation (cross-realm Uint8Array); the registry PDA is only compared by address here.
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<object>()), deriveLpVaultRegistry: () => [new PublicKey("11111111111111111111111111111112"), 255] }));
vi.mock("@/lib/pre-resolve", () => ({ readAndPlanPreResolve: (...a: unknown[]) => h.gate(...a) }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<object>()), sendTx: (...a: unknown[]) => h.sendTx(...a), simulateForGate: async () => ({ err: null, logs: [], simulated: [] }) }));

import { useCloseMarket } from "@/hooks/useCloseMarket";

const run = async (): Promise<{ result: unknown; error: string | null }> => {
  const { result } = renderHook(() => useCloseMarket());
  let r: unknown;
  await act(async () => {
    r = await result.current.settleMarket(SLAB.toBase58());
  });
  return { result: r, error: result.current.error };
};
const setMarket = (d: Uint8Array, slotOffset = 100n) => {
  h.info = { data: d, owner: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"), lamports: 1 };
  h.slot = lastGood(d) + slotOffset;
};

beforeEach(() => {
  __setDevnetV22ForTest(true);
  h.accounts = [];
  h.gate.mockReset();
  h.gate.mockResolvedValue({ blockers: ["gate reached"], warnings: [], cranks: [] });
  h.sendTx.mockReset();
});
afterAll(() => __setDevnetV22ForTest(null));

describe("settleMarket refusals (nothing is signed or sent)", () => {
  it("Recovery (mode 2) is not 'already settled': it says the market is winding down", async () => {
    setMarket(market({ mode: 2 }));
    const r = await run();
    expect(r.result).toBeNull();
    expect(r.error).toBe(EARN_FLOOR_COPY.refuse.recovery);
  });
  it("an already Resolved market sends nothing and is not an error", async () => {
    setMarket(market({ mode: 1 }));
    expect(await run()).toEqual({ result: { signature: null }, error: null });
  });
  it("a market whose price has stopped is routed to the market page's Settle (tag 39), not resolved by the admin", async () => {
    setMarket(market(), 20_000n);
    const r = await run();
    expect(r.result).toEqual({ signature: null, route: "stale" });
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.sendTx).not.toHaveBeenCalled();
  });
  it("refuses while another user holds a position", async () => {
    setMarket(market());
    h.accounts = [{ pubkey: PublicKey.default, account: { data: portfolio() } }]; // owned by 6Rz2…, with capital
    const r = await run();
    expect(r.result).toBeNull();
    expect(r.error).toBe(EARN_FLOOR_COPY.refuse.others);
    expect(h.gate).not.toHaveBeenCalled();
  });
  it("refuses when the portfolio scan fails (cannot prove nobody else is in)", async () => {
    setMarket(market());
    h.accounts = "throw";
    const r = await run();
    expect(r.error).toBe(EARN_FLOOR_COPY.refuse.unreadable);
    expect(h.sendTx).not.toHaveBeenCalled();
  });
  it("only the market admin can settle", async () => {
    setMarket(market({ marketauth: PublicKey.default }));
    expect((await run()).error).toMatch(/Only the market admin/);
  });
  it("CONTROL: nobody else in the market gets past the refusals to the pre-resolve gate", async () => {
    setMarket(market());
    const r = await run();
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/Can't settle yet: gate reached/);
  });
});
