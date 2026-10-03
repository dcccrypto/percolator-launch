/**
 * 58e379f1 (P3 FINAL): F14-Q2 single-asset markets + error 86, the user's loss decision in copy,
 * and the junior's resolved 102 builder the creator panel and the BPF sim share.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { COPY, P3_ERROR_COPY_BY_NAME, p3ErrorCopyByCode } from "@/lib/limits/copy";
import { limitsErrorCopy, p3LimitsErrorCopy } from "@/lib/limits/errors";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import {
  buildJuniorResolvedReleaseIxs,
  juniorReleaseNeedsHarvest,
  juniorResolvedReleasableAtoms,
} from "@/lib/limits/junior-resolved-release";

describe("error 86 VaultLpMultiAssetMarket", () => {
  it("is in the one constants module at 86 and has clear copy", () => {
    expect(C.P3_ERR.VaultLpMultiAssetMarket).toBe(86);
    const copy = p3ErrorCopyByCode()[86];
    expect(copy).toBe(P3_ERROR_COPY_BY_NAME.VaultLpMultiAssetMarket);
    expect(copy).toMatch(/single-asset market/);
    expect(p3LimitsErrorCopy(86)).toBe(copy);
  });
  it("routes from a wrapper failure when P3 is on, and not when it is off", () => {
    const base = { code: 86, originProgramId: "W", wrapperId: "W", matcherId: "M" };
    expect(limitsErrorCopy({ ...base, p3Enabled: true })).toBe(P3_ERROR_COPY_BY_NAME.VaultLpMultiAssetMarket);
    expect(limitsErrorCopy({ ...base, p3Enabled: false })).toBeNull();
    // A matcher-origin 86 is not ours.
    expect(limitsErrorCopy({ ...base, originProgramId: "M", p3Enabled: true })).toBeNull();
  });
  it("the wizard's vault-lp step explains it (retrying this market cannot help)", () => {
    const hexForm = parseMarketCreationError(new Error("Program W failed: custom program error: 0x56"), { step: "vault-lp" });
    const jsonForm = parseMarketCreationError(new Error('{"InstructionError":[4,{"Custom":86}]}'), { step: "vault-lp" });
    for (const m of [hexForm, jsonForm]) {
      expect(m).toMatch(/more than one asset/);
      expect(m).toMatch(/single-asset markets/);
    }
  });
});

describe("loss copy = P3 doc §0.8: junior first, then Earn pro rata; winners paid in full unless Earn's backing is used up or the losing side's backing falls short", () => {
  const SECTION_0_8 =
    "The creator's junior tranche takes losses first. Only a loss bigger than the junior reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are always paid in full unless Earn's backing is used up too.";
  // UX WP-5 / audit §5.2: "Earn's money" is accepted as the synonym for "Earn's backing".
  // #2999 follow-up: the senior draw (wrapper 553d76f0 v16_program.rs:1291 VaultLpSeniorDrawRequired)
  // only pre-empts a bankruptcy of the VAULT LP. A trader-vs-trader bankruptcy past insurance is still
  // spread over the opposite side's accounts (engine 35ddd692 v16.rs:17372/17519), and a source-domain
  // haircut can apply while Earn still holds funds (v16.rs:11094). So never "always", and name the
  // losing side's backing as the second exception.
  const QUALIFIER = /paid in full unless Earn's (backing|money) is used up too, or the losing side's backing falls short/;
  const HOW_LOSSES_WORK =
    "The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short. Share value can go down; only deposit what you can afford to lose.";
  // Audit §5.2: the §0.8 rule is binding and only the framing words change ("junior tranche" ->
  // "the market creator's stake", "Earn's backing" -> "Earn's money"); §5.1 bans "junior"/"tranche"
  // in user-visible copy. FLAG for the P3 owner: the three surfaces now carry the plain-words form.
  const SECTION_0_8_PLAIN =
    "The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short.";
  it("the wizard requirement, wizard explainer and Earn risk notice carry §0.8 (plain-words framing, §5.2)", () => {
    expect(HOW_LOSSES_WORK.startsWith(SECTION_0_8_PLAIN)).toBe(true);
    void SECTION_0_8;
    for (const s of [COPY.wizardRequirement("20%"), COPY.p3Wizard.explain, COPY.earnRiskP3]) expect(s).toContain(SECTION_0_8_PLAIN);
  });
  it("the exhausted notice and the tranche card keep the pro-rata rule and the qualifier", () => {
    expect(COPY.juniorExhausted).toMatch(/every Earn depositor loses the same percentage/);
    expect(COPY.juniorExhausted).toMatch(QUALIFIER);
    // §5.2: the card's "How losses work" is the §0.8 rule in plain words, verbatim, with the qualifier.
    expect(COPY.howLossesWork).toBe(HOW_LOSSES_WORK);
    expect(COPY.howLossesWork).toMatch(/every Earn depositor loses the same percentage/);
    expect(COPY.howLossesWork).toMatch(QUALIFIER);
    const card = readFileSync(resolve(process.cwd(), "components/limits/EarnTrancheCard.tsx"), "utf8");
    expect(card).toContain("{COPY.howLossesWork}");
    // The real on-chain withdraw value stays on screen (it can be below principal).
    expect(card).toContain("COPY.withdrawImpaired(");
    expect(COPY.withdrawImpaired("1.00")).toMatch(/below what was put in/);
  });
  it("no P3 surface says seniors are whole, principal is guaranteed, winners are haircut, or paid in full unqualified", () => {
    const WRONG =
      /haircut on the winning|winners? (are|get|is) haircut|stay whole|seniors? (are|stay|remain) (whole|protected|safe)|not on Earn deposits|Earn deposits (are|stay) (whole|protected|safe)|never lose|can(no|')t lose|principal is (protected|guaranteed)|guaranteed principal/i;
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "function") strings.push(String((v as (...a: string[]) => string)("X", "Y", "Z", "W")));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(COPY);
    walk(P3_ERROR_COPY_BY_NAME);
    for (const f of ["components/limits/CreatorLimits.tsx", "components/limits/EarnTrancheCard.tsx", "components/earn/EarnVaultView.tsx"]) {
      strings.push(readFileSync(resolve(process.cwd(), f), "utf8"));
    }
    for (const s of strings) {
      expect(s).not.toMatch(WRONG);
      // Every "paid in full" claim must carry the qualifier.
      for (const m of s.matchAll(/paid in full[^.]*\./g)) expect(m[0]).toMatch(QUALIFIER);
      expect(s).not.toMatch(/always paid in full/i);
    }
    const creator = readFileSync(resolve(process.cwd(), "components/limits/CreatorLimits.tsx"), "utf8");
    expect(creator).toContain("{COPY.juniorExhausted}");
    const earn = readFileSync(resolve(process.cwd(), "components/earn/EarnVaultView.tsx"), "utf8");
    // one wording on every Earn surface (§3.8)
    expect(earn).toContain("COPY.howLossesWork");
  });
});

describe("junior resolved release (102): physical - C, 78 first when pending", () => {
  // A market with only the fields decodeTerminalBacking / decodeMarketEngineView read.
  function market(o: { physicalLong: bigint; physicalShort: bigint; vault: bigint; cTot: bigint }): Uint8Array {
    const d = new Uint8Array(C.assetEngineOff(1) + 64);
    const dv = new DataView(d.buffer);
    const put = (off: number, v: bigint) => {
      dv.setBigUint64(off, v & ((1n << 64n) - 1n), true);
      dv.setBigUint64(off + 8, v >> 64n, true);
    };
    dv.setBigUint64(0, C.WRAPPER_MAGIC, true);
    dv.setUint16(8, C.WRAPPER_VERSION_V18, true);
    d[C.HEADER_KIND_OFF] = C.KIND_MARKET_ACCOUNT;
    const g = C.MARKET_GROUP_OFF;
    put(g + C.H_VAULT, o.vault);
    put(g + C.H_C_TOT, o.cTot);
    put(C.assetEngineOff(0) + C.SLOT_BACKING_LONG + C.BUCKET_FRESH_UNLIENED_BACKING_NUM, o.physicalLong * C.BOUND_SCALE + 7n);
    put(C.assetEngineOff(0) + C.SLOT_BACKING_SHORT + C.BUCKET_FRESH_UNLIENED_BACKING_NUM, o.physicalShort * C.BOUND_SCALE);
    return d;
  }
  it("releasable = physical (both domains) - C, floored at 0", () => {
    const m = market({ physicalLong: 60_001_007n, physicalShort: 0n, vault: 60_001_007n, cTot: 0n });
    expect(juniorResolvedReleasableAtoms(m, 0, 1_007n)).toBe(60_000_000n);
    expect(juniorResolvedReleasableAtoms(m, 1, 1_007n)).toBe(60_000_000n); // sibling domain reads the same pair
    expect(juniorResolvedReleasableAtoms(m, 0, 70_000_000n)).toBe(0n);
    const both = market({ physicalLong: 10n, physicalShort: 5n, vault: 15n, cTot: 0n });
    expect(juniorResolvedReleasableAtoms(both, 0, 3n)).toBe(12n);
  });
  it("needs 78 first iff a claim-free residual is pending (vault > owned)", () => {
    expect(juniorReleaseNeedsHarvest(market({ physicalLong: 1n, physicalShort: 0n, vault: 100n, cTot: 100n }), 0)).toBe(false);
    expect(juniorReleaseNeedsHarvest(market({ physicalLong: 1n, physicalShort: 0n, vault: 101n, cTot: 100n }), 0)).toBe(true);
  });
  it("builds [ATA, 102 + resolved tail] or [ATA, 78, 102] in that order", () => {
    const k = () => Keypair.generate().publicKey;
    const vm = { programId: k(), market: k(), registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k() };
    const c = { vm, domain: 0, owner: k(), ownerAta: k(), mint: k(), vaultToken: k(), vaultAuthority: k() };
    const plain = buildJuniorResolvedReleaseIxs(c, 5n, false);
    expect(plain).toHaveLength(2);
    expect(plain[1].data[0]).toBe(C.P3_TAG.VaultLpReleaseSurplus);
    expect(plain[1].keys).toHaveLength(11);
    expect(plain[1].keys[7].pubkey.equals(c.ownerAta)).toBe(true);
    expect(plain[1].keys[0].pubkey.equals(c.owner) && plain[1].keys[0].isSigner).toBe(true);
    const withHarvest = buildJuniorResolvedReleaseIxs(c, 5n, true);
    expect(withHarvest.map((i) => i.data[0])).toEqual([1, C.TAG_LP_VAULT_CRANK_FEES, C.P3_TAG.VaultLpReleaseSurplus]);
  });
  it("null-safe on missing market data", () => {
    expect(juniorResolvedReleasableAtoms(null, 0, 0n)).toBeNull();
    expect(juniorReleaseNeedsHarvest(null, 0)).toBe(false);
  });
  it("the creator panel and the hook both go through this module", () => {
    const hook = readFileSync(resolve(process.cwd(), "hooks/useJuniorTranche.ts"), "utf8");
    const panel = readFileSync(resolve(process.cwd(), "components/limits/CreatorLimits.tsx"), "utf8");
    expect(hook).toContain("buildJuniorResolvedReleaseIxs(c, amount, juniorReleaseNeedsHarvest(c.marketData, c.domain))");
    expect(panel).toContain("juniorResolvedReleasableAtoms(");
  });
});
