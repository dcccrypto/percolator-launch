/**
 * UX WP-9 AC4 (audit §3.13, NF-2): unwrap after an external close = ONE prompt. The Burn is
 * simulated first; the NFT program's LegNotActive (22) sends EmergencyBurn as the only tx (sendTx
 * for the Burn is never called). The wrapper's own 22 bubbling through the CPI is NOT that case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";

const WRAPPER = Keypair.generate().publicKey;
const PDA = () => [Keypair.generate().publicKey, 255] as const;
const h = vi.hoisted(() => ({ sim: null as null | { err: unknown; logs: string[] } }));
const WALLET = { publicKey: Keypair.generate().publicKey };
const CONN = { connection: { getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(199, 1) })) } };
const SLAB = { programId: WRAPPER, raw: new Uint8Array(8), refresh: vi.fn() };
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => CONN }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => SLAB }));
vi.mock("@/hooks/usePositionNft", () => ({ usePositionNft: () => ({ nftMint: null, nftPdaAddress: null }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
// The hook reads "is this a wrapper market?" through lib/v22/layout (flag off it delegates to the SDK parser, flag on it checks magic + VERSION).
vi.mock("@/lib/v22/layout", async (orig) => ({ ...(await orig<object>()), isWrapperAccount: () => true }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<object>()),
  isV17Account: () => true,
  deriveMintAuthority: PDA,
  deriveExtraAccountMetas: PDA,
  deriveNftRegistry: PDA,
}));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<object>()), getAssociatedTokenAddressSync: () => PDA()[0] }));
const sendTx = vi.fn(async () => "burn-sig");
const sendEmergencyBurn = vi.fn(async () => "emergency-sig");
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<object>()),
  sendTx: (...a: unknown[]) => sendTx(...(a as [])),
  simulateForGate: async () => ({ err: h.sim?.err ?? null, logs: h.sim?.logs ?? [], consumed: 1, rpcFailed: false, simulated: [] }),
}));
vi.mock("@/hooks/useEmergencyBurn", () => ({ sendEmergencyBurn: (...a: unknown[]) => sendEmergencyBurn(...(a as [])) }));

const { useBurnPositionNft, isLegNotActiveSim } = await import("@/hooks/useBurnPositionNft");
const NFT = PERCOLATOR_NFT_PROGRAM_ID.toBase58();
const override = { nftMint: Keypair.generate().publicKey, nftPdaAddress: Keypair.generate().publicKey.toBase58() };

describe("AC4: unwrap after an external close = 1 prompt", () => {
  beforeEach(() => {
    sendTx.mockClear();
    sendEmergencyBurn.mockClear();
  });
  it("LegNotActive in the Burn simulation -> EmergencyBurn only", async () => {
    h.sim = { err: { InstructionError: [2, { Custom: 22 }] }, logs: [`Program ${NFT} failed: custom program error: 0x16`] };
    const { result } = renderHook(() => useBurnPositionNft(Keypair.generate().publicKey.toBase58(), override));
    await act(async () => {
      expect(await result.current.burn()).toBe("emergency-sig");
    });
    expect(sendTx).not.toHaveBeenCalled();
    expect(sendEmergencyBurn).toHaveBeenCalledTimes(1);
  });
  it("a green simulation -> the Burn only", async () => {
    h.sim = null;
    const { result } = renderHook(() => useBurnPositionNft(Keypair.generate().publicKey.toBase58(), override));
    await act(async () => {
      expect(await result.current.burn()).toBe("burn-sig");
    });
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(sendEmergencyBurn).not.toHaveBeenCalled();
  });
  it("the wrapper's 22 through the CPI is not LegNotActive", () => {
    const w = WRAPPER.toBase58();
    expect(isLegNotActiveSim({ InstructionError: [2, { Custom: 22 }] }, [`Program ${w} failed: custom program error: 0x16`, `Program ${NFT} failed: custom program error: 0x16`], w)).toBe(false);
    expect(isLegNotActiveSim({ InstructionError: [2, { Custom: 21 }] }, [`Program ${NFT} failed`], w)).toBe(false);
    expect(isLegNotActiveSim({ InstructionError: [2, { Custom: 22 }] }, [`Program ${NFT} failed: custom program error: 0x16`], w)).toBe(true);
  });
});
