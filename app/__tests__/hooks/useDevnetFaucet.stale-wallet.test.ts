/**
 * The faucet hook is mounted once at the root, so a request started for one wallet can resolve after
 * the user switched to another. airdropUsdc already drops such a reply (#3491); the SOL airdrop and
 * "Fund my account" didn't: the SOL step set the new wallet's error (or marked its SOL done) and went
 * on to request a fallback airdrop for the old wallet, and fundAll continued to the old wallet's USDC.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const B = new PublicKey("DrrDGxiojUPHnLZaNw7DN6JYoEKKqu3bG4PmNjv8P1yG");
const h = vi.hoisted(() => ({ wallet: null as unknown, requestAirdrop: vi.fn(), status: null as null | { confirmationStatus: string; err: null } }));

vi.mock("@solana/web3.js", async (orig) => {
  const actual = await orig<typeof import("@solana/web3.js")>();
  class FakeConnection {
    requestAirdrop = h.requestAirdrop;
    getSignatureStatuses = vi.fn(async () => ({ value: [h.status] }));
  }
  return { ...actual, Connection: FakeConnection };
});
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: h.wallet, connected: true }),
  useConnectionCompat: () => ({
    connection: {
      getBalance: vi.fn().mockResolvedValue(0),
      getTokenAccountBalance: vi.fn().mockRejectedValue(new Error("could not find account")),
    },
  }),
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }) }));

import { useDevnetFaucet } from "@/hooks/useDevnetFaucet";

beforeEach(() => {
  h.wallet = A;
  h.requestAirdrop.mockReset().mockRejectedValue(new Error("429 Too Many Requests"));
  h.status = null;
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** /api/faucet: the SOL request is held open until released, so a wallet switch can happen while it
 *  is in flight; a USDC request answers at once (it is only counted). */
function heldFaucet() {
  const calls: Array<{ type: string; release: (r: Response) => void }> = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    const type = JSON.parse(String(init?.body ?? "{}")).type;
    if (type === "usdc") {
      calls.push({ type, release: () => {} });
      return Promise.resolve(new Response(JSON.stringify({ funded: true }), { status: 200 }));
    }
    return new Promise<Response>((release) => calls.push({ type, release }));
  }));
  return calls;
}

describe("a SOL airdrop that resolves after a wallet switch", () => {
  it("leaves the new wallet's state alone and requests no fallback airdrop for the old one", async () => {
    const calls = heldFaucet();
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    let pending!: Promise<void>;
    act(() => { pending = result.current.airdropSol(); });
    h.wallet = B;
    await act(async () => { rerender(); });
    await act(async () => {
      calls[0].release(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
      await pending;
    });
    expect(h.requestAirdrop).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.solDone).toBe(false);
  });
});

describe("Fund my account across a wallet switch", () => {
  it("stops after the step in flight: no USDC request for the old wallet", async () => {
    const calls = heldFaucet();
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    let pending!: Promise<void>;
    act(() => { pending = result.current.fundAll(); });
    h.wallet = B;
    await act(async () => { rerender(); });
    await act(async () => {
      calls[0].release(new Response(JSON.stringify({ signature: "sig1" }), { status: 200 }));
      await pending;
    });
    expect(calls.map((c) => c.type)).toEqual(["sol"]);
    expect(result.current.step).not.toBe("done");
  });
});

describe("a fallback airdrop that settles after a wallet switch", () => {
  async function switchDuringFallback(settle: (release: { ok: (sig: string) => void; fail: (e: Error) => void }) => void) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    let release!: { ok: (sig: string) => void; fail: (e: Error) => void };
    h.requestAirdrop.mockImplementation(() => new Promise<string>((ok, fail) => { release = { ok, fail }; }));
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    let pending!: Promise<void>;
    act(() => { pending = result.current.airdropSol(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // reach the fallback
    expect(h.requestAirdrop).toHaveBeenCalledTimes(1);
    h.wallet = B;
    await act(async () => { rerender(); });
    await act(async () => { settle(release); await pending; });
    return result;
  }

  it("a failure for the old wallet sets no error on the new one", async () => {
    const result = await switchDuringFallback((r) => r.fail(new Error("airdrop failed")));
    expect(result.current.error).toBeNull();
  });

  it("a confirmed airdrop for the old wallet does not mark the new one's SOL done", async () => {
    h.status = { confirmationStatus: "confirmed", err: null };
    const result = await switchDuringFallback((r) => r.ok("sig-old"));
    expect(result.current.solDone).toBe(false);
  });
});
