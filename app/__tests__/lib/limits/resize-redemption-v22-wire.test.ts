// @vitest-environment node
/**
 * #3615: the v2.2 collect card's "Cancel and request again" reuses useInsuranceLP.resizeRedemption, which sends
 * tag 81 (buildCancelRedemptionIx) then a new tag 76 (buildRequestRedeemIx). Pinned byte- and account-level against
 * the v2.2 RC wrapper (percolator-prog feat/v22-rc23-2026-10-22, src/v16_program.rs):
 *
 * - decode: `81 => CancelRedemption` reads no payload and the decoder refuses trailing bytes, so 81 is exactly 1 byte;
 *   `76` is `shares u128`, then (extended) `min_payout_atoms u64` + `keeper_ok u8`, with `keeper_ok <= 1` and a non-zero
 *   floor (A4), so a floored 76 is exactly 26 bytes.
 * - handle_cancel_redemption: [0] redeemer signer + writable, [1] registry (owner-checked), [2] redemption writable,
 *   [3] lp_mint, [4] redeemer LP ATA writable, [5] escrow writable, [6] token program. Reads no market account.
 * - handle_request_redeem_lp_shares: [0] redeemer signer + writable, [1] registry, [2] lp_mint, [3] redeemer LP ATA
 *   writable, [4] escrow writable, [5] redemption writable, [6] token program, [7] system program. Reads no market account.
 * - Neither takes a v2.2 market tail (bond tranche / insurance units), so applyMarketTailsV22 leaves both unchanged.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { buildCancelRedemptionIx } from "@/lib/limits/earn-split-pot";
import { buildRequestRedeemIx } from "@/lib/limits/earn-ixs";
import { applyMarketTailsV22 } from "@/lib/v22/market-tails";
import { deriveInsuranceLpMint, deriveLpEscrow, deriveLpRedemption, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { buildRequestRedeemLpSharesIxV22 } from "@/lib/v22/sdk";

const programId = new PublicKey(resolveDevnetProgramIds().wrapper);
const market = Keypair.generate().publicKey;
const redeemer = Keypair.generate().publicKey;
const lpAta = Keypair.generate().publicKey;
const [registry] = deriveLpVaultRegistry(programId, market);
const [redemption] = deriveLpRedemption(programId, registry, redeemer);
const [lpMint] = deriveInsuranceLpMint(programId, market);
const [escrow] = deriveLpEscrow(programId, market);
const flags = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const tails = { bondTranche: Keypair.generate().publicKey, insuranceUnits: Keypair.generate().publicKey, vaultLpExt: Keypair.generate().publicKey };

describe("#3615 resize (81 then 76) against the v2.2 RC wrapper", () => {
  const cancel = buildCancelRedemptionIx({ programId, redeemer, registry, redemption, lpMint, redeemerLpAta: lpAta, escrow });
  const request = buildRequestRedeemIx({ programId, redeemer, registry, lpMint, redeemerLpAta: lpAta, escrow, redemption, shares: 9_523_809n, minPayoutAtoms: 8_571_428n });

  it("tag 81: exactly [81], the 7 accounts in handler order with the flags it checks", () => {
    expect([...cancel.data]).toEqual([81]);
    expect(flags(cancel)).toEqual([
      [redeemer.toBase58(), true, true],
      [registry.toBase58(), false, false],
      [redemption.toBase58(), false, true],
      [lpMint.toBase58(), false, false],
      [lpAta.toBase58(), false, true],
      [escrow.toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ]);
  });

  it("tag 76: 26 bytes [76, shares u128 LE, floor u64 LE, keeper_ok 0], the 8 accounts in handler order", () => {
    const d = Buffer.from(request.data);
    expect(d.length).toBe(26);
    expect(d[0]).toBe(76);
    expect(d.readBigUInt64LE(1) + (d.readBigUInt64LE(9) << 64n)).toBe(9_523_809n);
    expect(d.readBigUInt64LE(17)).toBe(8_571_428n);
    expect(d[25]).toBe(0);
    expect(flags(request)).toEqual([
      [redeemer.toBase58(), true, true],
      [registry.toBase58(), false, true],
      [lpMint.toBase58(), false, false],
      [lpAta.toBase58(), false, true],
      [escrow.toBase58(), false, true],
      [redemption.toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
  });

  it("tag 76 matches the v2.2 SDK builder the quote-first exit uses (bytes, keys, signers)", () => {
    const v22 = buildRequestRedeemLpSharesIxV22({ programId, market }, redeemer, lpAta, 9_523_809n, 8_571_428n, false);
    expect(Buffer.from(request.data).equals(Buffer.from(v22.data))).toBe(true);
    // The one difference: the app marks the registry writable, the SDK read-only. The handler only reads it
    // (read_lp_vault_registry) and never checks writability, so both are accepted.
    const noRegistryW = (ix: typeof v22) => flags(ix).map((f, i) => (i === 1 ? [f[0], f[1]] : f));
    expect(noRegistryW(request)).toEqual(noRegistryW(v22));
  });

  it("a zero floor is never built (the RC decoder refuses it, A4)", () => {
    expect(() => buildRequestRedeemIx({ programId, redeemer, registry, lpMint, redeemerLpAta: lpAta, escrow, redemption, shares: 1n, minPayoutAtoms: 0n })).toThrow();
  });

  it("no v2.2 market tail applies to 81 or 76, even on a market with a bond tranche and insurance units", () => {
    expect(applyMarketTailsV22(cancel, tails)).toBe(cancel);
    expect(applyMarketTailsV22(request, tails)).toBe(request);
  });
});
