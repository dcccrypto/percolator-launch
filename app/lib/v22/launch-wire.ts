/**
 * v2.2 launch wiring (pure): the InitMarket data with the merged trailer, the bond-tranche instruction, and the
 * ONE place that decides where tag 107 sits inside the single-transaction launch.
 *
 * Why the order matters (Wave C security review, N-2 and M-2): InitBondTranche (107) is refused forever once the vault
 * has ANY Earn deposit, and it needs the BOUND vault LP (so it follows tag 94). The v2.1 launch seeds the Earn vault
 * (tag 75 x2) between 74 and 94; with a bond that segment moves to AFTER 107:
 *
 *   ... 74 CreateLpVault, createAccount(portfolio), createAccount(matcher ctx), 94 InitVaultLp, 107 InitBondTranche,
 *       ata.createIdempotent, 75, 75, 96 DepositJunior, ...
 *
 * and the whole launch stays ONE transaction. There is no split: a bond launch with no single-transaction path is
 * refused with a calm message ({@link bondNeedsSingleTxMessage}) rather than sent in pieces.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { deriveVaultLpExt } from "@/lib/v21/sdk";
import { GROWTH_MAX_COLLATERAL_DECIMALS, growthCollateralDecimalsOk } from "@/lib/v22/sdk/records/growth-v19";
import { encodeInitMarketData, type GrowthLaunch } from "@/lib/v21/growth-launch";
import type { InitMarketV17Args } from "@percolatorct/sdk";
import { withBoundVaultLpTailP3 } from "./sdk/records/p3-vault-lp";
import { buildInitBondTrancheIxV22, encodeInitMarketV22, IX_TAG_V22, type InitBondTrancheArgs } from "./sdk";
import type { V22LaunchParams } from "./launch-plan";
import { isDevnetV22Enabled } from "./flag";
import { resolveMarketGeometry } from "./sdk/layout";
import { parseWrapperConfigV17 } from "./sdk/slab";

/** Tag numbers the reorder keys on (wrapper tags). */
const TAG_CREATE_LP_VAULT = 74;
const TAG_INIT_VAULT_LP = 94;

/** InitMarket data: unchanged v2.1 bytes unless a v2.2 plan is present (then the merged trailer). */
export function encodeInitMarketDataWithV22(args: InitMarketV17Args, growth: GrowthLaunch | undefined, v22: V22LaunchParams | undefined): Uint8Array {
  if (!v22 || !growth) return encodeInitMarketData(args, growth);
  if (growth.collateralDecimals !== undefined && !growthCollateralDecimalsOk(growth.collateralDecimals)) {
    throw new Error(`collateral with ${growth.collateralDecimals} decimals cannot carry a leveraged market (max ${GROWTH_MAX_COLLATERAL_DECIMALS})`);
  }
  return encodeInitMarketV22(args, {
    rGapBps: growth.rGapBps,
    lLaunchX100: growth.lLaunchX100,
    ...(v22.lotExp > 0 ? { lotExp: v22.lotExp } : {}),
    ...(v22.rent ? { rent: v22.rent } : {}),
    ...(v22.band ? { band: v22.band } : {}),
  });
}

/** Tag 107 for a fresh market. The creator is the marketauth AND pays (there is no upgrade-authority path at launch). */
export function buildLaunchBondIx(programId: PublicKey, market: PublicKey, creator: PublicKey, dials: InitBondTrancheArgs): TransactionInstruction {
  return buildInitBondTrancheIxV22({ programId, market, registryDomain: 0, vaultLpExt: deriveVaultLpExt(programId, market) }, creator, creator, dials);
}

const isCreate = (ix: TransactionInstruction): boolean =>
  ix.programId.equals(SystemProgram.programId) && ix.data.length === 52 && ix.data[0] === 0 && ix.data[1] === 0 && ix.data[2] === 0 && ix.data[3] === 0;

/**
 * Insert `bondIx` into a flat single-transaction launch list: directly after tag 94, with the Earn-seed segment (everything
 * between tag 74 and the two createAccounts that open tag 94) moved to after it. Everything else keeps its order. Pure.
 *
 * @throws if the list is not a 74 ... [seed] createAccount createAccount 94 launch (never guesses).
 */
export function placeBondTranche(instructions: readonly TransactionInstruction[], bondIx: TransactionInstruction, wrapper: PublicKey): TransactionInstruction[] {
  const at = (tag: number): number => instructions.findIndex((x) => x.programId.equals(wrapper) && x.data[0] === tag);
  const i74 = at(TAG_CREATE_LP_VAULT);
  const i94 = at(TAG_INIT_VAULT_LP);
  if (i74 < 0 || i94 < 0 || i94 < i74) throw new Error("placeBondTranche: the launch has no CreateLpVault followed by InitVaultLp");
  if (instructions.some((x) => x.programId.equals(wrapper) && x.data[0] === IX_TAG_V22.InitBondTranche)) throw new Error("placeBondTranche: the launch already carries a bond tranche");
  const a = instructions[i94 - 1];
  const b = instructions[i94 - 2];
  if (!a || !b || !isCreate(a) || !isCreate(b) || i94 - 2 <= i74) throw new Error("placeBondTranche: InitVaultLp is not preceded by its two createAccounts");
  // F2: after 94 the vault is BOUND, so each Earn seed (tag 75) needs the tail [11] vault_lp_state (w) and [12] the vault LP
  // portfolio, which are exactly accounts [3] and [4] of the InitVaultLp that precedes it. Anything else in the segment
  // (the LP-share ATA create) passes through unchanged.
  const bind = instructions[i94]!;
  const lpState = bind.keys[3]?.pubkey;
  const lpPortfolio = bind.keys[4]?.pubkey;
  if (!lpState || !lpPortfolio) throw new Error("placeBondTranche: InitVaultLp has no vault_lp_state / LP portfolio accounts");
  const seed = instructions.slice(i74 + 1, i94 - 2).map((x) => (x.programId.equals(wrapper) && x.data[0] === 75 ? withBoundVaultLpTailP3(x, lpState, lpPortfolio) : x));
  return [...instructions.slice(0, i74 + 1), b, a, instructions[i94]!, bondIx, ...seed, ...instructions.slice(i94 + 1)];
}

/** What the wizard says when a bond launch cannot go as one transaction. Calm; names no mechanics. */
export const bondNeedsSingleTxMessage =
  "A launch with a bond has to go in a single approval, and this wallet or network can't do that right now. Launch without the bond, or try a wallet that supports it.";

/**
 * I-1 (#3634 review): a resume past the first step can't take a bond. Tag 107 needs the vault LP bound (the last
 * step's tag 94) and no Earn shares yet, and the step before it seeds Earn, so a split launch can never add one.
 */
export const bondResumeMessage = "A bond can only be added when a market is first created, and this launch is already under way. Continue without the bond.";

/** What the wizard says when the bundle is too big to stay one transaction. */
export const bondBundleTooLargeMessage = "A bond doesn't fit in the launch transaction for this market. Launch without the bond.";

/** Tag 38 ConfigurePermissionlessResolve (wrapper `v16_program.rs` decode: `[38, frontier u64, stale_slots u64, force_close_delay u64, policy_sequence u64]`, 33 B). */
export const TAG_CONFIGURE_PERMISSIONLESS_RESOLVE = 38;
/** The stale window every v2.2 market gets (the seed kit's markets.v22.json): ~72 min at 400 ms; InitMarket writes 0 = a stale mark stays tradable forever. */
export const PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22 = 18_000n;
/** Seed kit value (markets.v22.json forceCloseDelaySlots): about a day. */
export const FORCE_CLOSE_DELAY_SLOTS_V22 = 216_000n;

export function encodeConfigurePermissionlessResolveV22(a: { assetGenerationFrontier: bigint; staleSlots: bigint; forceCloseDelaySlots: bigint; policySequence: bigint }): Uint8Array {
  const out = new Uint8Array(33);
  const dv = new DataView(out.buffer);
  out[0] = TAG_CONFIGURE_PERMISSIONLESS_RESOLVE;
  dv.setBigUint64(1, a.assetGenerationFrontier, true);
  dv.setBigUint64(9, a.staleSlots, true);
  dv.setBigUint64(17, a.forceCloseDelaySlots, true);
  dv.setBigUint64(25, a.policySequence, true);
  return out;
}

/**
 * Tag 38 for a FRESH market: marketauth (the creator, signer) and the market (writable). A fresh market's asset-generation frontier is
 * `slots + 1` (initialAssetGenerationFrontier) and its permissionless-resolve control sequence is 0, so the policy sequence is 1.
 * Must run before the stake InitPool rotates marketauth; the launch puts it right after InitMarket.
 */
export function buildConfigurePermissionlessResolveIxV22(programId: PublicKey, marketauth: PublicKey, market: PublicKey, assetSlots: number): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: marketauth, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      encodeConfigurePermissionlessResolveV22({
        assetGenerationFrontier: BigInt(assetSlots) + 1n,
        staleSlots: PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22,
        forceCloseDelaySlots: FORCE_CLOSE_DELAY_SLOTS_V22,
        policySequence: 1n,
      }),
    ),
  });
}

/** The v2.2 launch ALWAYS sets the stale window (S1-7: a market left at 0 never becomes resolvable by anyone). Empty with the flag off. */
export function staleResolveLaunchIxs(programId: PublicKey, marketauth: PublicKey, market: PublicKey, assetSlots: number): TransactionInstruction[] {
  return isDevnetV22Enabled() ? [buildConfigurePermissionlessResolveIxV22(programId, marketauth, market, assetSlots)] : [];
}

/**
 * Resume repair (AUD R-app-3562 L2): a market initialised without the stale window (by an earlier client or path) has
 * `permissionless_resolve_stale_slots == 0`. While the creator is still marketauth, tag 38 can still set it. Returns the slot count to build
 * the instruction with, or null when nothing is to be done (flag off, not a v2.2 market, window already set, or marketauth moved on,
 * after which only that authority could set it).
 */
export function staleWindowRepair(marketData: Uint8Array | null | undefined, creator: PublicKey): { assetSlots: number } | null {
  if (!isDevnetV22Enabled() || !marketData) return null;
  try {
    const g = resolveMarketGeometry(marketData, { parser: "staleWindowRepair", strictLength: false });
    const cfg = parseWrapperConfigV17(marketData);
    if (cfg.permissionlessResolveStaleSlots !== 0n || !cfg.marketauth.equals(creator) || g.slotCount < 1) return null;
    return { assetSlots: g.slotCount };
  } catch {
    return null;
  }
}
