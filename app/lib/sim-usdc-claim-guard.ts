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
 * createAccountWithSeed from the faucet authority to a MARKER address derived from (wallet, UTC day) under a
 * server-side secret (HMAC; see resolveMarkerKey), so third parties cannot pre-fund it. The address
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
import { createHash, createHmac } from "crypto";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

/** Rent-exempt minimum for a 0-byte account (devnet/mainnet: 128 bytes overhead x 6960 lamports/byte-year x 2 yrs). */
export const CLAIM_MARKER_RENT_LAMPORTS = 890_880;

/** A claim this close to the end of the UTC day also reserves tomorrow's marker. */
export const MIDNIGHT_GUARD_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day number for `now`. */
export function utcDay(now: number): number {
  return Math.floor(now / DAY_MS);
}

/** Domain tags: keep the marker MAC and the key derivation from ever sharing an input with anything else. */
const MARKER_SEED_DOMAIN = "percolator-sim-usdc-claim-marker/v2";
const MARKER_KEY_DOMAIN = "percolator-sim-usdc-claim-marker-key/v1";

/**
 * Server-only secret that keys the marker seed. Without it the marker address is not computable, so nobody can
 * pre-fund a victim's marker (which would make their claim fail as "already claimed").
 *
 * 1. SIM_USDC_MARKER_KEY (dedicated env var, >= 32 chars of random data, e.g. `openssl rand -base64 32`), if set.
 *    A set-but-shorter value throws instead of silently falling back, so a weak key is never used.
 * 2. Otherwise derived from the faucet authority's sealed signer: an Ed25519 signature is deterministic and cannot
 *    be produced without the secret key, so HMAC(signMessage(domain tag)) is a stable key that never exposes (or
 *    needs) the secret key itself. The signer's audit log records only the message length.
 * Throws when neither exists (fail closed: never fall back to a public derivation). Never log the result.
 */
export function resolveMarkerKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const dedicated = env.SIM_USDC_MARKER_KEY;
  if (dedicated) {
    if (dedicated.length < 32) {
      throw new Error("claim marker key unavailable: SIM_USDC_MARKER_KEY must be at least 32 characters");
    }
    return createHmac("sha256", MARKER_KEY_DOMAIN).update(dedicated).digest();
  }
  const signer = getDevnetMintSigner();
  if (signer) {
    const sig = signer.signMessage(new TextEncoder().encode(MARKER_KEY_DOMAIN));
    return createHmac("sha256", MARKER_KEY_DOMAIN).update(sig).digest();
  }
  throw new Error("claim marker key unavailable: set SIM_USDC_MARKER_KEY or DEVNET_MINT_AUTHORITY_KEYPAIR");
}

/**
 * 32-char seed (the createAccountWithSeed maximum): base64url of the first 24 bytes (192 bits) of
 * HMAC-SHA256(key, domain || 0x00 || wallet || 0x00 || day). base64url is ASCII, so 32 chars = 32 bytes. 192 bits keeps
 * the birthday bound at ~2^96 markers, far beyond any real claim volume.
 */
export function claimMarkerSeed(wallet: string, day: number, key: Uint8Array = resolveMarkerKey()): string {
  return createHmac("sha256", key)
    .update(`${MARKER_SEED_DOMAIN}\0${wallet}\0${day}`)
    .digest()
    .subarray(0, 24)
    .toString("base64url");
}

/** The pre-fix public derivation. Retained ONLY so tests can assert the new addresses differ from it. */
export function legacyClaimMarkerSeed(wallet: string, day: number): string {
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
export async function markerAddresses(
  authority: PublicKey,
  wallet: string,
  days: number[],
  key: Uint8Array = resolveMarkerKey(),
): Promise<ClaimMarker[]> {
  return Promise.all(
    days.map(async (day) => {
      const seed = claimMarkerSeed(wallet, day, key);
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
