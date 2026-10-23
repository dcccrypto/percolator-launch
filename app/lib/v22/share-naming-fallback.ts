/**
 * Share-token naming (tag 122) is cosmetic, but it rides in the launch transaction and depends on a third-party program (Metaplex) and on the
 * creator holding 0.03 SOL at that instruction. It must never be able to stop a launch:
 *   - {@link shareNamingAffordable}: a balance preflight (flag off: false, and NO RPC call);
 *   - {@link isShareNamingFailure}: did a simulation refusal come from tag 122 (the failing instruction is the wrapper's 122, or the Metaplex
 *     program is the one that failed)?
 *   - {@link withoutShareNaming}: the same instructions minus tag 122, for the automatic retry. The share can be named later with the
 *     permissionless generic form, or by the creator while still marketauth.
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { isShareNamingEnabled, SHARE_NAMING_HOLD_LAMPORTS } from "./share-naming";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22 } from "./sdk";

/** Lamports of headroom over the 30,000,000 hold (ATA rent and fees of the same transaction). */
export const SHARE_NAMING_BALANCE_HEADROOM_LAMPORTS = 5_000_000;
const TAG = 122;

/** Whether to include tag 122: naming on AND the wallet holds the hold plus headroom. A failed balance read means "do not name" (never blocks). */
export async function shareNamingAffordable(connection: Pick<Connection, "getBalance">, wallet: PublicKey): Promise<boolean> {
  if (!isShareNamingEnabled()) return false;
  try {
    return (await connection.getBalance(wallet, "confirmed")) >= SHARE_NAMING_HOLD_LAMPORTS + SHARE_NAMING_BALANCE_HEADROOM_LAMPORTS;
  } catch {
    return false;
  }
}

export const isShareNamingIx = (ix: TransactionInstruction, wrapper: PublicKey): boolean => ix.programId.equals(wrapper) && ix.data[0] === TAG;

export function withoutShareNaming(ixs: readonly TransactionInstruction[], wrapper: PublicKey): TransactionInstruction[] {
  return ixs.filter((ix) => !isShareNamingIx(ix, wrapper));
}

/** Index of the failing instruction in `{"InstructionError":[n, ...]}`, from an error object or a string that contains its JSON. */
export function failingInstructionIndex(errOrText: unknown): number | null {
  if (errOrText && typeof errOrText === "object") {
    const ie = (errOrText as { InstructionError?: unknown }).InstructionError;
    return Array.isArray(ie) && typeof ie[0] === "number" ? ie[0] : null;
  }
  if (typeof errOrText === "string") {
    const m = /"InstructionError"\s*:\s*\[\s*(\d+)/.exec(errOrText);
    return m ? Number(m[1]) : null;
  }
  return null;
}

export interface ShareNamingFailureEvidence {
  /** Program and first data byte of the failing top-level instruction, when known. */
  failingProgram?: string | null;
  failingTag?: number | null;
  logs?: readonly string[];
}

/** True when the failure is tag 122's own: the failing instruction is the wrapper's 122, or a log line says the Metaplex program failed. */
export function isShareNamingFailure(e: ShareNamingFailureEvidence, wrapper: PublicKey): boolean {
  if (e.failingProgram === wrapper.toBase58() && e.failingTag === TAG) return true;
  const mpl = METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBase58();
  return (e.logs ?? []).some((l) => l.startsWith(`Program ${mpl} failed`));
}

/** Evidence from a single-transaction refusal: the index is into the planned instruction list (a v1 message has no budget instructions). */
export function evidenceFromPlan(err: unknown, logs: readonly string[] | undefined, planned: readonly TransactionInstruction[]): ShareNamingFailureEvidence {
  const i = failingInstructionIndex(err);
  const ix = i === null ? undefined : planned[i];
  return { failingProgram: ix?.programId.toBase58() ?? null, failingTag: ix ? ix.data[0] ?? null : null, logs };
}

/**
 * Send the Earn seed transaction (`send(nameShare)`, simulate-first, so a refusal means nothing was signed). If it is refused AT tag 122, send
 * the same seed once without the naming; any other failure, and a failure of the retry, propagate unchanged.
 */
export async function sendWithShareNamingFallback(
  send: (nameShare: boolean) => Promise<string>,
  nameShare: boolean,
  wrapper: PublicKey,
  evidenceOf: (e: unknown) => ShareNamingFailureEvidence | null,
  onFallback?: (e: unknown) => void,
): Promise<{ signature: string; named: boolean }> {
  try {
    return { signature: await send(nameShare), named: nameShare };
  } catch (e) {
    const ev = nameShare ? evidenceOf(e) : null;
    if (!ev || !isShareNamingFailure(ev, wrapper)) throw e;
    onFallback?.(e);
    return { signature: await send(false), named: false };
  }
}
