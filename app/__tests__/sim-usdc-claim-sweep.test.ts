// @vitest-environment node
/**
 * Marker rent sweep (follow-up to Council r4 N4 / #3784). The no-DB claim path leaves one 0-byte System account per
 * (wallet, UTC day), funded by the faucet authority. The sweep moves that balance back with transferWithSeed, but it
 * must never touch a marker that can still block a claim: today's, or yesterday's (a claim in the last minutes of
 * yesterday also reserved today's marker, and the seed hash does not say which day it is for).
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemInstruction, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  buildClaimMarkerInstructions,
  buildMarkerSweepInstruction,
  claimMarkerCreatesIn,
  claimMarkerSeed,
  isMarkerSweepable,
} from "@/lib/sim-usdc-claim-guard";

const DAY = 86_400_000;
const authority = Keypair.generate().publicKey;
const wallet = Keypair.generate().publicKey.toBase58();

describe("isMarkerSweepable", () => {
  const today = 20_767 * DAY;
  it("refuses a marker created today", () => {
    expect(isMarkerSweepable(today + 5_000, today + DAY - 1)).toBe(false);
  });
  it("refuses a marker created yesterday (it may be today's midnight-guard marker)", () => {
    expect(isMarkerSweepable(today - DAY + 1, today + 10)).toBe(false);
    expect(isMarkerSweepable(today - 1, today + 10)).toBe(false);
  });
  it("accepts a marker created two or more UTC days ago", () => {
    expect(isMarkerSweepable(today - DAY - 1, today + 10)).toBe(true);
    expect(isMarkerSweepable(today - 9 * DAY, today)).toBe(true);
  });
});

function parsedTx(instructions: unknown[]): ParsedTransactionWithMeta {
  return { transaction: { message: { instructions } } } as unknown as ParsedTransactionWithMeta;
}

describe("claimMarkerCreatesIn", () => {
  it("finds the marker the claim tx created and checks the address derives from (authority, seed)", async () => {
    const [ix] = await buildClaimMarkerInstructions(authority, wallet, 20_767 * DAY + 1_000);
    const decoded = SystemInstruction.decodeCreateWithSeed(ix);
    const good = {
      program: "system",
      programId: SystemProgram.programId,
      parsed: {
        type: "createAccountWithSeed",
        info: {
          base: authority.toBase58(),
          newAccount: decoded.newAccountPubkey.toBase58(),
          owner: SystemProgram.programId.toBase58(),
          seed: decoded.seed,
          space: 0,
          lamports: 890_880,
          source: authority.toBase58(),
        },
      },
    };
    const forged = { ...good, parsed: { ...good.parsed, info: { ...good.parsed.info, newAccount: Keypair.generate().publicKey.toBase58() } } };
    const otherBase = { ...good, parsed: { ...good.parsed, info: { ...good.parsed.info, base: Keypair.generate().publicKey.toBase58() } } };
    const withData = { ...good, parsed: { ...good.parsed, info: { ...good.parsed.info, space: 8 } } };
    const mintTo = { program: "spl-token", programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), parsed: { type: "mintTo", info: {} } };

    const found = await claimMarkerCreatesIn(parsedTx([good, forged, otherBase, withData, mintTo]), authority);
    expect(found).toEqual([{ address: decoded.newAccountPubkey.toBase58(), seed: claimMarkerSeed(wallet, 20_767) }]);
    expect(await claimMarkerCreatesIn(null, authority)).toEqual([]);
  });
});

describe("buildMarkerSweepInstruction", () => {
  it("is a System transferWithSeed of the full balance from the marker back to the authority", async () => {
    const seed = claimMarkerSeed(wallet, 20_760);
    const marker = await PublicKey.createWithSeed(authority, seed, SystemProgram.programId);
    const ix = buildMarkerSweepInstruction(authority, { address: marker, seed }, 890_880);
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(SystemInstruction.decodeInstructionType(ix)).toBe("TransferWithSeed");
    const d = SystemInstruction.decodeTransferWithSeed(ix);
    expect(d.fromPubkey.equals(marker)).toBe(true);
    expect(d.basePubkey.equals(authority)).toBe(true);
    expect(d.toPubkey.equals(authority)).toBe(true);
    expect(d.seed).toBe(seed);
    expect(d.programId.equals(SystemProgram.programId)).toBe(true);
    expect(Number(d.lamports)).toBe(890_880);
  });
});
