// @vitest-environment node
/**
 * AUD-FC-A2: the app's owner-signed CloseResolved (30) / ClaimResolvedPayoutTopup (46) must match the wrapper's account list
 * (`handle_close_resolved`, percolator-prog 1b9ee2af and the deployed aca02ba6: accounts 0..6, NFT trio at 7) and the SDK's
 * ACCOUNTS_CLOSE_RESOLVED. Wire of the program decode: `30 => CloseResolved { fee_rate_per_slot: u128 }` = 17 bytes.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ownResolvedPayIxs } from "@/lib/limits/own-portfolio-cleanup";
import { TAG_CLAIM_RESOLVED_PAYOUT_TOPUP, TAG_CLOSE_RESOLVED } from "@/lib/limits/constants";
import { deriveNftRegistryPda } from "@/lib/limits/p3-ix";

const k = (n: number) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff)).publicKey;
const C = { programId: k(1), owner: k(2), market: k(3), collateralMint: k(4), vaultToken: k(5), vaultAuthority: k(6) };
const PORTFOLIO = k(7);

describe("CloseResolved / ClaimResolvedPayoutTopup builder", () => {
  const [create, close] = ownResolvedPayIxs(C, PORTFOLIO, TAG_CLOSE_RESOLVED);
  const [, topup] = ownResolvedPayIxs(C, PORTFOLIO, TAG_CLAIM_RESOLVED_PAYOUT_TOPUP);

  it("tag 30: [30, fee_rate_per_slot u128 = 0], 17 bytes; tag 46 is the bare tag", () => {
    expect(Array.from(close.data)).toEqual([30, ...new Array(16).fill(0)]);
    expect(topup.data[0]).toBe(46);
  });

  it("accounts 0..6 are the wrapper's: owner (signer), market (w), portfolio (w), dest ATA (w), vault token (w), vault authority, token program", () => {
    const f = (i: number) => ({ key: close.keys[i]!.pubkey.toBase58(), s: close.keys[i]!.isSigner, w: close.keys[i]!.isWritable });
    const ata = create.keys[1]!.pubkey; // the idempotent create's ATA
    expect([f(0), f(1), f(2), f(3), f(4), f(5), f(6)]).toEqual([
      { key: C.owner.toBase58(), s: true, w: false },
      { key: C.market.toBase58(), s: false, w: true },
      { key: PORTFOLIO.toBase58(), s: false, w: true },
      { key: ata.toBase58(), s: false, w: true },
      { key: C.vaultToken.toBase58(), s: false, w: true },
      { key: C.vaultAuthority.toBase58(), s: false, w: false },
      { key: TOKEN_PROGRAM_ID.toBase58(), s: false, w: false },
    ]);
    // [7] is the unsigned-caller NftRegistry proof (harmless on the signed path)
    expect(close.keys[7]!.pubkey.equals(deriveNftRegistryPda(C.programId, C.market))).toBe(true);
    expect(close.keys[7]!.isSigner).toBe(false);
    expect(close.keys).toHaveLength(8);
    expect(topup.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable])).toEqual(close.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]));
  });

  it("the destination is the OWNER's collateral ATA, created idempotently by the owner in front of it", () => {
    expect(create.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(create.data[0]).toBe(1); // CreateIdempotent
    expect(create.keys[0]!.pubkey.equals(C.owner)).toBe(true);
    expect(create.keys[2]!.pubkey.equals(C.owner)).toBe(true);
    expect(create.keys[3]!.pubkey.equals(C.collateralMint)).toBe(true);
    expect(create.keys[1]!.pubkey.equals(close.keys[3]!.pubkey)).toBe(true);
  });

  // The SDK candidate's ACCOUNTS_CLOSE_RESOLVED / ACCOUNTS_CLAIM_RESOLVED_PAYOUT_TOPUP (percolator-sdk src/abi/accounts.ts), vendored: always asserted.
  const SDK_SPEC = [
    { name: "owner", signer: true, writable: false },
    { name: "market", signer: false, writable: true },
    { name: "portfolio", signer: false, writable: true },
    { name: "destToken", signer: false, writable: true },
    { name: "vaultToken", signer: false, writable: true },
    { name: "vaultAuthority", signer: false, writable: false },
    { name: "tokenProgram", signer: false, writable: false },
  ] as const;
  it("matches the SDK's ACCOUNTS_CLOSE_RESOLVED / ACCOUNTS_CLAIM_RESOLVED_PAYOUT_TOPUP (vendored 7-entry spec), account by account", () => {
    for (const ix of [close, topup]) {
      SDK_SPEC.forEach((a, i) => {
        expect({ i, s: ix.keys[i]!.isSigner, w: ix.keys[i]!.isWritable }).toEqual({ i, s: a.signer, w: a.writable });
      });
    }
  });

  // With the built SDK on hand, compare the live export too (visible skip, never silent).
  it.skipIf(!process.env.SDK_V22_DIST || !existsSync(`${process.env.SDK_V22_DIST}/dist/index.js`))("and the SDK dist's live export equals the vendored spec (SDK_V22_DIST)", async () => {
    type Spec = readonly { name: string; signer: boolean; writable: boolean }[];
    const sdk = (await import(/* @vite-ignore */ `${process.env.SDK_V22_DIST}/dist/index.js`)) as { ACCOUNTS_CLOSE_RESOLVED: Spec; ACCOUNTS_CLAIM_RESOLVED_PAYOUT_TOPUP: Spec };
    expect(sdk.ACCOUNTS_CLOSE_RESOLVED).toEqual(SDK_SPEC);
    expect(sdk.ACCOUNTS_CLAIM_RESOLVED_PAYOUT_TOPUP).toEqual(SDK_SPEC);
  });
});
