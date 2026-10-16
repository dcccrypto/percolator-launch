/**
 * M-5: "Burn admin key" (UpdateAssetAuthority, tag 65, new key = 0) must be
 * signable by the admin ALONE.
 *
 * Deployed handler (wrapper 553d76f0, handle_update_asset_authority):
 *   expect_signer(current)?; expect_writable(market)?;
 *   if new_pubkey != [0u8; 32] { expect_signer(new_authority)?; ... }
 *
 * The SDK spec marks account 1 as an unconditional signer, so a burn asked the
 * wallet for a signature from the all-zero key. Simulation passed (no sig
 * verification) and signing/serialising then failed with "Missing signature".
 * These tests build the REAL instruction through the hooks and prove the
 * resulting transaction requires only the admin's signature.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { renderHook } from "@testing-library/react";

const ADMIN = Keypair.generate();
const OTHER = Keypair.generate();
const SLAB_PK = new PublicKey("27kaERB4L51djBQoQtLYURQNML5naZGaATuj2oB6kL1d");
const PROGRAM_PK = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const ZERO = new PublicKey(new Uint8Array(32));

const h = vi.hoisted(() => ({
  slab: new Uint8Array(0),
  sent: [] as TransactionInstruction[][],
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(() => ({
    connection: { getAccountInfo: async () => ({ data: Buffer.from(h.slab) }) },
  })),
}));
vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(async ({ instructions }: { instructions: TransactionInstruction[] }) => {
    h.sent.push(instructions);
    return "sig";
  }),
}));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => {} }));

import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useUpdateAssetAuthority, ASSET_AUTH_KIND } from "@/hooks/useUpdateAssetAuthority";
import { assetProfileOff } from "@/lib/v18-wire";

function slabWithAssetAdmin(admin: PublicKey): Uint8Array {
  const off = assetProfileOff(0, new Uint8Array(0)) + 368;
  const d = new Uint8Array(off + 4096);
  d.set(admin.toBytes(), off);
  return d;
}

/**
 * The keys a wallet must produce signatures for, from the compiled message —
 * the set web3.js checks when it throws "Missing signature for public key".
 * (Full serialisation is not used: under jsdom, buffer-layout rejects
 * cross-realm Uint8Arrays, which is unrelated to what is being tested.)
 */
function requiredSigners(ixs: TransactionInstruction[]): string[] {
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = ADMIN.publicKey;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const msg = tx.compileMessage();
  return msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
}

beforeEach(() => {
  h.sent = [];
  h.slab = slabWithAssetAdmin(ADMIN.publicKey);
  vi.mocked(useWalletCompat).mockReturnValue({
    publicKey: ADMIN.publicKey,
    signTransaction: vi.fn(),
  } as never);
});

describe("M-5 burn admin key is signable", () => {
  it("renounceAdmin: the zero key is read-only, and the admin is the only required signer", async () => {
    const { result } = renderHook(() => useAdminActions());
    await result.current.renounceAdmin({ slabAddress: SLAB_PK, programId: PROGRAM_PK } as never);
    expect(h.sent).toHaveLength(1);
    const [ix] = h.sent[0];
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0]).toMatchObject({ isSigner: true });
    expect(ix.keys[0].pubkey.equals(ADMIN.publicKey)).toBe(true);
    expect(ix.keys[1].pubkey.equals(ZERO)).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: false });
    expect(ix.keys[2]).toMatchObject({ isSigner: false, isWritable: true });
    expect(requiredSigners(h.sent[0])).toEqual([ADMIN.publicKey.toBase58()]);
  });

  it("useUpdateAssetAuthority: a burn to 0 needs only the current authority", async () => {
    const { result } = renderHook(() => useUpdateAssetAuthority());
    await result.current.updateAssetAuthority({
      slabAddress: SLAB_PK.toBase58(),
      programId: PROGRAM_PK,
      assetIndex: 0,
      kind: ASSET_AUTH_KIND.AssetAdmin,
      newPubkey: ZERO.toBase58(),
    } as never);
    const [ix] = h.sent[0];
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: false });
    expect(requiredSigners(h.sent[0])).toEqual([ADMIN.publicKey.toBase58()]);
  });

  it("useUpdateAssetAuthority: a NON-zero new key still has to co-sign (unchanged)", async () => {
    const { result } = renderHook(() => useUpdateAssetAuthority());
    await result.current.updateAssetAuthority({
      slabAddress: SLAB_PK.toBase58(),
      programId: PROGRAM_PK,
      assetIndex: 0,
      kind: ASSET_AUTH_KIND.AssetAdmin,
      newPubkey: OTHER.publicKey.toBase58(),
    } as never);
    const [ix] = h.sent[0];
    expect(ix.keys[1].pubkey.equals(OTHER.publicKey)).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isSigner: true });
    expect(requiredSigners(h.sent[0]).sort()).toEqual(
      [ADMIN.publicKey.toBase58(), OTHER.publicKey.toBase58()].sort(),
    );
  });
});
