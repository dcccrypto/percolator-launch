/**
 * Race-proof the no-database Sim-USDC daily claim (Council r4 N4, R3-5).
 *
 * The no-DB limiter is "read the wallet's ATA history, then mint": two requests 30 ms apart both read an empty
 * history and both mint. They only avoided a double mint when both built a byte-identical tx (same blockhash =>
 * same signature); across a blockhash change both would mint. Serverless instances share no memory and there is no
 * database by design, so the only store they share is the chain, and it must be written INSIDE the mint tx.
 *
 * Layer 1 (this file, in-process): one in-flight claim per wallet per instance (tryAcquireClaimLock).
 * Layer 2 (this file, on chain, no program change): every no-DB claim tx starts with a System-program
 * createAccountWithSeed from the faucet authority to a MARKER address derived from (wallet, UTC day). The address
 * is deterministic, so a second claim for the same wallet and day builds a tx whose first instruction fails with
 * "account already in use" (SystemError::AccountAlreadyInUse = Custom(0)) and the whole tx, mint included, reverts.
 * That holds across instances and across blockhashes, because the runtime serialises writes to the marker account.
 *
 * Cost: the marker holds the rent-exempt minimum for a 0-byte account (890,880 lamports). It is owned by the System
 * program with the faucet authority as base, so the authority can recover it with a transferWithSeed once the day
 * has passed (see markerAddresses). The stale marker is also what blocks that day's second claim, so reclaim only
 * markers from earlier days.
 *
 * Known edge: the marker is per UTC day, the history check is per rolling 24h. Two concurrent claims straddling
 * UTC midnight would use different markers, so a claim in the last MIDNIGHT_GUARD_MS of a day also reserves the
 * next day's marker. Sequential claims are still bounded by the rolling-24h history check.
 */
import { createHash } from "crypto";
import {
  PublicKey,
  SystemProgram,
  type ParsedTransactionWithMeta,
  type TransactionInstruction,
} from "@solana/web3.js";

/** Rent-exempt minimum for a 0-byte account (devnet/mainnet: 128 bytes overhead x 6960 lamports/byte-year x 2 yrs). */
export const CLAIM_MARKER_RENT_LAMPORTS = 890_880;

/** A claim this close to the end of the UTC day also reserves tomorrow's marker. */
export const MIDNIGHT_GUARD_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day number for `now`. */
export function utcDay(now: number): number {
  return Math.floor(now / DAY_MS);
}

/** 32-char seed (max allowed is 32 bytes) from sha256("percolator-sim-usdc-claim|wallet|day"). */
export function claimMarkerSeed(wallet: string, day: number): string {
  return createHash("sha256").update(`percolator-sim-usdc-claim|${wallet}|${day}`).digest("hex").slice(0, 32);
}

/** The UTC days whose markers a claim made at `now` must create (today, plus tomorrow in the last 2 minutes). */
export function claimMarkerDays(now: number): number[] {
  const day = utcDay(now);
  const msIntoDay = now - day * DAY_MS;
  return DAY_MS - msIntoDay <= MIDNIGHT_GUARD_MS ? [day, day + 1] : [day];
}

export interface ClaimMarker {
  day: number;
  seed: string;
  address: PublicKey;
}

/** The marker accounts for (wallet, claim time); also what a reclaim job derives for a past day. */
export async function markerAddresses(authority: PublicKey, wallet: string, days: number[]): Promise<ClaimMarker[]> {
  return Promise.all(
    days.map(async (day) => {
      const seed = claimMarkerSeed(wallet, day);
      return { day, seed, address: await PublicKey.createWithSeed(authority, seed, SystemProgram.programId) };
    }),
  );
}

/** The createAccountWithSeed instructions to put FIRST in the claim tx (authority pays the rent and signs as base). */
export async function buildClaimMarkerInstructions(
  authority: PublicKey,
  wallet: string,
  now: number = Date.now(),
): Promise<TransactionInstruction[]> {
  const markers = await markerAddresses(authority, wallet, claimMarkerDays(now));
  return markers.map((m) =>
    SystemProgram.createAccountWithSeed({
      fromPubkey: authority,
      newAccountPubkey: m.address,
      basePubkey: authority,
      seed: m.seed,
      lamports: CLAIM_MARKER_RENT_LAMPORTS,
      space: 0,
      programId: SystemProgram.programId,
    }),
  );
}

// ── Rent sweep (scripts/sweep-claim-markers.ts) ───────────────────────────────────────────────────────────

/**
 * True once a marker created at `createdAtMs` can no longer block any claim. A marker made on day D is for D, or for
 * D+1 when the claim was in the midnight guard (the seed hash does not say which), so wait until D+1 is over too.
 */
export function isMarkerSweepable(createdAtMs: number, now: number = Date.now()): boolean {
  return utcDay(createdAtMs) + 1 < utcDay(now);
}

/**
 * The claim markers a parsed tx created for `authority`: System createAccountWithSeed, base = authority,
 * owner = System, 0 bytes, and the new address really is createWithSeed(authority, seed, System).
 */
export async function claimMarkerCreatesIn(
  tx: ParsedTransactionWithMeta | null,
  authority: PublicKey,
): Promise<{ address: string; seed: string }[]> {
  const out: { address: string; seed: string }[] = [];
  const system = SystemProgram.programId.toBase58();
  for (const ix of tx?.transaction.message.instructions ?? []) {
    if (ix.programId.toBase58() !== system || !("parsed" in ix)) continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | null;
    const info = parsed?.info;
    if (parsed?.type !== "createAccountWithSeed" || !info) continue;
    if (info.base !== authority.toBase58() || info.owner !== system || info.space !== 0) continue;
    if (typeof info.seed !== "string" || typeof info.newAccount !== "string") continue;
    const expected = await PublicKey.createWithSeed(authority, info.seed, SystemProgram.programId);
    if (expected.toBase58() !== info.newAccount) continue;
    out.push({ address: info.newAccount, seed: info.seed });
  }
  return out;
}

/** transferWithSeed of `lamports` from a marker back to the authority (all of it closes the 0-byte account). */
export function buildMarkerSweepInstruction(
  authority: PublicKey,
  marker: { address: PublicKey; seed: string },
  lamports: number,
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: marker.address,
    basePubkey: authority,
    toPubkey: authority,
    lamports,
    seed: marker.seed,
    programId: SystemProgram.programId,
  });
}

/**
 * True when `err` says a marker create failed because the account exists: the preflight simulation text
 * ("already in use"), or an on-chain InstructionError Custom(0) at one of the first `markerCount` instructions.
 */
export function isClaimMarkerCollision(err: unknown, markerCount: number): boolean {
  if (err === null || err === undefined) return false;
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  else if (typeof err === "string") parts.push(err);
  const logs = (err as { logs?: unknown })?.logs;
  if (Array.isArray(logs)) parts.push(logs.filter((l): l is string => typeof l === "string").join("\n"));
  const txErr = (err as { transactionError?: unknown })?.transactionError;
  if (txErr !== undefined) {
    try {
      parts.push(JSON.stringify(txErr));
    } catch {
      /* ignore */
    }
  }
  const text = parts.join("\n");
  if (/already in use/i.test(text)) return true;
  for (const m of text.matchAll(/"InstructionError":\[(\d+),\{"Custom":0\}\]/g)) {
    if (Number(m[1]) < markerCount) return true;
  }
  return false;
}

// ── Layer 1: in-process, one in-flight claim per wallet ──────────────────────────────────────────────────────

const LOCK_KEY = "__percolatorSimUsdcClaimLocks__";
function locks(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g[LOCK_KEY] ??= new Set<string>());
}

/**
 * Take the wallet's claim lock for this instance. Returns a release function, or null when a claim for the wallet
 * is already running here (the caller answers 429). Shared by both faucet routes via globalThis.
 */
export function tryAcquireClaimLock(wallet: string): (() => void) | null {
  const held = locks();
  if (held.has(wallet)) return null;
  held.add(wallet);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(wallet);
  };
}

/** Shown to the loser of an in-flight race. */
export const SIM_USDC_CLAIM_IN_PROGRESS = "A claim for this wallet is already being processed. Check your balance in a moment.";
