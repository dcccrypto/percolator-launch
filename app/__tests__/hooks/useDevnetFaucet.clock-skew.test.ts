/**
 * Clock skew: the faucet's two time windows (24h "dismissed" stamp from localStorage, 2-minute
 * server-pending note) compared `Date.now() - ts < window`. A stamp in the future (clock was ahead
 * when written, then corrected) made the difference negative, so the window never closed.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
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
vi.mock("@/hooks/usePortfolio", async () => await import("./helpers/portfolio-mock"));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }) }));

import { useDevnetFaucet } from "@/hooks/useDevnetFaucet";

const store: Record<string, string> = {};
const PENDING = { error: "on its way", pending: true, retryable: false, signature: "sig" };
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  h.requestAirdrop.mockReset().mockRejectedValue(new Error("429"));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("dismissed stamp", () => {
  const seed = (ts: number) => { store[`percolator:faucet-dismissed:${WALLET.toBase58()}`] = String(ts); };

  it("CONTROL: a fresh stamp keeps the modal dismissed", async () => {
    seed(Date.now() - 1000);
    const { result } = renderHook(() => useDevnetFaucet());
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.shouldShow).toBe(false);
  });

  it("a stamp from the future does not keep the modal dismissed", async () => {
    seed(Date.now() + 30 * DAY);
    const { result } = renderHook(() => useDevnetFaucet());
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
  });
});

describe("server-pending note", () => {
  it("a clock stepped back does not pin the pending message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PENDING), { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropSol(); });
    vi.setSystemTime(Date.now() - 3 * 60 * 60 * 1000);
    await act(async () => { await result.current.airdropSol(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
