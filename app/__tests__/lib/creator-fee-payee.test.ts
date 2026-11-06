// @vitest-environment node
/**
 * prog #587 (#644) creator-fee payee in the app: the vendored SDK port (bytes / PDA / ATA / record against the REAL crate's
 * vectors from percolator-sdk #438's fixture, generated at percolator-prog 2b5dce8a), the burn flow's "record the payee first"
 * helper, and the permissionless claim-to-payee builder.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNTS_SET_CREATOR_FEE_PAYEE_V22,
  CREATOR_FEE_PAYEE_ACCOUNT_LEN_V22,
  creatorFeePayeeDestinationV22,
  decodeCreatorFeePayeeV22,
  deriveCreatorFeePayeeV22,
  encodeSetCreatorFeePayeeV22,
} from "@/lib/v22/sdk/creator-fee-payee-v22";
import { ACCOUNT_KIND } from "@/lib/v22/sdk/layout";
import { P4_FLAG_CREATOR_FEE_PAYEE_V22 } from "@/lib/v22/sdk/v22-wire";
import { PERCOLATOR_ERRORS_V22 } from "@/lib/v22/sdk/errors-v22";
import { creatorFeePayeeBeforeBurn, wrapperVersionOf } from "@/lib/creator-fee-payee";
import { buildCreatorFeePayeeClaimIxs, creatorFeeRouteOf, CreatorFeeClaimError } from "@/lib/creator-fee-claim-ix";
import { readCreatorFeeClaimable } from "@/lib/v17-creator-fee";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const PROGRAM7 = new PublicKey(new Uint8Array(32).fill(7));
const MARKET9 = new PublicKey(new Uint8Array(32).fill(9));
/** The real writer's record for (market [9;32], asset 258, payee [0xcd;32]) at 2b5dce8a. */
const GOOD_RECORD = "003631564352455013001300000000000909090909090909090909090909090909090909090909090909090909090909cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd020101ff00000000";

describe("vendored creator-fee-payee port == the real crate (percolator-sdk #438 fixture)", () => {
  it("tag 125 bytes: the vector the real decoder accepted and re-encoded", () => {
    const seq = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
    expect(hex(encodeSetCreatorFeePayeeV22({ assetIndex: 0x0102, marketId: 0x1122334455667788n, payee: seq, authorityEpoch: 0x0807060504030201n })))
      .toBe("7d0201" + "8877665544332211" + hex(seq) + "0102030405060708");
    expect(() => encodeSetCreatorFeePayeeV22({ assetIndex: 0, marketId: 1n, payee: new Uint8Array(32), authorityEpoch: 0n })).toThrow(/zero/);
  });
  it("payee PDA and the canonical payee ATA", () => {
    expect(deriveCreatorFeePayeeV22(PROGRAM7, MARKET9, 0).map(String)).toEqual(["5Yxib62wQoTGyjPyEkBzjn2G6XPU4bU3mKb1VtZUYuZa", "254"]);
    expect(deriveCreatorFeePayeeV22(PROGRAM7, MARKET9, 256)[0].toBase58()).toBe("EQCV1TT83tuyNjaJyAFEXk5yHonjtx7sxEr8VsVHtjAy");
    const mint = new PublicKey(new Uint8Array(32).fill(5));
    expect(creatorFeePayeeDestinationV22(new PublicKey(new Uint8Array(32).fill(3)), mint).toBase58()).toBe("GZdmt4xW34aAvtpEWiRZkLoT57FKy6gc2KU1oTSCNC8r");
  });
  it("record decode (real writer bytes) and refusals", () => {
    const good = Uint8Array.from(Buffer.from(GOOD_RECORD, "hex"));
    expect(good.length).toBe(CREATOR_FEE_PAYEE_ACCOUNT_LEN_V22);
    const r = decodeCreatorFeePayeeV22(good);
    expect([r.market.toBase58(), r.payee.toBase58(), r.assetIndex]).toEqual([MARKET9.toBase58(), "ErNbLjU6E8tSbZH3REsMeTDP3Z8G52k6YedWwvBpAJ7v", 258]);
    const bad = Uint8Array.from(good); bad[16 + 70] = 1;
    expect(() => decodeCreatorFeePayeeV22(bad)).toThrow();
  });
  it("tables: kind 19, p4 bit 3, error 136, tag-125 accounts", () => {
    expect(ACCOUNT_KIND.CreatorFeePayee).toBe(19);
    expect(P4_FLAG_CREATOR_FEE_PAYEE_V22).toBe(8);
    expect(PERCOLATOR_ERRORS_V22[136]?.name).toBe("CreatorFeePayeeInvalid");
    expect(ACCOUNTS_SET_CREATOR_FEE_PAYEE_V22.map((a) => [a.name, a.signer, a.writable])).toEqual([
      ["assetAdmin", true, true], ["market", false, true], ["payeeRecord", false, true], ["systemProgram", false, false],
    ]);
  });
});

describe("burn = record the payee first (useAdminActions.renounceAdmin)", () => {
  const programId = Keypair.generate().publicKey, market = Keypair.generate().publicKey, admin = Keypair.generate().publicKey;
  const base = { programId, market, assetAdmin: admin, marketId: 1n, authorityEpoch: 4n, p4Flags: 0, wrapperVersion: 19 };
  it("no payee yet on a v2.2 market: tag 125 (payee = the burning wallet, epoch 4) and the burn carries epoch 5", () => {
    const r = creatorFeePayeeBeforeBurn(base);
    expect(r.burnEpoch).toBe(5n);
    expect(r.ixs).toHaveLength(1);
    const ix = r.ixs[0]!;
    expect(ix.data[0]).toBe(125);
    expect(new PublicKey(ix.data.subarray(11, 43)).toBase58()).toBe(admin.toBase58());
    expect(Buffer.from(ix.data.subarray(43, 51)).readBigUInt64LE()).toBe(4n);
    expect(ix.keys[0]!.pubkey.toBase58()).toBe(admin.toBase58());
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(deriveCreatorFeePayeeV22(programId, market, 0)[0].toBase58());
  });
  it("a payee already recorded is left as it is (tag 125 refuses a no-op): nothing prepended, epoch unchanged", () => {
    expect(creatorFeePayeeBeforeBurn({ ...base, p4Flags: P4_FLAG_CREATOR_FEE_PAYEE_V22 | 1 })).toEqual({ ixs: [], burnEpoch: 4n });
  });
  it("a v2.1 market (no tag 125 on that wrapper): the pre-#587 burn", () => {
    expect(creatorFeePayeeBeforeBurn({ ...base, wrapperVersion: 18 })).toEqual({ ixs: [], burnEpoch: 4n });
  });
  it("renounceAdmin sends the payee instruction(s) BEFORE the burn, and the burn uses burnEpoch", () => {
    const src = readFileSync(join(__dirname, "..", "..", "hooks", "useAdminActions.ts"), "utf8");
    expect(src).toMatch(/authorityEpoch: burnEpoch,/);
    expect(src).toMatch(/instructions: \[\.\.\.payeeIxs, ix\]/);
  });
});

describe("claim to the payee (permissionless tag 90, payee route)", () => {
  const fx = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "Azagguvr.market.json"), "utf8")) as { market: string; dataBase64: string };
  const live = new Uint8Array(Buffer.from(fx.dataBase64, "base64"));
  const market = new PublicKey(fx.market);
  const programId = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
  const PROFILE = 1350; // VERSION 18 asset 0 profile (v17-creator-fee.ts)
  /** The live market with asset 0's admin burned and p4 bit 3 set (what tag 125 + the burn leave behind). */
  const burnedWithPayee = (): Uint8Array => { const d = Uint8Array.from(live); d.fill(0, PROFILE + 368, PROFILE + 400); d[PROFILE + 20] = P4_FLAG_CREATOR_FEE_PAYEE_V22; return d; };
  const payee = Keypair.generate().publicKey;
  const record = (m: PublicKey): Uint8Array => {
    const r = new Uint8Array(88); const v = new DataView(r.buffer);
    v.setBigUint64(0, 0x5045_5243_5631_3600n, true); v.setUint16(8, 19, true); r[10] = 19; // the v2.2 wrapper writes VERSION 19 headers
    r.set(m.toBytes(), 16); r.set(payee.toBytes(), 48); r[16 + 66] = 1;
    return r;
  };
  it("fixture sanity: the live market is the admin route; the patched one is the payee route with the same owed amount", () => {
    expect(wrapperVersionOf(live)).toBe(18);
    expect(creatorFeeRouteOf(live)).toBe("AdminSigned");
    expect(creatorFeeRouteOf(burnedWithPayee())).toBe("Payee");
    expect(readCreatorFeeClaimable(burnedWithPayee())!.atoms).toBe(readCreatorFeeClaimable(live)!.atoms);
  });
  it("builds [ATA create, tag 90 (7 accounts)] for the full balance, payable by any wallet, to the payee only", () => {
    const caller = Keypair.generate().publicKey;
    const raw = burnedWithPayee();
    const built = buildCreatorFeePayeeClaimIxs({ programId, market, raw, payeeRecord: record(market), caller });
    const owed = readCreatorFeeClaimable(raw)!;
    expect(built.amount).toBe(owed.atoms);
    expect(built.payee.toBase58()).toBe(payee.toBase58());
    expect(built.instructions).toHaveLength(2);
    const t90 = built.instructions[1]!;
    expect(t90.data[0]).toBe(90);
    expect(t90.keys).toHaveLength(7);
    expect(t90.keys[0]!.pubkey.toBase58()).toBe(caller.toBase58());
    expect(t90.keys[2]!.pubkey.toBase58()).toBe(creatorFeePayeeDestinationV22(payee, owed.collateralMint).toBase58());
    expect(t90.keys[6]!.pubkey.toBase58()).toBe(deriveCreatorFeePayeeV22(programId, market, 0)[0].toBase58());
  });
  it("refuses: not the payee route, nothing owed, a record of another market", () => {
    const caller = Keypair.generate().publicKey;
    expect(() => buildCreatorFeePayeeClaimIxs({ programId, market, raw: live, payeeRecord: record(market), caller })).toThrow(CreatorFeeClaimError);
    expect(() => buildCreatorFeePayeeClaimIxs({ programId, market, raw: burnedWithPayee(), payeeRecord: record(Keypair.generate().publicKey), caller })).toThrow(/payee record/);
    const empty = burnedWithPayee(); empty.fill(0, PROFILE + 400, PROFILE + 408); empty.fill(0, 16 + 568, 16 + 576);
    expect(() => buildCreatorFeePayeeClaimIxs({ programId, market, raw: empty, payeeRecord: record(market), caller })).toThrow(/Nothing to send/);
  });
});
