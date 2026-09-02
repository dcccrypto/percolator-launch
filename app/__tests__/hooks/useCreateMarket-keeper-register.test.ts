/**
 * useCreateMarket — keeper registration tests (2026-07-09 bug fix)
 *
 * Two real bugs surfaced by a live launch:
 *   1. wallet.signMessage was always undefined for Privy users (see
 *      hooks/useWalletCompat.ts's fix), so keeper-register's POST always omitted
 *      `signature` and the route 400'd with "Missing required fields: deployer,
 *      signature" — the market landed on-chain but never got priced.
 *   2. There was no way to retry registration for an already-live market short of
 *      re-deploying — LaunchSuccess's "Retry registration" button now calls
 *      retryKeeperRegistration() for exactly this.
 *
 * These tests exercise retryKeeperRegistration() (which shares its sign+POST
 * implementation, registerMarketWithKeeper(), with create()'s own keeper-register
 * step) against a mocked wallet + fetch, covering: happy path, signMessage
 * unavailable, sign() rejecting, and the server 400ing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(() => ({ connection: {} })),
  useWalletCompat: vi.fn(),
}));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useCreateMarket } from "@/hooks/useCreateMarket";

const mockUseWalletCompat = useWalletCompat as unknown as ReturnType<typeof vi.fn>;
const mockUseConnectionCompat = useConnectionCompat as unknown as ReturnType<typeof vi.fn>;

const SLAB = "7A2g9aUDHgJdeg5E53TqcXrVsKGpiaPbKDrJXRi7dfC1";
const DEPLOYER = SystemProgram.programId;

describe("useCreateMarket — retryKeeperRegistration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUseConnectionCompat.mockReturnValue({ connection: {} });
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs the stateless proof and registers successfully when the wallet can sign", async () => {
    const signMessage = vi.fn().mockResolvedValue(new Uint8Array(64).fill(7));
    mockUseWalletCompat.mockReturnValue({
      publicKey: DEPLOYER,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      signMessage,
      disconnect: vi.fn(),
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        registered: true,
        message: "Registered — the keeper will pick this up on its next poll (~30s)",
      }),
    });

    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration({
        slabAddress: SLAB,
        mainnetCA: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
        dexPoolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
        dexType: "pumpswap",
        symbol: "TEST",
      });
    });

    expect(signMessage).toHaveBeenCalledOnce();
    // The signed message must be the exact proof the server reconstructs and
    // verifies — see route.ts's statelessProofMessage().
    //
    // #2505 / #2468 INVERTED: this used to pin `^keeper-register:<slab>:<minute>$`,
    // which is precisely the unbound message the two issues report — it authorised
    // the slab and nothing else, so one signature covered any pool. The proof now
    // binds the registration parameters, and asserting the OLD shape would pin the
    // vulnerability.
    const signedBytes = signMessage.mock.calls[0][0] as Uint8Array;
    const signedText = new TextDecoder().decode(signedBytes);
    expect(signedText.startsWith("keeper-register\n")).toBe(true);
    expect(signedText).toContain(SLAB);
    // The pool must be covered — this is the #2468 attack, stated as an assertion.
    expect(signedText).toContain("dexPoolAddress=");
    expect(signedText).not.toMatch(new RegExp(`^keeper-register:${SLAB}:\\d+$`));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/playground/keeper-register",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.slabAddress).toBe(SLAB);
    expect(body.deployer).toBe(DEPLOYER.toBase58());
    expect(typeof body.signature).toBe("string");
    expect(body.signature.length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(result.current.state.keeperDelegated).toBe(true);
      expect(result.current.state.keeperRegistering).toBe(false);
    });
  });

  it("does NOT call fetch and surfaces an actionable message when signMessage is unavailable", async () => {
    mockUseWalletCompat.mockReturnValue({
      publicKey: DEPLOYER,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      signMessage: undefined,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration({
        slabAddress: SLAB,
        dexPoolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
      });
    });

    // BUG FIX: previously this would have posted anyway with no `signature` field.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.keeperDelegated).toBe(false);
    expect(result.current.state.keeperMessage).toMatch(/can't sign messages/);
  });

  it("does NOT call fetch and stays retryable when the sign request is rejected", async () => {
    const signMessage = vi.fn().mockRejectedValue(new Error("User rejected the request"));
    mockUseWalletCompat.mockReturnValue({
      publicKey: DEPLOYER,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      signMessage,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration({
        slabAddress: SLAB,
        dexPoolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
      });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.keeperDelegated).toBe(false);
    expect(result.current.state.keeperMessage).toMatch(/cancelled or failed/);
    expect(result.current.state.keeperRegistering).toBe(false);
  });

  it("surfaces the server's error message when registration is rejected (e.g. deployer mismatch)", async () => {
    const signMessage = vi.fn().mockResolvedValue(new Uint8Array(64).fill(1));
    mockUseWalletCompat.mockReturnValue({
      publicKey: DEPLOYER,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      signMessage,
      disconnect: vi.fn(),
    });
    fetchMock.mockResolvedValue({
      json: async () => ({ error: "Deployer does not match slab admin" }),
    });

    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration({
        slabAddress: SLAB,
        dexPoolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
      });
    });

    expect(result.current.state.keeperDelegated).toBe(false);
    expect(result.current.state.keeperMessage).toContain("Deployer does not match slab admin");
  });

  it("sets keeperRegistering while the call is in flight", async () => {
    const signMessage = vi.fn().mockResolvedValue(new Uint8Array(64).fill(3));
    mockUseWalletCompat.mockReturnValue({
      publicKey: DEPLOYER,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      signMessage,
      disconnect: vi.fn(),
    });
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const { result } = renderHook(() => useCreateMarket());
    let call: Promise<unknown>;
    act(() => {
      call = result.current.retryKeeperRegistration({
        slabAddress: SLAB,
        dexPoolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
      });
    });

    await waitFor(() => {
      expect(result.current.state.keeperRegistering).toBe(true);
    });

    await act(async () => {
      resolveFetch({ json: async () => ({ ok: true, registered: true, message: "Registered." }) });
      await call;
    });

    expect(result.current.state.keeperRegistering).toBe(false);
    expect(result.current.state.keeperDelegated).toBe(true);
  });
});
