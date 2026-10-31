/**
 * v2.2 market tails: once a market has a bond tranche (`["bond_tranche", market]`, kind 11) the wrapper REQUIRES the
 * tranche appended to tags 78 / 97 / 102 (Resolved) / 103, and once it has an `InsuranceUnitsV20` account (`["ins_units", market]`,
 * kind 13) the insurance paths 9 / 56 / 57 / 41 / 101 need it appended last (both fail closed without). The app's
 * builders know nothing about either, so this module adds them at the send choke point (lib/tx.ts `sendTx`), flag-gated.
 *
 * - {@link fetchMarketTailsV22}: ONE getMultipleAccountsInfo for both PDAs; an account counts only if it is owned by the
 *   wrapper and its header (resolveLayout) is the right kind. Cached per (program, market) for a short TTL.
 * - {@link applyMarketTailsV22}: returns the instruction unchanged unless its tag takes a tail AND that tail exists.
 *   The market is `keys[1]` for every one of these tags (ACCOUNTS_LP_VAULT_CRANK_FEES / WITHDRAW_JUNIOR_TRANCHE_P3 /
 *   TOPUP_INSURANCE / WITHDRAW_INSURANCE ...); a wrong guess is harmless because the PDA of a non-market is absent.
 * - #636 / #636b (percolator-prog #640 + #641): the flow tags 96 / 97 / 98 / 102 (Live) / 103 / 108 / 110 / 111 (modes 0/1/3) sample the
 *   LP-stop NAV at the flow and REQUIRE the lev guard `["lev_guard", market]` and the vault ext `["vault_lp_ext", market]` as trailing
 *   accounts on a growth market (Custom 134 without). Appending them is correct on every market (the program skips the sample on a
 *   non-growth market or before the guard is initialised), so this choke point appends them to every flow-tag instruction AFTER the bond
 *   tranche (`withNavFlowTailV22`: no RPC, idempotent). A v2.2 builder that already emitted the full list is left as is, except that a
 *   padded bond slot (97 `[12]`, 103 `[9]`) becomes the tranche once the market has one. A list the helper cannot place is refused loudly
 *   (MarketTailMismatchError) before the wallet prompt.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import { isDevnetV22Enabled } from "./flag";
import { deriveVaultLpExtP2b } from "./sdk/records/p2b-earn";
import {
  ACCOUNT_KIND,
  BOND_TAIL_INDEX_V22,
  NAV_FLOW_TAILS_V22,
  hasNavFlowTailV22,
  withNavFlowTailV22,
  INSURANCE_UNITS_TAIL_FROM_V22,
  deriveBondTrancheV22,
  deriveInsuranceUnitsV22,
  resolveLayout,
  withBondTailV22,
  withInsuranceUnitsTailV22,
} from "./sdk";

/** The one calm line the user sees when a builder and the wrapper's tail layout disagree. Nothing was sent. */
export const MARKET_TAIL_CALM_LINE = "This action isn't available for this market yet. Nothing was sent.";

/**
 * An app builder whose account count does not match the SDK's tail index would send an instruction the program refuses
 * (or, worse, mis-reads). In EVERY environment that is now an error raised BEFORE the wallet prompt: `message` is the calm
 * line for the user, the numbers live in `tag` / `got` / `want` and are logged.
 */
export class MarketTailMismatchError extends Error {
  readonly name = "MarketTailMismatchError";
  constructor(readonly tag: number, readonly got: number, readonly want: string) {
    super(MARKET_TAIL_CALM_LINE);
  }
  get detail(): string {
    return `market tail: tag ${this.tag} has ${this.got} accounts, the SDK tail index needs ${this.want}`;
  }
}
const loud = (): boolean => true;
/** Tags whose bond-tail form is unambiguous. 102 also has a live (7-account) form, so only its two known lengths pass. */
const BOND_LOUD_TAGS = new Set([78, 97, 102, 103]);
/** 101 is ExecuteAdl in the installed SDK (it only sometimes takes units), so it is never loud. */
const UNITS_LOUD_TAGS = new Set([9, 56, 57, 41]);
/** #636 / #636b flow tags (prog #640 + #641): they take the lev guard + vault ext tail. */
export const NAV_FLOW_TAGS_V22: ReadonlySet<number> = new Set([96, 97, 98, 102, 103, 108, 110, 111]);

export interface MarketTailsV22 {
  bondTranche: PublicKey | null;
  insuranceUnits: PublicKey | null;
  /** The P2b `vault_lp_ext` PDA when it exists (kind 10); tags 78 / 97 / 98 / 103 take it. */
  vaultLpExt?: PublicKey | null;
}

export const NO_TAILS: MarketTailsV22 = Object.freeze({ bondTranche: null, insuranceUnits: null, vaultLpExt: null });
export const TAILS_TTL_MS = 15_000;

let now: () => number = () => Date.now();
const cache = new Map<string, { at: number; tails: MarketTailsV22 }>();
/** Test seam. */
export function __setTailsClockForTest(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
  cache.clear();
}

function validAs(info: { owner: PublicKey; data: Uint8Array } | null, programId: PublicKey, kind: number): boolean {
  if (!info || !info.owner.equals(programId)) return false;
  try {
    resolveLayout(info.data, { parser: "marketTails", kind });
    return true;
  } catch {
    return false;
  }
}

export async function fetchMarketTailsV22(connection: Pick<Connection, "getMultipleAccountsInfo">, programId: PublicKey, market: PublicKey): Promise<MarketTailsV22> {
  const key = `${programId.toBase58()}:${market.toBase58()}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < TAILS_TTL_MS) return hit.tails;
  const tranche = deriveBondTrancheV22(programId, market)[0];
  const units = deriveInsuranceUnitsV22(programId, market)[0];
  const ext = deriveVaultLpExtP2b(programId, market)[0];
  const [t, u, x] = await connection.getMultipleAccountsInfo([tranche, units, ext], "confirmed");
  const tails: MarketTailsV22 = {
    bondTranche: validAs(t, programId, ACCOUNT_KIND.BondTranche) ? tranche : null,
    insuranceUnits: validAs(u, programId, ACCOUNT_KIND.InsuranceUnits) ? units : null,
    vaultLpExt: validAs(x ?? null, programId, ACCOUNT_KIND.VaultLpExt) ? ext : null,
  };
  cache.set(key, { at: now(), tails });
  return tails;
}

/** Does this instruction (of the wrapper) take either tail? Cheap pre-check so unrelated sends cost no RPC. */
export function takesMarketTail(ix: TransactionInstruction, wrapper: PublicKey): boolean {
  if (!ix.programId.equals(wrapper) || ix.data.length === 0 || ix.keys.length < 2) return false;
  const tag = ix.data[0];
  return tag in BOND_TAIL_INDEX_V22 || tag in INSURANCE_UNITS_TAIL_FROM_V22 || NAV_FLOW_TAGS_V22.has(tag);
}

/** #636: bring a flow-tag instruction to its #640 / #641 list; a list the helper cannot place is a loud mismatch. */
function applyNavFlowTail(ix: TransactionInstruction): TransactionInstruction {
  const tag = ix.data[0];
  if (!NAV_FLOW_TAGS_V22.has(tag)) return ix;
  try {
    const out = withNavFlowTailV22(ix, ix.keys[1].pubkey);
    // Already the full form (or a form the program does not sample, 102 Resolved / 111 PROPOSE): keep the caller's object.
    const same = out.keys.length === ix.keys.length && out.keys.every((k, i) => k.pubkey.equals(ix.keys[i].pubkey) && k.isWritable === ix.keys[i].isWritable && k.isSigner === ix.keys[i].isSigner);
    return same ? ix : out;
  } catch (e) {
    console.error(`[v22 tails] ${e instanceof Error ? e.message : String(e)}`);
    throw new MarketTailMismatchError(tag, ix.keys.length, "the #636 NAV flow tail form");
  }
}

/** A full-form 97 / 103 built without the tranche (pad at the bond slot) on a market that has one: put the tranche there. */
function fillBondSlot(ix: TransactionInstruction, tranche: PublicKey | null): TransactionInstruction {
  const tag = ix.data[0];
  if (!tranche || (tag !== 97 && tag !== 103)) return ix;
  const slot = NAV_FLOW_TAILS_V22[tag].bondSlot;
  const k = ix.keys[slot];
  if (!k || k.pubkey.equals(tranche) || !k.pubkey.equals(SystemProgram.programId)) return ix;
  const keys = ix.keys.map((m, i) => (i === slot ? { pubkey: tranche, isSigner: false, isWritable: false } : m));
  return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}

export function applyMarketTailsV22(ix: TransactionInstruction, tails: MarketTailsV22): TransactionInstruction {
  const tag = ix.data[0];
  // A v2.2 builder already emitted the #636 full list (bond slot decided by the builder): only fix a padded bond slot.
  if (NAV_FLOW_TAGS_V22.has(tag) && ix.keys.length >= 2 && hasNavFlowTailV22(ix, ix.keys[1].pubkey)) return fillBondSlot(ix, tails.bondTranche);
  let out = ix;
  const bondAt = (BOND_TAIL_INDEX_V22 as Record<number, number>)[tag];
  if (loud() && tails.bondTranche && bondAt !== undefined && BOND_LOUD_TAGS.has(tag)) {
    const has = out.keys.some((k) => k.pubkey.equals(tails.bondTranche!));
    const okLen = out.keys.length === bondAt || (has && out.keys.length === bondAt + 1) || (tag === 102 && out.keys.length === 7);
    if (!okLen) throw new MarketTailMismatchError(tag, out.keys.length, `${bondAt}${tag === 102 ? " (or 7 for a live market)" : ""}`);
  }
  if (tails.bondTranche && bondAt !== undefined && out.keys.length === bondAt && !out.keys.some((k) => k.pubkey.equals(tails.bondTranche!))) {
    // Tag 78 re-certifies the vault LP before valuing the bonds (N-1): the vault LP at [8] must be WRITABLE. The app's
    // 78 builder may leave it read-only, so rebuild that meta writable before appending the tranche.
    if (tag === 78 && out.keys[8] && !out.keys[8].isWritable) {
      const keys = out.keys.map((k, i) => (i === 8 ? { ...k, isWritable: true } : k));
      out = new TransactionInstruction({ programId: out.programId, keys, data: out.data });
    }
    out = withBondTailV22(out, tails.bondTranche);
  }
  const unitsFrom = (INSURANCE_UNITS_TAIL_FROM_V22 as Record<number, number>)[tag];
  if (loud() && tails.insuranceUnits && unitsFrom !== undefined && UNITS_LOUD_TAGS.has(tag) && out.keys.length < unitsFrom) {
    throw new MarketTailMismatchError(tag, out.keys.length, `at least ${unitsFrom}`);
  }
  if (tails.insuranceUnits && unitsFrom !== undefined && out.keys.length >= unitsFrom && !out.keys.some((k) => k.pubkey.equals(tails.insuranceUnits!))) {
    out = withInsuranceUnitsTailV22(out, tails.insuranceUnits);
  }
  return applyNavFlowTail(out);
}

/**
 * The choke-point entry: flag off returns the SAME array with no RPC. Flag on, one cached fetch per distinct market among
 * the instructions that take a tail. A failed read leaves the instructions unchanged (the program then refuses visibly).
 */
export async function withMarketTailsV22(connection: Pick<Connection, "getMultipleAccountsInfo">, wrapper: PublicKey, instructions: TransactionInstruction[]): Promise<TransactionInstruction[]> {
  if (!isDevnetV22Enabled()) return instructions;
  if (!instructions.some((ix) => takesMarketTail(ix, wrapper))) return instructions;
  const out: TransactionInstruction[] = [];
  for (const ix of instructions) {
    if (!takesMarketTail(ix, wrapper)) {
      out.push(ix);
      continue;
    }
    try {
      out.push(applyMarketTailsV22(ix, await fetchMarketTailsV22(connection, wrapper, ix.keys[1].pubkey)));
    } catch (e) {
      if (e instanceof MarketTailMismatchError) {
        // Loud in EVERY environment, before the wallet prompt: log with the numbers, show the calm line.
        console.error(`[v22 tails] ${e.detail}`);
        try {
          Sentry.captureException(e, { tags: { area: "v22-market-tails", tag: String(e.tag) }, extra: { got: e.got, want: e.want } });
        } catch {
          /* telemetry must never mask the refusal */
        }
        throw e;
      }
      // The tails read failed: the bond / units tails stay unknown (the program then refuses visibly), but the #636 flow tail
      // needs no RPC, so it is still applied (its own mismatch is loud).
      out.push(applyNavFlowTail(ix));
    }
  }
  return out;
}
