/**
 * S18 + S20: the faucet modal's "Rate limited" state.
 * - S20: every 429 from /api/faucet was read as "Already claimed in the last 24 hours" and latched the
 *   USDC button off. Only the per-wallet daily gate carries `nextClaimAt`; the per-IP fund limit
 *   (10 a minute) sends Retry-After, and is short.
 * - S18: the hook is mounted once at the root, and its wallet-change reset left `rateLimited`,
 *   `nextClaimAt` and `error` from the previous wallet, so a new wallet's claim stayed disabled.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shortRateLimitMessage } from "@/lib/faucet-429";

const A = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const B = new PublicKey("DrrDGxiojUPHnLZaNw7DN6JYoEKKqu3bG4PmNjv8P1yG");
const h = vi.hoisted(() => ({ wallet: null as unknown }));

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

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
const DAILY = { error: "Already claimed in the last 24 hours", funded: false, nextClaimAt: "2026-10-14T12:00:00.000Z" };
const PER_IP = { error: "Too many requests. Please slow down and try again shortly." };

beforeEach(() => {
  h.wallet = A;
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("USDC airdrop 429s (S20)", () => {
  it("the per-IP limit says to retry shortly and does not latch 'Rate limited'", async () => {
    vi.stubGlobal("fetch", reply(429, PER_IP, { "Retry-After": "42" }));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropUsdc(); });
    expect(result.current.rateLimited).toBe(false);
    expect(result.current.error).toBe("Too many requests. Try again in 42s.");
  });

  it("CONTROL: the daily gate still latches with its next-claim time", async () => {
    vi.stubGlobal("fetch", reply(429, DAILY));
    const { result } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropUsdc(); });
    expect(result.current.rateLimited).toBe(true);
    expect(result.current.nextClaimAt).toBe(DAILY.nextClaimAt);
    expect(result.current.error).toBe("Already claimed in the last 24 hours");
  });
});

describe("a wallet switch clears the previous wallet's claim state (S18)", () => {
  it("rateLimited, nextClaimAt and the error reset for the new wallet", async () => {
    vi.stubGlobal("fetch", reply(429, DAILY));
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    await act(async () => { await result.current.airdropUsdc(); });
    expect(result.current.rateLimited).toBe(true);
    h.wallet = B;
    await act(async () => { rerender(); });
    expect(result.current.rateLimited).toBe(false);
    expect(result.current.nextClaimAt).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("shortRateLimitMessage", () => {
  const r = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });
  it("only a 429 without nextClaimAt is the short limit", () => {
    expect(shortRateLimitMessage(r(429, { "Retry-After": "5" }), {})).toBe("Too many requests. Try again in 5s.");
    expect(shortRateLimitMessage(r(429), {})).toBe("Too many requests. Try again in a minute.");
    expect(shortRateLimitMessage(r(429), { nextClaimAt: "2026-10-14T00:00:00Z" })).toBeNull();
    expect(shortRateLimitMessage(r(500), {})).toBeNull();
  });
});

describe("a reply for the previous wallet (S18 review)", () => {
  it("an airdrop that resolves after a wallet switch doesn't rate-limit the new wallet", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = r; })));
    const { result, rerender } = renderHook(() => useDevnetFaucet());
    let pending!: Promise<void>;
    act(() => { pending = result.current.airdropUsdc(); });
    h.wallet = B;
    await act(async () => { rerender(); });
    await act(async () => {
      release(new Response(JSON.stringify(DAILY), { status: 429 }));
      await pending;
    });
    expect(result.current.rateLimited).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.usdcDone).toBe(false);
  });
});
