/**
 * "Burn admin key" reported "User rejected the request." for a burn that landed
 * (devnet, Phantom: tx 36JuAgCB...RpRP, SUCCESS; after a reload the card read
 * "ADMIN KEY BURNED"). renounceAdmin now asks the chain before reporting a
 * failure: asset 0's asset_admin reading as the zero key means the burn is done.
 * A genuine rejection (asset_admin still the wallet) still throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { renderHook } from "@testing-library/react";

const ADMIN = Keypair.generate();
const SLAB_PK = new PublicKey("HDCnsb7uCwqT6oiwmiLbXmoov4y5UbWdxJfYMpT9B3cD");
const PROGRAM_PK = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const ZERO = new PublicKey(new Uint8Array(32));

const h = vi.hoisted(() => ({
  /** Slab reads in order; the last one repeats. An Error entry makes that read throw. */
  reads: [] as Array<Uint8Array | Error>,
  readCount: 0,
  sendError: null as Error | null,
  sends: 0,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(() => ({
    connection: {
      getAccountInfo: async () => {
        const r = h.reads[Math.min(h.readCount, h.reads.length - 1)];
        h.readCount++;
        if (r instanceof Error) throw r;
        return { data: Buffer.from(r) };
      },
    },
  })),
}));
vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(async () => {
    h.sends++;
    if (h.sendError) throw h.sendError;
    return "sig";
  }),
}));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => {} }));

import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useAdminActions } from "@/hooks/useAdminActions";
import { assetProfileOff } from "@/lib/v18-wire";

function slabWithAssetAdmin(admin: PublicKey): Uint8Array {
  const off = assetProfileOff(0) + 368;
  const d = new Uint8Array(off + 4096);
  d.set(admin.toBytes(), off);
  return d;
}

const market = { slabAddress: SLAB_PK, programId: PROGRAM_PK } as never;
const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

beforeEach(() => {
  h.reads = [];
  h.readCount = 0;
  h.sendError = null;
  h.sends = 0;
  vi.mocked(useWalletCompat).mockReturnValue({
    publicKey: ADMIN.publicKey,
    signTransaction: vi.fn(),
  } as never);
});

describe("renounceAdmin: a burn that landed is not reported as failed", () => {
  it("send path says 'User rejected the request.' but asset_admin is now zero: resolves (burned)", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey), slabWithAssetAdmin(ZERO)];
    h.sendError = rejected();
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).resolves.toBeNull();
    expect(h.sends).toBe(1);
  });

  it("the burn shows up on the second re-read: still resolves", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey), slabWithAssetAdmin(ADMIN.publicKey), slabWithAssetAdmin(ZERO)];
    h.sendError = rejected();
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).resolves.toBeNull();
    expect(h.readCount).toBe(3);
  });

  it("NEGATIVE CONTROL: a real rejection (asset_admin still the wallet) still throws the wallet's message", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey)];
    h.sendError = rejected();
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).rejects.toThrow("User rejected the request.");
  });

  it("asks the chain twice (pre-flight + two re-reads) before reporting a rejection", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey)];
    h.sendError = rejected();
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).rejects.toThrow("User rejected the request.");
    expect(h.readCount).toBe(3);
  });

  it("a pre-sign refusal (wallet never opened) is re-read once, without the wait, and still throws", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey)];
    h.sendError = Object.assign(new Error("Transaction simulation failed: {}"), { name: "SimulationRefusal" });
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).rejects.toThrow(/simulation failed/);
    expect(h.readCount).toBe(2);
  });

  it("a failed re-read is indeterminate: the original error is kept", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey), new Error("429 Too Many Requests")];
    h.sendError = rejected();
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).rejects.toThrow("User rejected the request.");
  });

  it("a successful send is unchanged: returns the signature, no re-read", async () => {
    h.reads = [slabWithAssetAdmin(ADMIN.publicKey)];
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).resolves.toBe("sig");
    expect(h.readCount).toBe(1);
  });
});

describe("renounceAdmin: a second burn on an already-burned market", () => {
  it("says the key is already burned and never opens the wallet", async () => {
    h.reads = [slabWithAssetAdmin(ZERO)];
    const { result } = renderHook(() => useAdminActions());
    await expect(result.current.renounceAdmin(market)).rejects.toThrow("The admin key is already burned.");
    expect(h.sends).toBe(0);
  });
});
