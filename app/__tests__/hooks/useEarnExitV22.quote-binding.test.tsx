/**
 * Review F6: the exit quote is bound to {market, program, mint, domain, shares, mode, wallet} and to time.
 * A quote for 100 shares can never sign 1,000; an old quote cannot sign.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const conn = { getProgramAccounts: vi.fn(async () => []), getMultipleAccountsInfo: vi.fn(async () => []) };
const quoteExit = vi.fn();
const sendExit = vi.fn();
vi.mock("@/lib/v22/earn-exit-run", () => ({ quoteExit: (...a: unknown[]) => quoteExit(...a), sendExit: (...a: unknown[]) => sendExit(...a), withExitBudget: (x: unknown) => x }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: pk(9) }), useConnectionCompat: () => ({ connection: conn }) }));
vi.mock("@/lib/limits/earn-p3-read", () => ({ readEarnP3Context: async () => ({ bound: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddress: async () => pk(7) }));
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<Record<string, unknown>>()), deriveVaultAuthority: () => [pk(5), 1], deriveInsuranceLpMint: () => [pk(6), 1] }));
vi.mock("@/lib/tx-v1/user-bundle", () => ({ sendUserBundle: vi.fn() }));

import { useEarnExitV22, __clock } from "@/hooks/useEarnExitV22";
import { EXIT_QUOTE_MAX_AGE_MS } from "@/lib/v22/exit-quote-binding";

const base = { market: pk(1), programId: pk(2), collateralMint: pk(3), sourceDomain: 0, mode: "pair" as const, estimateAtoms: 0n };
const q = (minPayout: bigint) => ({ mode: "pair", quote: minPayout + 1n, minPayout, staleCount: 0, refreshSelected: 0, refreshDeferred: 0, computeUnits: 400_000, estimate: false });
let now = 1_000_000;

beforeEach(() => {
  quoteExit.mockReset();
  sendExit.mockReset();
  quoteExit.mockImplementation(async (input: { ctx: { shares: bigint } }) => ({ status: "quoted", quote: q(input.ctx.shares * 1000n) }));
  sendExit.mockResolvedValue({ status: "sent", quote: q(1n), signature: "sig" });
  now = 1_000_000;
  __clock.now = () => now;
});
afterEach(() => {
  __clock.now = () => Date.now();
});

describe("exit quote binding", () => {
  it("quote 100 shares, edit to 1000: the quote is gone, confirm refuses and sends nothing", async () => {
    const { result, rerender } = renderHook((p: { shares: bigint }) => useEarnExitV22({ ...base, shares: p.shares }), { initialProps: { shares: 100n } });
    await act(async () => void (await result.current.getQuote()));
    expect(result.current.state.phase).toBe("quoted");
    const staleConfirm = result.current.confirm; // the handler a stale button could still hold
    rerender({ shares: 1000n });
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.quote).toBeNull();
    await act(async () => {
      await expect(staleConfirm()).rejects.toThrow(/out of date/); // the old closure still holds the 100-share quote: refused
    });
    await act(async () => {
      await expect(result.current.confirm()).resolves.toBeUndefined();
    });
    expect(sendExit).not.toHaveBeenCalled();
  });

  it("a quote older than the max age cannot sign (confirm throws, state resets)", async () => {
    const { result } = renderHook(() => useEarnExitV22({ ...base, shares: 100n }));
    await act(async () => void (await result.current.getQuote()));
    now += EXIT_QUOTE_MAX_AGE_MS + 1;
    await act(async () => {
      await expect(result.current.confirm()).rejects.toThrow(/out of date/);
    });
    expect(sendExit).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("idle");
  });

  it("CONTROL: unchanged inputs and a fresh quote still send, with the quoted floor", async () => {
    const { result } = renderHook(() => useEarnExitV22({ ...base, shares: 100n }));
    await act(async () => void (await result.current.getQuote()));
    now += 5_000;
    await act(async () => void (await result.current.confirm()));
    expect(sendExit).toHaveBeenCalledTimes(1);
    expect(sendExit.mock.calls[0][1].minPayout).toBe(100_000n);
  });

  it("changing the mode (or the pot) also drops the quote", async () => {
    const { result, rerender } = renderHook((p: { mode: "pair" | "request" }) => useEarnExitV22({ ...base, shares: 100n, mode: p.mode }), { initialProps: { mode: "pair" as "pair" | "request" } });
    await act(async () => void (await result.current.getQuote()));
    rerender({ mode: "request" });
    expect(result.current.state.quote).toBeNull();
  });
});

import { makeStaleReader } from "@/lib/v22/stale-scan";
describe("F14 one scan per exit", () => {
  const cand = (n: number) => ({ key: pk(n) });
  it("scans once, then retries re-read only the scanned accounts", async () => {
    const scan = vi.fn(async () => [{ pubkey: pk(1), data: new Uint8Array() }, { pubkey: pk(2), data: new Uint8Array() }]);
    const fetchMany = vi.fn(async (keys: PublicKey[]) => keys.slice(0, 1).map((k) => ({ pubkey: k, data: new Uint8Array() })));
    const r = makeStaleReader({ scan, fetchMany, toCandidates: (rows) => rows.map((x) => cand(x.pubkey.toBytes()[0])) });
    expect((await r.read()).length).toBe(2);
    expect((await r.read()).length).toBe(1); // one of them was refreshed meanwhile
    await r.read();
    await r.read();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(fetchMany).toHaveBeenCalledTimes(3);
    expect(fetchMany.mock.calls[0][0].length).toBe(2);
  });
  it("an empty first scan never re-scans or fetches", async () => {
    const scan = vi.fn(async () => []);
    const fetchMany = vi.fn(async () => []);
    const r = makeStaleReader({ scan, fetchMany, toCandidates: () => [] });
    await r.read();
    await r.read();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(fetchMany).not.toHaveBeenCalled();
  });
});

describe("F14 through the real hook", () => {
  it("quote then confirm (with retries inside) scan with getProgramAccounts once", async () => {
    conn.getProgramAccounts.mockClear();
    quoteExit.mockImplementation(async (_i: unknown, deps: { readStale: () => Promise<unknown[]> }) => {
      await deps.readStale();
      await deps.readStale();
      return { status: "quoted", quote: q(5n) };
    });
    sendExit.mockImplementation(async (_i: unknown, _q: unknown, deps: { readStale: () => Promise<unknown[]> }) => {
      await deps.readStale();
      await deps.readStale();
      return { status: "sent", quote: q(5n), signature: "s" };
    });
    const { result } = renderHook(() => useEarnExitV22({ ...base, shares: 100n }));
    await act(async () => void (await result.current.getQuote()));
    await act(async () => void (await result.current.confirm()));
    expect(conn.getProgramAccounts).toHaveBeenCalledTimes(1);
  });
});

describe("N3 reader: rescan is one fresh scan that replaces the remembered keys", () => {
  it("scans = 1 + rescans; read() after a rescan re-reads the NEW key set", async () => {
    const scan = vi.fn()
      .mockResolvedValueOnce([{ pubkey: pk(1), data: new Uint8Array() }])
      .mockResolvedValueOnce([{ pubkey: pk(1), data: new Uint8Array() }, { pubkey: pk(2), data: new Uint8Array() }]);
    const fetchMany = vi.fn(async (keys: PublicKey[]) => keys.map((k) => ({ pubkey: k, data: new Uint8Array() })));
    const r = makeStaleReader({ scan, fetchMany, toCandidates: (rows) => rows.map((x) => ({ key: x.pubkey })) });
    expect((await r.read()).length).toBe(1);
    expect((await r.rescan()).length).toBe(2);
    expect((await r.read()).length).toBe(2);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(fetchMany.mock.calls[0][0].length).toBe(2);
  });
});
