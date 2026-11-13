/**
 * The wizard's seed check reads the wallet's collateral balance. A missing token account is a real zero; an RPC error is
 * "unknown" (readFailed), never zero and never enough.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  // findProgramAddressSync fails jsdom's realm-split Uint8Array check; the address isn't under test.
  getAssociatedTokenAddressSync: (_m: unknown, owner: PublicKey) => owner,
}));

import { useCollateralBalance } from "@/hooks/useCollateralBalance";

const WALLET = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
type Conn = Parameters<typeof useCollateralBalance>[1];
const conn = (o: { info?: () => Promise<unknown>; bal?: () => Promise<unknown> }) =>
  ({ getAccountInfo: o.info ?? (async () => ({})), getTokenAccountBalance: o.bal ?? (async () => ({ value: { amount: "5" } })) }) as unknown as Conn;

describe("useCollateralBalance", () => {
  it("reads the balance in atoms", async () => {
    const c = conn({ bal: async () => ({ value: { amount: "400000000" } }) });
    const { result } = renderHook(() => useCollateralBalance(WALLET, c, MINT));
    await waitFor(() => expect(result.current.balance).toBe(400_000_000n));
    expect(result.current.readFailed).toBe(false);
  });
  it("a missing token account is a real zero, not unknown", async () => {
    const c = conn({ info: async () => null });
    const { result } = renderHook(() => useCollateralBalance(WALLET, c, MINT));
    await waitFor(() => expect(result.current.balance).toBe(0n));
    expect(result.current.readFailed).toBe(false);
  });
  it("an RPC error is unknown (readFailed), and retry reads again", async () => {
    let fail = true;
    const c = conn({ info: async () => { if (fail) throw new Error("429"); return {}; } });
    const { result } = renderHook(() => useCollateralBalance(WALLET, c, MINT));
    await waitFor(() => expect(result.current.readFailed).toBe(true));
    expect(result.current.balance).toBeNull();
    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.readFailed).toBe(false));
    await waitFor(() => expect(result.current.balance).toBe(5n));
  });
  it("disabled: no read, nothing reported", async () => {
    const getAccountInfo = vi.fn();
    const c = { getAccountInfo, getTokenAccountBalance: vi.fn() } as unknown as Conn;
    const { result } = renderHook(() => useCollateralBalance(WALLET, c, MINT, false));
    expect(getAccountInfo).not.toHaveBeenCalled();
    expect(result.current.balance).toBeNull();
    expect(result.current.readFailed).toBe(false);
  });
});
