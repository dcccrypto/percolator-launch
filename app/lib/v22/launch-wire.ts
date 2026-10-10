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
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { deriveVaultLpExt } from "@/lib/v21/sdk";
import { encodeInitMarketData, type GrowthLaunch } from "@/lib/v21/growth-launch";
import type { InitMarketV17Args } from "@percolatorct/sdk";
import { withBoundVaultLpTailP3 } from "./sdk/records/p3-vault-lp";
import { buildInitBondTrancheIxV22, encodeInitMarketV22, IX_TAG_V22, type InitBondTrancheArgs } from "./sdk";
import type { V22LaunchParams } from "./launch-plan";

/** Tag numbers the reorder keys on (wrapper tags). */
const TAG_CREATE_LP_VAULT = 74;
const TAG_INIT_VAULT_LP = 94;

/** InitMarket data: unchanged v2.1 bytes unless a v2.2 plan is present (then the merged trailer). */
export function encodeInitMarketDataWithV22(args: InitMarketV17Args, growth: GrowthLaunch | undefined, v22: V22LaunchParams | undefined): Uint8Array {
  if (!v22 || !growth) return encodeInitMarketData(args, growth);
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

/** What the wizard says when the bundle is too big to stay one transaction. */
export const bondBundleTooLargeMessage = "A bond doesn't fit in the launch transaction for this market. Launch without the bond.";
