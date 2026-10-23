/**
 * #3605: the Earn exit shows the runner's own plain lines (the F9 floor-stuck guidance) instead of
 * "Something went wrong and nothing was sent.", and still never shows raw chain text.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const conn = { getProgramAccounts: vi.fn(async () => []), getMultipleAccountsInfo: vi.fn(async () => []) };
const quoteExit = vi.fn();
vi.mock("@/lib/v22/earn-exit-run", () => ({ quoteExit: (...a: unknown[]) => quoteExit(...a), sendExit: vi.fn(), withExitBudget: (x: unknown) => x }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: pk(9) }), useConnectionCompat: () => ({ connection: conn }) }));
vi.mock("@/lib/limits/earn-p3-read", () => ({ readEarnP3Context: async () => ({ bound: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddress: async () => pk(7) }));
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<Record<string, unknown>>()), deriveVaultAuthority: () => [pk(5), 1], deriveInsuranceLpMint: () => [pk(6), 1] }));
vi.mock("@/lib/tx-v1/user-bundle", () => ({ sendUserBundle: vi.fn() }));

import { useEarnExitV22 } from "@/hooks/useEarnExitV22";
import { V22_COPY } from "@/lib/v22/copy";
import { EXIT_LINES } from "@/lib/v22/exit-retry";

const base = { market: pk(1), programId: pk(2), collateralMint: pk(3), sourceDomain: 0, mode: "execute" as const, estimateAtoms: 0n, shares: 100n };

beforeEach(() => quoteExit.mockReset());

describe("#3605: Earn exit failure messages", () => {
  it("a claim stuck on its stored floor shows the floor-stuck guidance", async () => {
    quoteExit.mockResolvedValue({ status: "failed", error: new Error(V22_COPY.earnExit.floorStuck) });
    const { result } = renderHook(() => useEarnExitV22(base));
    await act(async () => void (await result.current.getQuote()));
    expect(result.current.state.phase).toBe("error");
    expect(result.current.state.message).toBe(V22_COPY.earnExit.floorStuck);
  });

  it("#3612: an unread balance shows the calm balance line", async () => {
    quoteExit.mockResolvedValue({ status: "failed", error: new Error(EXIT_LINES.balanceUnread) });
    const { result } = renderHook(() => useEarnExitV22(base));
    await act(async () => void (await result.current.getQuote()));
    expect(result.current.state.phase).toBe("error");
    expect(result.current.state.message).toBe(EXIT_LINES.balanceUnread);
  });

  it("CONTROL: raw chain text is still replaced by the generic line", async () => {
    quoteExit.mockResolvedValue({ status: "failed", error: new Error("Transaction simulation failed: custom program error: 0x1") });
    const { result } = renderHook(() => useEarnExitV22(base));
    await act(async () => void (await result.current.getQuote()));
    expect(result.current.state.message).toBe("Something went wrong and nothing was sent.");
  });

  it("CONTROL: raw RPC text that is not one of the runner's lines is never shown", async () => {
    quoteExit.mockResolvedValue({ status: "failed", error: new Error("failed to simulate transaction: 503 Service Unavailable") });
    const { result } = renderHook(() => useEarnExitV22(base));
    await act(async () => void (await result.current.getQuote()));
    expect(result.current.state.message).toBe("Something went wrong and nothing was sent.");
  });
});
