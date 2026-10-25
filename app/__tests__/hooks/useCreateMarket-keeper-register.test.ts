/**
 * useCreateMarket — keeper registration, UX WP-7 (SECURITY REVIEW REQUIRED before merge).
 *
 * The signed-message proof is gone: the proof is the market-creation transaction (its memo), kept
 * per market on this device. retryKeeperRegistration ("Try now") makes one immediate attempt with
 * that proof and NEVER asks the wallet to sign anything. Covered: happy path (the proof is POSTed,
 * no signMessage), no stored proof (no fetch, a plain message), a server refusal (surfaced), and the
 * in-flight flag.
 */
import { KEEPER_REGISTER_COPY } from "@/lib/keeper-register-client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(() => ({ connection: {} })),
  useWalletCompat: vi.fn(),
}));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useCreateMarket } from "@/hooks/useCreateMarket";
import { saveProofTx } from "@/lib/keeper-register-client";

const mockUseWalletCompat = useWalletCompat as unknown as ReturnType<typeof vi.fn>;
const mockUseConnectionCompat = useConnectionCompat as unknown as ReturnType<typeof vi.fn>;

const SLAB = "7A2g9aUDHgJdeg5E53TqcXrVsKGpiaPbKDrJXRi7dfC1";
const PROOF = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
const REQ = {
  slabAddress: SLAB,
  mainnetCA: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
  dexPoolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
  dexType: "pumpswap",
  symbol: "TEST",
};

describe("useCreateMarket — retryKeeperRegistration (Try now)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const signMessage = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    mockUseConnectionCompat.mockReturnValue({ connection: {} });
    mockUseWalletCompat.mockReturnValue({ publicKey: SystemProgram.programId, connected: true, signTransaction: vi.fn(), signMessage, disconnect: vi.fn() });
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    signMessage.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the stored creation-tx proof and never asks the wallet to sign", async () => {
    saveProofTx(SLAB, PROOF);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, registered: true }) });
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration(REQ);
    });
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/playground/keeper-register");
    const body = JSON.parse(String(init.body));
    expect(body.proofTx).toBe(PROOF);
    expect(body.signature).toBeUndefined();
    expect(body.deployer).toBeUndefined();
    expect(result.current.state.keeperDelegated).toBe(true);
    expect(result.current.state.keeperPhase).toBe("ready");
  });

  it("CONTROL: no stored proof on this device — no fetch, no signature, a plain message", async () => {
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration(REQ);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(result.current.state.keeperDelegated).toBe(false);
    expect(result.current.state.keeperMessage).toMatch(/creation transaction isn't known on this device/);
    expect(result.current.state.keeperFinal).toBe(true);
    expect(result.current.state.keeperPhase).toBe("failed");
  });

  it("a refusal is surfaced and nothing is marked connected", async () => {
    saveProofTx(SLAB, PROOF);
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Registration proof refused: the memo's signer is not this market's creator" }) });
    const { result } = renderHook(() => useCreateMarket());
    let outcome: { registered: boolean; message: string } | undefined;
    await act(async () => {
      outcome = await result.current.retryKeeperRegistration(REQ);
    });
    expect(outcome).toEqual({ registered: false, retryable: false, message: "Registration proof refused: the memo's signer is not this market's creator" });
    expect(result.current.state.keeperDelegated).toBe(false);
    // #3637: a final refusal is a failure with creator copy, not a stale "connecting" line.
    expect(result.current.state.keeperPhase).toBe("failed");
    expect(result.current.state.keeperFinal).toBe(true);
    expect(result.current.state.keeperMessage).toBe(KEEPER_REGISTER_COPY.refused);
  });

  it("#3637: 403 oracle-not-keeper carries its code and the specific reason", async () => {
    saveProofTx(SLAB, PROOF);
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Market is not ready for the live price: oracle-not-keeper", code: "oracle-not-keeper" }) });
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration(REQ);
    });
    expect(result.current.state.keeperMessage).toBe(KEEPER_REGISTER_COPY.oracleNotKeeper);
    expect(result.current.state.keeperFinal).toBe(true);
  });

  it("#3637: a 5xx on retry is not final", async () => {
    saveProofTx(SLAB, PROOF);
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "busy" }) });
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.retryKeeperRegistration(REQ);
    });
    expect(result.current.state.keeperFinal).not.toBe(true);
  });

  it("sets keeperRegistering while the call is in flight", async () => {
    saveProofTx(SLAB, PROOF);
    let release!: () => void;
    fetchMock.mockReturnValue(new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ registered: true }) }); }));
    const { result } = renderHook(() => useCreateMarket());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.retryKeeperRegistration(REQ);
    });
    await waitFor(() => expect(result.current.state.keeperRegistering).toBe(true));
    await act(async () => {
      release();
      await p;
    });
    expect(result.current.state.keeperRegistering).toBe(false);
  });
});
