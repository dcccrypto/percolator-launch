/**
 * Both faucets announce a landed claim with invalidateWalletBalance(), so the cards that gate on
 * the wallet balance ("Create Trading Account", "Get Tokens to Trade") re-read it. A refused or
 * failed claim announces nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ invalidate: vi.fn() }));
const WALLET = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

// The faucet hook reads the portfolio for its open-position gate; this test builds a new connection every render, which the real scan would reload forever.
vi.mock("@/hooks/usePortfolio", async () => await import("../hooks/helpers/portfolio-mock"));
vi.mock("@/lib/wallet-balance-invalidation", () => ({ invalidateWalletBalance: h.invalidate }));
vi.mock("@/lib/config", () => ({
  getNetwork: () => "devnet",
  getConfig: () => ({ testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" }),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: WALLET, connected: true }),
  useConnectionCompat: () => ({
    connection: {
      getBalance: vi.fn().mockResolvedValue(0),
      getTokenAccountBalance: vi.fn().mockRejectedValue(new Error("could not find account")),
    },
  }),
}));

import { DevnetTokenFaucetButton } from "@/components/trade/DevnetTokenFaucetButton";
import { useDevnetFaucet } from "@/hooks/useDevnetFaucet";

const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  h.invalidate.mockReset();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("trade-page faucet button", () => {
  const click = () => {
    render(<DevnetTokenFaucetButton mintAddress="DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs" symbol="Sim-USDC" />);
    fireEvent.click(screen.getByRole("button"));
  };
  it("a landed claim announces the balance change once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { amount: 10_000, signature: "sig1" })));
    click();
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
  });
  it("a refused claim (429) announces nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { error: "Too many requests." })));
    click();
    await waitFor(() => expect(screen.getByText(/Too many requests/i)).toBeInTheDocument());
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

describe("faucet modal (useDevnetFaucet.airdropUsdc)", () => {
  it("a landed USDC airdrop announces the balance change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ funded: true }), { status: 200 })));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => {
      await result.current.airdropUsdc();
    });
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });
  it("a failed airdrop announces nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 500 })));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => {
      await result.current.airdropUsdc();
    });
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
