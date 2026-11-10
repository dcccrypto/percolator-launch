/**
 * Council r4 N5 (R3-7): a portfolio scan that never answers (RPC 503s / hangs behind retries) left usePortfolio on
 * loading forever. After PORTFOLIO_LOAD_TIMEOUT_MS with nothing loaded it reports a load error (Retry) instead.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const pk = new PublicKey(new Uint8Array(32).fill(91));
// Never settles: the hung RPC.
const connection = { getProgramAccounts: vi.fn(() => new Promise(() => {})), getMultipleAccountsInfo: vi.fn(() => new Promise(() => {})) };
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
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

import { PORTFOLIO_LOAD_TIMEOUT_MS, usePortfolio } from "@/hooks/usePortfolio";

describe("usePortfolio on a hung scan", () => {
  it("stops loading and reports an error after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => usePortfolio());
      expect(result.current.loading).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(PORTFOLIO_LOAD_TIMEOUT_MS - 1_000); });
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
