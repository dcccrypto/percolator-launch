/**
 * S19: the faucet modal's SOL step ignored /api/faucet's 503 `{ pending: true, signature }`: the server
 * sent the SOL but couldn't confirm it in time, and counts that as the claim (route L-1, never re-send).
 * The hook fell through to a public airdrop, and its failure showed "SOL airdrop failed" while the
 * first airdrop was landing.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WALLET = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const h = vi.hoisted(() => ({ requestAirdrop: vi.fn() }));

vi.mock("@solana/web3.js", async (orig) => {
  const actual = await orig<typeof import("@solana/web3.js")>();
  class FakeConnection {
    requestAirdrop = h.requestAirdrop;
    getSignatureStatuses = vi.fn(async () => ({ value: [null] }));
  }
  return { ...actual, Connection: FakeConnection };
});
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: WALLET, connected: true }),
  useConnectionCompat: () => ({
    connection: {
      getBalance: vi.fn().mockResolvedValue(0),
      getTokenAccountBalance: vi.fn().mockRejectedValue(new Error("could not find account")),
    },
  }),
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }) }));

import { useDevnetFaucet } from "@/hooks/useDevnetFaucet";

const PENDING = {
  error: "Your test SOL is on its way but not confirmed yet. Check your balance in a minute before trying again.",
  pending: true,
  retryable: false,
  signature: "pendingsig99",
};

beforeEach(() => {
  h.requestAirdrop.mockReset().mockRejectedValue(new Error("429 Too Many Requests"));
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("SOL step, server grant pending (S19)", () => {
  it("says it's on its way and requests no second airdrop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(PENDING), { status: 503 })));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropSol(); });
    expect(h.requestAirdrop).not.toHaveBeenCalled();
    expect(result.current.error).toBe(PENDING.error);
    expect(result.current.error).not.toMatch(/failed/i);
    expect(result.current.solDone).toBe(false); // not done until the balance shows it
  });

  it("CONTROL: a plain server failure still falls back to the public airdrop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropSol(); });
    expect(h.requestAirdrop).toHaveBeenCalled(); // public (and Helius, if a key is set)
    expect(result.current.error).not.toBe(PENDING.error);
  });
});

// Follow-up: the server counts a pending send as the claim, so a retry before the SOL lands got the
// daily-claim 429 and fell through to a public airdrop anyway (a second airdrop, and usually a
// rate-limit failure over the first one's "on its way").
describe("retrying while the server's send is pending", () => {
  const DAILY = { error: "Already claimed in the last 24 hours", funded: false, nextClaimAt: "2026-10-17T00:00:00.000Z" };

  it("re-shows 'on its way' and requests nothing else", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PENDING), { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify(DAILY), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropSol(); });
    await act(async () => { await result.current.airdropSol(); }); // the retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.requestAirdrop).not.toHaveBeenCalled();
    expect(result.current.error).toBe(PENDING.error);
  });

  it("after the window a retry goes through the normal path again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(PENDING), { status: 503 }))
        .mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useDevnetFaucet());
      await act(async () => { await result.current.airdropSol(); });
      vi.setSystemTime(Date.now() + 121_000);
      await act(async () => { await result.current.airdropSol(); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(h.requestAirdrop).toHaveBeenCalled(); // public (and Helius, if a key is set)
    } finally {
      vi.useRealTimers();
    }
  });
});
