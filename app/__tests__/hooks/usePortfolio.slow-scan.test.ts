/**
 * A slow but working RPC (every scan takes ~40 s, past the 25 s load timeout) must still load the portfolio, and must not
 * pile up overlapping scans: the 30 s refresh joins the scan that is running.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const pk = new PublicKey(new Uint8Array(32).fill(92));
const connection = { getProgramAccounts: vi.fn(async () => []), getMultipleAccountsInfo: vi.fn(async () => []), getAccountInfo: vi.fn(async () => null) };
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({ publicKey: pk, connected: true }),
}));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<any>()),
  getAllProgramIds: () => [],
  getMarketDiscoveryProgramIds: () => [],
  getNetwork: () => "devnet",
}));
const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
  setTimeout(() => { resolve({ ok: true, json: async () => ({ markets: [] }) } as Response); }, 40_000);
}));
vi.stubGlobal("fetch", fetchMock);

import { usePortfolio } from "@/hooks/usePortfolio";

describe("usePortfolio on a slow but working scan", () => {
  it("loads within 300 s and does not start a scan per refresh", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => usePortfolio());
      for (let t = 0; t < 300; t += 5) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      }
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
      // One scan per ~60 s at most (40 s scan, then the 30 s tick after the cache expires), never one per tick on top of a running one.
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
