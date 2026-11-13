/**
 * Faucet modal "Fund My Account" (fundAll): a failed SOL airdrop was erased when the USDC step ran
 * (airdropUsdc clears the shared error and moves step to "usdc", and the modal marks SOL failed
 * only for error && step === "sol"), and an airdrop never confirmed within the 60s loop fell
 * through to setSolDone(true).
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  airdrop: vi.fn(),
  status: vi.fn(),
}));
const WALLET = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

vi.mock("@solana/web3.js", async (orig) => {
  const actual = await orig<typeof import("@solana/web3.js")>();
  class FakeConnection {
    requestAirdrop = h.airdrop;
    getSignatureStatuses = h.status;
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
vi.mock("@/lib/config", () => ({
  getNetwork: () => "devnet",
  getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }),
}));

import { useDevnetFaucet } from "@/hooks/useDevnetFaucet";

beforeEach(() => {
  h.airdrop.mockReset();
  h.status.mockReset();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  // /api/faucet: the server SOL faucet has no signer here (falls back to the public airdrop);
  // the USDC airdrop succeeds.
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const type = JSON.parse(String(init?.body ?? "{}")).type;
    return type === "usdc"
      ? new Response(JSON.stringify({ funded: true }), { status: 200 })
      : new Response(JSON.stringify({ error: "no signer" }), { status: 500 });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDevnetFaucet.fundAll", () => {
  it("a failed SOL airdrop stays visible on the SOL step after USDC succeeds", async () => {
    h.airdrop.mockRejectedValue(new Error("429 Too Many Requests"));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.fundAll(); });
    expect(result.current.error).toBeTruthy();
    expect(result.current.step).toBe("sol");
  });

  it("an airdrop never confirmed within the minute is not reported as done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.airdrop.mockResolvedValue("sig");
    h.status.mockResolvedValue({ value: [null] });
    const { result } = renderHook(() => useDevnetFaucet());
    let done = false;
    await act(async () => {
      const p = result.current.airdropSol().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(62_000);
      await p;
    });
    expect(done).toBe(true);
    expect(result.current.solDone).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it("CONTROL: a confirmed airdrop is done with no error", async () => {
    h.airdrop.mockResolvedValue("sig");
    h.status.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] });
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropSol(); });
    expect(result.current.solDone).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
