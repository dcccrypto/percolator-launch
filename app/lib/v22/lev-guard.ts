/**
 * v2.2 leverage guard (wrapper tag 124) on the app side: where the guard account lives, whether a market has one, and the two
 * decisions that depend on it.
 *
 *  1. Trading: every TradeCpi (tag 10) / EvictAndTradeCpi (tag 119) the app builds appends the guard (writable, LAST account) when the
 *     market's guard account exists (`withLevGuardTailV22`; the program strips it). Omitting it on a guarded market fails an opening
 *     trade with Custom(132). Appending when the account does NOT exist is not safe (a system-owned account is not stripped, so it would
 *     be read as an extra account of the trade), so the tail is added only on a confirmed hit.
 *  2. Launch: the creator signs op 0 INIT (t0 = 0) right after the vault LP is bound, while still the market authority (StakeInitPool
 *     rotates it). The program refuses it (134) on a market with no bound vault LP or no growth block, so it is built only for a
 *     growth + vault-LP launch.
 *
 * Wire and rules: ledger `v22-lev-guard-wire-spec-2026-10-28.md`; the program is percolator-prog `src/lev_guard_v22.rs`.
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { buildLevGuardInitIxV22, deriveLevGuardV22, withLevGuardTailV22, TAG_LEV_GUARD_V22 } from "./sdk";

export { TAG_LEV_GUARD_V22 };

/** The guard PDA of a market (`["lev_guard", market]` under the wrapper). */
export function levGuardPda(programId: PublicKey, market: PublicKey): PublicKey {
  return deriveLevGuardV22(programId, market)[0];
}

/** The op 0 INIT instruction the creator (market authority) signs. `t0 = 0` = now; a creator can never backdate it. */
export function buildLevGuardInitIx(programId: PublicKey, market: PublicKey, creator: PublicKey): TransactionInstruction {
  return buildLevGuardInitIxV22({ programId, market }, creator, 0n);
}

/**
 * Whether an instruction should get the guard tail: only a TradeCpi / EvictAndTradeCpi, only when the guard account was found.
 * Pure; the single place the "append or not" rule is written down.
 */
export function shouldAppendLevGuard(guardExists: boolean, ixData: Uint8Array): boolean {
  if (!guardExists) return false;
  const tag = ixData[0];
  return tag === 10 || tag === 119;
}

/** Append the guard when `guardExists` (see {@link shouldAppendLevGuard}); otherwise return the instruction untouched. */
export function withLevGuardTail(ix: TransactionInstruction, market: PublicKey, guardExists: boolean): TransactionInstruction {
  return shouldAppendLevGuard(guardExists, ix.data) ? withLevGuardTailV22(ix, market) : ix;
}

// ── existence check, cached per (program, market) ───────────────────────────────────────────────
// A guard is never closed, so a hit is cached for the session. A miss is cached briefly: a creator may add the guard moments after
// the first trade screen loaded, and a stale "no" would send an opening trade without it (132).
const HIT = new Set<string>();
const MISS = new Map<string, number>();
export const LEV_GUARD_MISS_TTL_MS = 20_000;

const key = (programId: PublicKey, market: PublicKey): string => `${programId.toBase58()}:${market.toBase58()}`;

/** Test hook: forget everything cached. */
export function resetLevGuardCache(): void {
  HIT.clear();
  MISS.clear();
}

/**
 * Does the market have its leverage guard account (owned by the wrapper, so a stranger cannot fake one by funding the address)?
 * One `getAccountInfo`, cached per market. A failed read (or an underivable address) answers `false` WITHOUT caching, after one retry for the read, so the trade is
 * built as before and a guarded market answers 132, whose message tells the user to refresh.
 */
export async function levGuardExists(
  connection: Pick<Connection, "getAccountInfo">,
  programId: PublicKey,
  market: PublicKey,
  now: () => number = Date.now,
): Promise<boolean> {
  const k = key(programId, market);
  if (HIT.has(k)) return true;
  const missAt = MISS.get(k);
  if (missAt !== undefined && now() - missAt < LEV_GUARD_MISS_TTL_MS) return false;
  let pda: PublicKey;
  try {
    pda = levGuardPda(programId, market);
  } catch {
    // Never let the optional guard lookup stop a trade: no PDA means no tail, the order is built as before.
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const info = await connection.getAccountInfo(pda, "confirmed");
      const exists = !!info && info.owner.equals(programId) && info.data.length > 0;
      if (exists) HIT.add(k);
      else MISS.set(k, now());
      return exists;
    } catch {
      // retry once, then fall through to the uncached `false`
    }
  }
  return false;
}

// ── launch step ─────────────────────────────────────────────────────────────────────────────────

/** What the wizard's sequential path does about the guard after the vault LP is bound. */
export type LevGuardLaunchAction =
  /** Send op 0 now (the creator is still the market authority). */
  | { action: "send"; ix: TransactionInstruction }
  /** Nothing to do: the guard is already there (a resume, or the batched M4p carried it). */
  | { action: "exists" }
  /** Not a launch the guard applies to (flag off, no growth block, or no vault LP). */
  | { action: "not-applicable" }
  /** The creator is no longer the market authority (the stake pool exists), so only the upgrade authority could add it now. */
  | { action: "authority-rotated" }
  /** As above, and the user chose to continue without the guard. Logged by the caller. */
  | { action: "authority-rotated-accepted" };

/**
 * Decide the guard step of a launch (or of its resume). Pure: the caller reads `guardExists` and `poolExists` from the chain.
 * A guard that is missing while the creator can still sign is ALWAYS sent; a failure to send it is the caller's to surface.
 */
export function planLevGuardLaunch(p: {
  v22On: boolean;
  growth: boolean;
  vaultLpBound: boolean;
  guardExists: boolean;
  poolExists: boolean;
  /** The user acknowledged continuing without a guard (the wizard's explicit button). */
  acceptNoGuard?: boolean;
  programId: PublicKey;
  market: PublicKey;
  creator: PublicKey;
}): LevGuardLaunchAction {
  if (!p.v22On || !p.growth || !p.vaultLpBound) return { action: "not-applicable" };
  if (p.guardExists) return { action: "exists" };
  if (p.poolExists) return { action: p.acceptNoGuard ? "authority-rotated-accepted" : "authority-rotated" };
  return { action: "send", ix: buildLevGuardInitIx(p.programId, p.market, p.creator) };
}

/**
 * Account length the rent is costed at. 4,456 B today; 4,472 B once percolator-prog #605 (burst-memory layout) lands. Costing the larger
 * keeps the SOL pre-check from under-counting either way (a few thousand lamports of headroom). The app never decodes a guard, so no
 * length is checked anywhere else.
 */
export const LEV_GUARD_RENT_ACCOUNT_LEN = 4_472;

/** The launch creates a guard: v2.2 on, with a growth block and the vault-LP bind (the program answers 134 otherwise). */
export const levGuardApplies = (p: { v22On: boolean; growth: boolean; p3: boolean }): boolean => p.v22On && p.growth && p.p3;

/** Shown, and blocking until acknowledged, when a resumed launch has no guard and the creator can no longer create it. */
export const LEV_GUARD_MISSING_BLOCK =
  "This market has no safety guard, and its creator can no longer add one: the market authority has already moved to the stake pool. Only the upgrade authority can create the guard now, so ask the Percolator team to do it. You can continue without it. On devnet the market then trades without the new leverage and new-market limits until the guard exists; on mainnet nobody can open a position on it until the guard exists.";

/** The line shown when the guard could not be created. The launch stops there rather than carrying on without it. */
// Product review M-14: by this step the market, its liquidity and its deposits have landed, so "nothing else was changed" was untrue.
export const LEV_GUARD_INIT_FAILED = "The market was created and the launch steps before this one are in place, but its safety guard could not be set up, so the launch stopped here. Try again to finish it.";
