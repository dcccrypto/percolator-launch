// @vitest-environment node
/**
 * Guards for the tag-90 claim builder.
 *
 * These live in lib/creator-fee-claim-ix.ts rather than in either caller so the
 * single-market panel and the dashboard's claim-all cannot drift into
 * disagreeing about what a valid claim is. Every guard must fail CLOSED: the
 * builder either produces an instruction the chain will accept or throws, never
 * a hopeful one.
 */

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildCreatorFeeClaimIx, CreatorFeeClaimError } from "@/lib/creator-fee-claim-ix";

const programId = new PublicKey("11111111111111111111111111111111");
const market = Keypair.generate().publicKey;
const claimant = Keypair.generate().publicKey;

describe("the builder refuses rather than guessing", () => {
  it("rejects bytes that are not a v17 market account", async () => {
    // A portfolio/ledger/registry account shares the v17 magic, and an empty or
    // truncated buffer is what a failed RPC read looks like. Either way there is
    // no counter to debit, so there is no instruction to build.
    await expect(
      buildCreatorFeeClaimIx({ programId, market, raw: new Uint8Array(0), claimant }),
    ).rejects.toThrow(CreatorFeeClaimError);
  });

  it("names the reason, so a caller can show it verbatim", async () => {
    // A bare "claim failed" in the UI is what sends a creator to Discord.
    await expect(
      buildCreatorFeeClaimIx({ programId, market, raw: new Uint8Array(64), claimant }),
    ).rejects.toThrow(/does not expose a creator fee counter/i);
  });

  it("rejects a zero-length read before it reaches the wallet", async () => {
    // The guard must run during BUILD, not surface as a wallet rejection — the
    // creator should never be asked to sign a transaction that cannot succeed.
    let threw = false;
    try {
      await buildCreatorFeeClaimIx({ programId, market, raw: new Uint8Array(8), claimant });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(CreatorFeeClaimError);
    }
    expect(threw).toBe(true);
  });

  it("CONTROL: the error type is distinguishable from an RPC failure", async () => {
    // useClaimCreatorFees passes non-CreatorFeeClaimError messages through
    // mapCreatorClaimError; a guard message is already a sentence and must not
    // be re-mapped. That only works if the class is actually thrown.
    const err = await buildCreatorFeeClaimIx({
      programId, market, raw: new Uint8Array(0), claimant,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CreatorFeeClaimError);
    expect(err).toBeInstanceOf(Error);
  });
});
