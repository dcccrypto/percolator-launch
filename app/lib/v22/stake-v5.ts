/**
 * First-loss staking (stake v5): pure helpers. The consent text the program enforces is
 * `STAKE_CONSENT_TEXT_V2` (lib/v22/copy.ts); a deposit carries version 2 plus the pool's current
 * target / buffer / hysteresis (the target is the larger of the committed and a pending one). If any of
 * those change between what the user read and what is sent, the program refuses with 33 (ConsentRequired),
 * so the hook re-reads the pool right before building and asks for consent again.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_STAKE_DEPOSIT_V5,
  CONSENT_VERSION_FIRST_LOSS_V5,
  STAKE_RISK_MODE,
  consentParamsForPoolV5,
  decodeStakePoolV5,
  deriveInsuranceUnitsV22,
  encodeStakeDepositWithConsentV5,
  stakeMetasV5,
  type StakeDeployParamsV5,
  type StakePoolV5,
} from "./sdk";

/** The pool as a first-loss v5 pool, or null for any other pool (older versions, fee-only, unreadable). */
export function readFirstLossPool(data: Uint8Array | null | undefined): StakePoolV5 | null {
  if (!data) return null;
  try {
    const p = decodeStakePoolV5(data);
    return p.riskMode === STAKE_RISK_MODE.FirstLoss ? p : null;
  } catch {
    return null;
  }
}

/** What the user is shown and consents to. */
export interface ConsentView extends StakeDeployParamsV5 {
  version: number;
}

export function consentViewOf(pool: StakePoolV5): ConsentView {
  return { ...consentParamsForPoolV5(pool), version: CONSENT_VERSION_FIRST_LOSS_V5 };
}

/** Stable key of the numbers the consent covers; a changed key invalidates the checkbox. */
export function consentKey(c: ConsentView): string {
  return `${c.version}:${c.targetBps}:${c.bufferBps}:${c.hysteresisBps}`;
}

export const pctOfBps = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** Thrown by the hook when the pool's numbers changed after the user consented. */
export class ConsentChangedError extends Error {
  readonly name = "ConsentChangedError";
  constructor(readonly now: ConsentView) {
    super("The pool's settings changed. Please review and accept again.");
  }
}

export interface BuildStakeDepositV5 {
  stakeProgramId: PublicKey;
  pool: PublicKey;
  poolState: StakePoolV5;
  user: PublicKey;
  userCollateral: PublicKey;
  userLp: PublicKey;
  vaultAuthority: PublicKey;
  depositPda: PublicKey;
  amount: bigint;
}

/** The first-loss deposit instruction: 16-byte data, 14 accounts (`ACCOUNTS_STAKE_DEPOSIT_V5`). */
export function buildStakeDepositV5Ix(p: BuildStakeDepositV5): TransactionInstruction {
  const data = encodeStakeDepositWithConsentV5(p.amount, consentParamsForPoolV5(p.poolState), CONSENT_VERSION_FIRST_LOSS_V5);
  const keys = stakeMetasV5(ACCOUNTS_STAKE_DEPOSIT_V5, {
    user: p.user,
    pool: p.pool,
    userCollateral: p.userCollateral,
    vault: p.poolState.vault,
    lpMint: p.poolState.lpMint,
    userLp: p.userLp,
    vaultAuthority: p.vaultAuthority,
    deposit: p.depositPda,
    market: p.poolState.slab,
    insuranceUnits: deriveInsuranceUnitsV22(p.poolState.percolatorProgram, p.poolState.slab)[0],
    wrapperProgram: p.poolState.percolatorProgram,
  });
  return new TransactionInstruction({ programId: p.stakeProgramId, keys, data: Buffer.from(data) });
}
