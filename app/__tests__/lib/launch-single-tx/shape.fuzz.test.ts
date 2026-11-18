// @vitest-environment node
/**
 * Seeded fuzz of launchBundleViolations (lib/launch-single-tx/shape.ts): it is documented "Pure; never throws for a malformed bundle
 * (it reports it)". Valid bundles are built from expectedLaunchShape, then mutated. Two oracles:
 *  - never throws, for every mutation (stacked, including pure garbage instructions);
 *  - reports >= 1 violation whenever a mutation is guaranteed-invalid by construction (see `mutate`).
 * Also pins the replay-lane byte offsets (OFF in shape.ts) to the SDK encoders.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  IX_TAG,
  IX_TAG_P3,
  STAKE_IX,
  encodeConfigureAuthMark,
  encodePushAuthMark,
  encodeTopUpInsurance,
  encodeUpdateAssetAuthority,
  encodeUpdateFeeSplit,
} from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { MEMO_PROGRAM_ID } from "@/lib/keeper-register-memo";
import {
  classifyLaunchIx,
  configureAuthMarkNowSlot,
  expectedLaunchShape,
  launchBundleViolations,
  type LaunchBundleContext,
  type LaunchIxKind,
  type LaunchShapeOptions,
  type NeutralIx,
} from "@/lib/launch-single-tx/shape";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const int = (r: R, n: number): number => Math.floor(r() * n);
const pick = <T,>(r: R, xs: readonly T[]): T => xs[int(r, xs.length)]!;
// On-curve keys (PDA derivation needs real program ids) from a small pool: Keypair.fromSeed per key is too slow for 20k+ bundles.
// Within one bundle keys come from a rolling cursor, so they stay distinct (a bundle uses well under 150 keys).
const POOL = Array.from({ length: 600 }, (_, i) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j * 13 + (i >> 8) * 101 + 1) & 255)).publicKey.toBase58());
let cursor = 0;
const key = (_r: R): string => POOL[cursor++ % POOL.length]!;

const SYSTEM = SystemProgram.programId.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const MEMO = MEMO_PROGRAM_ID.toBase58();
const boot = rng(7);
const WRAPPER = key(boot);
const STAKE = key(boot);
const PAYER = key(boot);
const SLAB = key(boot);
const KEEPER = key(boot);

const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));

interface Variant extends LaunchShapeOptions {
  v22: boolean;
}

/** A valid bundle for the options (everything the rules pin is right; everything else is random). */
function buildValid(o: LaunchShapeOptions, r: R): { ixs: NeutralIx[]; ctx: LaunchBundleContext } {
  const kinds = expectedLaunchShape(o);
  const bindLp = kinds.indexOf("wrapper.InitVaultLp");
  const lpState = key(r);
  const lpPortfolio = key(r);
  const acc = (k: string, signer = false, writable = false) => ({ key: k, signer, writable });
  const rand = (n: number) => Array.from({ length: n }, () => acc(key(r)));
  let epoch = 0n;
  let obs = 0n;
  let creates = 0;
  const ixs = kinds.map((k, i): NeutralIx => {
    const w = (data: Uint8Array, accounts: NeutralIx["accounts"]): NeutralIx => ({ programId: WRAPPER, accounts, data });
    switch (k) {
      case "system.createAccount": {
        const to = creates++ === 0 ? SLAB : key(r);
        return { programId: SYSTEM, accounts: [acc(PAYER, true, true), acc(to, true, true)], data: new Uint8Array(52) };
      }
      case "ata.create":
        return { programId: ATA, accounts: [acc(PAYER, true, true), ...rand(5)], data: new Uint8Array(0) };
      case "ata.createIdempotent":
        return { programId: ATA, accounts: [acc(PAYER, true, true), ...rand(5)], data: Uint8Array.of(1) };
      case "memo":
        return { programId: MEMO, accounts: [], data: Uint8Array.of(1, 2, 3) };
      case "wrapper.InitMarket":
        return w(Uint8Array.of(IX_TAG.InitMarket, 9, 9), [acc(PAYER, true, true), acc(SLAB, false, true), ...rand(4)]);
      case "wrapper.SetNftProgramId":
        return w(Uint8Array.of(IX_TAG.SetNftProgramId), rand(3));
      case "wrapper.ConfigurePermissionlessResolve":
        return w(cat(Uint8Array.of(38), u64le(2n), u64le(18_000n), u64le(216_000n), u64le(1n)), [acc(PAYER, true, true), acc(SLAB, false, true)]);
      case "wrapper.ConfigureAuthMark": {
        obs += 1n;
        return w(encodeConfigureAuthMark({ assetIndex: 0, marketId: 5n, nowSlot: 123n, initialMarkE6: 77n, observationSequence: obs }), rand(4));
      }
      case "wrapper.UpdateAssetAuthority": {
        const d = encodeUpdateAssetAuthority({ assetIndex: 0, marketId: 5n, kind: 1, newPubkey: new PublicKey(KEEPER), authorityEpoch: epoch });
        epoch += 1n;
        return w(d, [acc(PAYER, true, true), acc(KEEPER, true, false), ...rand(2)]);
      }
      case "wrapper.TopUpInsurance":
        return w(encodeTopUpInsurance({ marketId: 5n, intentId: 1n, authorityEpoch: epoch, amount: 10n }), rand(6));
      case "wrapper.UpdateFeeSplit":
        return w(encodeUpdateFeeSplit({ creatorShareBps: 1, lpShareBps: 2, insuranceShareBps: 3, authorityEpoch: epoch }), rand(3));
      case "wrapper.CreateLpVault":
        return w(Uint8Array.of(IX_TAG.CreateLpVault), rand(5));
      case "wrapper.InitLpShareMetadata":
        throw new Error("not built");
      case "wrapper.DepositToLpVault": {
        const a = rand(11);
        if (i > bindLp) {
          a.push(acc(lpState, false, true), acc(lpPortfolio, false, false));
        }
        return w(Uint8Array.of(IX_TAG.DepositToLpVault, 1), a);
      }
      case "wrapper.InitVaultLp": {
        const a = rand(6);
        a[3] = acc(lpState);
        a[4] = acc(lpPortfolio);
        return w(Uint8Array.of(IX_TAG_P3.InitVaultLp), a);
      }
      case "wrapper.InitBondTranche":
        return w(Uint8Array.of(107), rand(4));
      case "wrapper.DepositJuniorTranche":
        return w(Uint8Array.of(IX_TAG_P3.DepositJuniorTranche), rand(4));
      case "stake.InitPool":
        return { programId: STAKE, accounts: rand(6), data: Uint8Array.of(STAKE_IX.InitPool) };
      case "stake.BindInsuranceAuthority":
        return { programId: STAKE, accounts: [acc(key(r)), acc(key(r), false, true), ...rand(2)], data: Uint8Array.of(STAKE_IX.BindInsuranceAuthority) };
      default:
        throw new Error(`unbuilt kind ${k}`);
    }
  });
  return { ixs, ctx: { programs: { wrapper: WRAPPER, stake: STAKE }, payer: PAYER, slab: SLAB, keeper: o.cosign ? KEEPER : null } };
}

const VARIANTS: Variant[] = [];
for (const v22 of [false, true])
  for (const cosign of [false, true])
    for (const memo of [false, true])
      for (const feeSplit of [false, true])
        for (const bond of v22 ? [false, true] : [false])
          VARIANTS.push({ v22, cosign, memo, feeSplit, bond, staleResolve: v22 });

const clone = (ixs: NeutralIx[]): NeutralIx[] =>
  ixs.map((ix) => ({ programId: ix.programId, data: Uint8Array.from(ix.data), accounts: ix.accounts.map((a) => ({ ...a })) }));

/** Optional kinds: inserting / dropping one of these can legitimately produce another VALID launch shape. */
const OPTIONAL: readonly LaunchIxKind[] = [
  "memo",
  "wrapper.UpdateFeeSplit",
  "wrapper.InitBondTranche",
  "wrapper.InitLpShareMetadata",
  "wrapper.LevGuardInit",
  "wrapper.ConfigurePermissionlessResolve",
];

/**
 * Apply one random mutation in place. Returns true when the result is invalid BY CONSTRUCTION (so the validator must report it),
 * false when the mutation may leave a valid bundle (only the no-throw oracle applies).
 */
const lastM: number[] = [];
function mutate(ixs: NeutralIx[], ctx: LaunchBundleContext, r: R, v: Variant): boolean {
  const kinds = ixs.map((ix) => classifyLaunchIx(ix, ctx.programs));
  const m = int(r, 14);
  lastM.push(m);
  const n = ixs.length;
  if (n === 0 && m !== 8) return false;
  const i = int(r, Math.max(n, 1));
  const ix = ixs[i];
  const k = kinds[i];
  switch (m) {
    case 0: {
      // truncate data
      const to = r() < 0.5 ? 0 : int(r, ix!.data.length + 1);
      const before = ix!.data.length;
      ix!.data = ix!.data.slice(0, to);
      if (to === before) return false;
      // Empty data always changes the class (wrapper/stake/system/ata.createIdempotent -> other) except memo and ata.create.
      if (to === 0) return k !== "memo" && k !== "ata.create";
      return k === "system.createAccount" || k === "wrapper.ConfigurePermissionlessResolve" ||
        (k === "wrapper.ConfigureAuthMark" && to < 35) || (k === "wrapper.UpdateAssetAuthority" && to < 52) ||
        (k === "wrapper.TopUpInsurance" && to < 25) || (k === "wrapper.UpdateFeeSplit" && to < 15);
    }
    case 1: {
      // extend data
      ix!.data = cat(ix!.data, Uint8Array.of(0xff, 0xff));
      return k === "system.createAccount" || k === "wrapper.ConfigurePermissionlessResolve" || k === "ata.create" || k === "ata.createIdempotent";
    }
    case 2:
      // wrong program id
      ix!.programId = key(r);
      return true;
    case 3: {
      // drop an instruction
      ixs.splice(i, 1);
      return !(k === "memo" || k === "wrapper.UpdateFeeSplit");
    }
    case 4:
      // duplicate an instruction
      ixs.splice(i, 0, { programId: ix!.programId, data: Uint8Array.from(ix!.data), accounts: ix!.accounts.map((a) => ({ ...a })) });
      return true;
    case 5: {
      // drop an account
      if (ix!.accounts.length === 0) return false;
      const p = int(r, ix!.accounts.length);
      ix!.accounts.splice(p, 1);
      if (k === "stake.BindInsuranceAuthority") return p <= 1; // pool (index 1) shifted / gone: no writable pool
      if (k === "wrapper.DepositToLpVault" || k === "wrapper.ConfigurePermissionlessResolve") return true;
      if (k === "system.createAccount" || k === "wrapper.InitMarket" || k === "ata.create" || k === "ata.createIdempotent") return p === 0 || (p === 1 && k !== "ata.create" && k !== "ata.createIdempotent");
      if (k === "wrapper.UpdateAssetAuthority") return p === 1;
      return false;
    }
    case 6: {
      // duplicate an account inside the instruction
      if (ix!.accounts.length === 0) return false;
      ix!.accounts.push({ ...pick(r, ix!.accounts) });
      return k === "wrapper.DepositToLpVault" || k === "wrapper.ConfigurePermissionlessResolve";
    }
    case 7: {
      // copy the keeper into another instruction (keeper in 2 slots), or into a non-UAA ix when there is none
      const t = ixs[int(r, n)]!;
      t.accounts.push({ key: KEEPER, signer: false, writable: false });
      return ctx.keeper !== null;
    }
    case 8: {
      // insert a garbage instruction
      const programId = pick(r, [SYSTEM, ATA, MEMO, WRAPPER, STAKE, key(r)]);
      const data = Uint8Array.from({ length: int(r, 60) }, () => (r() < 0.4 ? pick(r, [0, 1, 38, 107, 122, 124, IX_TAG.ConfigureAuthMark, IX_TAG.TopUpInsurance]) : int(r, 256)));
      const accounts = Array.from({ length: int(r, 14) }, () => ({ key: r() < 0.3 ? pick(r, [PAYER, SLAB, KEEPER]) : key(r), signer: r() < 0.3, writable: r() < 0.5 }));
      const g: NeutralIx = { programId, data, accounts };
      ixs.splice(int(r, n + 1), 0, g);
      const gk = classifyLaunchIx(g, ctx.programs);
      return !OPTIONAL.includes(gk);
    }
    case 9: {
      // swap two adjacent instructions of different kinds
      if (n < 2) return false;
      const j = Math.min(i, n - 2);
      const differ = kinds[j] !== kinds[j + 1];
      [ixs[j], ixs[j + 1]] = [ixs[j + 1]!, ixs[j]!];
      return differ;
    }
    case 10: {
      // flip a byte in the replay-lane fields (sequence / epoch)
      if (k === "wrapper.ConfigureAuthMark" && ix!.data.length >= 35) ix!.data[27 + int(r, 8)]! ^= 1 << int(r, 8);
      else if (k === "wrapper.UpdateAssetAuthority" && ix!.data.length >= 52) ix!.data[44 + int(r, 8)]! ^= 1 << int(r, 8);
      else if (k === "wrapper.TopUpInsurance" && ix!.data.length >= 25) ix!.data[17 + int(r, 8)]! ^= 1 << int(r, 8);
      else if (k === "wrapper.UpdateFeeSplit" && ix!.data.length >= 15) ix!.data[7 + int(r, 8)]! ^= 1 << int(r, 8);
      else return false;
      return true;
    }
    case 11:
      // keeper null vs set (or the payer / a program as keeper)
      ctx.keeper = ctx.keeper === null ? KEEPER : r() < 0.5 ? null : pick(r, [PAYER, WRAPPER, key(r)]);
      return v.cosign ? ctx.keeper !== KEEPER : true;
    case 12: {
      // BindInsuranceAuthority without accounts[1] / without any account
      const b = kinds.indexOf("stake.BindInsuranceAuthority");
      if (b < 0) return false;
      ixs[b]!.accounts = ixs[b]!.accounts.slice(0, int(r, 2));
      return true;
    }
    default: {
      // flip a flag: payer signer / writable on a create, or the keeper's signer/writable
      const a = ix!.accounts[int(r, Math.max(ix!.accounts.length, 1))];
      if (!a) return false;
      if (k === "stake.BindInsuranceAuthority" && ix!.accounts[1] === a) {
        a.writable = false;
        return true;
      }
      if (a.key === KEEPER) {
        if (r() < 0.5) a.signer = false;
        else a.writable = true;
        return true;
      }
      if (k === "system.createAccount" && ix!.accounts[1] === a) {
        a.signer = false;
        return true;
      }
      a.signer = !a.signer;
      return false;
    }
  }
}

describe("launchBundleViolations: seeded fuzz", () => {
  beforeAll(() => __setDevnetV22ForTest(true));
  afterAll(() => __setDevnetV22ForTest(null));

  it("baseline: every un-mutated variant is valid under its flag state", () => {
    for (const v of VARIANTS) {
      __setDevnetV22ForTest(v.v22);
      cursor = 10;
      const { ixs, ctx } = buildValid(v, rng(11));
      expect(launchBundleViolations(ixs, ctx), JSON.stringify(v)).toEqual([]);
    }
  });

  it("never throws and always reports a guaranteed-invalid bundle (2,000 bundles, seeded)", () => {
    const RUNS = Number(process.env.FUZZ_RUNS ?? 2_000);
    const r = rng(0xc0ffee);
    let throws = 0;
    let mustReport = 0;
    let missed = 0;
    const samples: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const v = pick(r, VARIANTS);
      __setDevnetV22ForTest(v.v22);
      cursor = 10 + int(r, 300);
      const { ixs, ctx } = buildValid(v, r);
      let invalid = false;
      lastM.length = 0;
      const steps = r() < 0.6 ? 1 : 2 + int(r, 2);
      for (let s = 0; s < steps; s++) invalid = mutate(ixs, ctx, r, v) || invalid;
      // Stacked mutations can cancel each other (dup then drop), so a violation is only demanded for a single mutation.
      if (steps > 1) invalid = false;
      let out: string[] | undefined;
      try {
        out = launchBundleViolations(ixs, ctx);
      } catch (e) {
        throws++;
        if (samples.length < 5) samples.push(`throw run ${run} m=${lastM} ${JSON.stringify(v)}: ${(e as Error).stack?.split('\n').slice(0,4).join('|')}`);
        continue;
      }
      if (invalid) {
        mustReport++;
        if (out.length === 0) {
          missed++;
          if (samples.length < 5) samples.push(`missed run ${run} m=${lastM} ${JSON.stringify(v)} kinds=${ixs.map((x) => classifyLaunchIx(x, ctx.programs)).join(',')} progs=${ixs.map((x) => x.programId.slice(0, 4)).join(',')}`);
        }
      }
    }
    console.log(`fuzz: runs=${RUNS} throws=${throws} guaranteed-invalid=${mustReport} missed=${missed}`);
    expect(samples).toEqual([]);
    expect(throws).toBe(0);
    expect(missed).toBe(0);
    expect(mustReport).toBeGreaterThan(RUNS / 4);
  }, 30_000);

  it("an empty bundle and degenerate ones are reported, not thrown", () => {
    __setDevnetV22ForTest(true);
    const ctx: LaunchBundleContext = { programs: { wrapper: WRAPPER, stake: STAKE }, payer: PAYER, slab: SLAB, keeper: null };
    expect(launchBundleViolations([], ctx).length).toBeGreaterThan(0);
    const bare: NeutralIx = { programId: WRAPPER, accounts: [], data: new Uint8Array(0) };
    expect(launchBundleViolations([bare], ctx).length).toBeGreaterThan(0);
    expect(launchBundleViolations([bare], { ...ctx, keeper: KEEPER }).length).toBeGreaterThan(0);
  });
});

describe("replay-lane offsets (OFF in shape.ts) vs the SDK encoders", () => {
  const readU64 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true);

  it("ConfigureAuthMark / PushAuthMark: now_slot at 11, observation sequence at 27", () => {
    for (const enc of [encodeConfigureAuthMark, encodePushAuthMark] as const) {
      const d = enc({ assetIndex: 0xabcd, marketId: 0x1111n, nowSlot: 0x2222n, initialMarkE6: 0x3333n, markE6: 0x3333n, observationSequence: 0x4444n } as never);
      expect(d.length).toBe(35);
      expect(readU64(d, 11)).toBe(0x2222n);
      expect(readU64(d, 19)).toBe(0x3333n);
      expect(readU64(d, 27)).toBe(0x4444n);
    }
    const d = encodeConfigureAuthMark({ assetIndex: 0, marketId: 1n, nowSlot: 987n, initialMarkE6: 5n, observationSequence: 1n });
    expect(configureAuthMarkNowSlot({ programId: WRAPPER, accounts: [], data: d })).toBe(987n);
    expect(configureAuthMarkNowSlot({ programId: WRAPPER, accounts: [], data: d.slice(0, 18) })).toBeNull();
  });

  it("UpdateAssetAuthority: epoch at 1+2+8+1+32 = 44", () => {
    const d = encodeUpdateAssetAuthority({ assetIndex: 3, marketId: 9n, kind: 1, newPubkey: new PublicKey(KEEPER), authorityEpoch: 0x5555n });
    expect(d.length).toBe(52);
    expect(readU64(d, 44)).toBe(0x5555n);
  });

  it("TopUpInsurance: authority epoch at 17 (after market u64 + intent u64)", () => {
    const d = encodeTopUpInsurance({ marketId: 0x11n, intentId: 0x22n, authorityEpoch: 0x33n, amount: 0x44n });
    expect(readU64(d, 1)).toBe(0x11n);
    expect(readU64(d, 9)).toBe(0x22n);
    expect(readU64(d, 17)).toBe(0x33n);
  });

  it("UpdateFeeSplit: authority epoch at 7 (after 3 x u16)", () => {
    const d = encodeUpdateFeeSplit({ creatorShareBps: 1, lpShareBps: 2, insuranceShareBps: 3, authorityEpoch: 0x66n });
    expect(d.length).toBe(15);
    expect(readU64(d, 7)).toBe(0x66n);
  });
});
