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
 */
import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import { isDevnetV22Enabled } from "./flag";
import { deriveVaultLpExtP2b } from "./sdk/records/p2b-earn";
import {
  ACCOUNT_KIND,
  BOND_TAIL_INDEX_V22,
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
  return tag in BOND_TAIL_INDEX_V22 || tag in INSURANCE_UNITS_TAIL_FROM_V22;
}

export function applyMarketTailsV22(ix: TransactionInstruction, tails: MarketTailsV22): TransactionInstruction {
  const tag = ix.data[0];
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
  return out;
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
      out.push(ix);
    }
  }
  return out;
}
