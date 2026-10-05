/**
 * The ONE owner-portfolio discovery + selection used by every flow that reads or
 * writes "the wallet's portfolio on this market" (trade, close, deposit, account
 * setup, first trade, the shared display scan).
 *
 * M-4 (code-review-live-paths-2026-10-01): three copies of this lookup returned
 * `null` on ANY exception. A 429 or timeout therefore read as "no account", and
 * the first-trade / deposit / init flows then created a SECOND portfolio. Close
 * picked `results[0]` in RPC order while trade picked the pubkey-sorted first,
 * so with two portfolios a close could land on the other account and open a new
 * position there.
 *
 * Contract:
 * - `findOwnerPortfolio` returns `null` ONLY when the scan completed and found no
 *   portfolio owned by this wallet. An RPC failure is retried and then thrown as
 *   `PortfolioLookupError` (calm copy). Callers must never create on an error.
 * - `pickOwnerPortfolio` is the single deterministic selector: drop the market's
 *   LP portfolio, keep only accounts whose decoded mutable owner IS the wallet
 *   (memcmp filters are advisory), then take the lowest pubkey (base58 order).
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { isLpPortfolio } from "@/lib/lpPortfolio";

/** First 8 bytes of every v17/v18 portfolio account (PERCV16\0, little-endian). */
export const OWNER_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
/** provenance.market_group_id (HEADER_LEN 16 + 0). */
export const OWNER_PORTFOLIO_MARKET_OFF = 16;
/** Mutable owner (SDK PF_OWNER_OFF = HEADER_LEN 16 + provenance 100). Not provenanceOwner@80. */
export const OWNER_PORTFOLIO_OWNER_OFF = 116;

/** Shown when the account lookup could not reach the network. Nothing was signed or sent. */
export const PORTFOLIO_LOOKUP_COPY =
  "We couldn't load your account on this market just now. Nothing was sent. Try again in a moment.";

export class PortfolioLookupError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super(PORTFOLIO_LOOKUP_COPY);
    this.name = "PortfolioLookupError";
    this.cause = cause;
  }
}

export function isPortfolioLookupError(e: unknown): e is PortfolioLookupError {
  return e instanceof PortfolioLookupError || (e instanceof Error && e.message === PORTFOLIO_LOOKUP_COPY);
}

export interface ScannedAccount {
  pubkey: PublicKey;
  account: { data: Buffer | Uint8Array };
}

export interface PickedPortfolio {
  pubkey: PublicKey;
  data: Buffer;
}

const toBuffer = (d: Buffer | Uint8Array): Buffer => (Buffer.isBuffer(d) ? d : Buffer.from(d));

/**
 * ALL of the wallet's own (non-LP) portfolios in `results`, in the deterministic
 * selection order (lowest base58 pubkey first). Empty when none match.
 *
 * This is the full set that `pickOwnerPortfolio` takes the first of — exposed so
 * multi-portfolio flows (isolated margin, #2560) can enumerate every portfolio a
 * wallet owns on a market without re-deriving the drop-LP / owner@116 / sort
 * filter. It applies exactly the selector's filter and ordering, so
 * `listOwnerPortfolios(...)[0]` is, by construction, `pickOwnerPortfolio(...)`.
 */
export function listOwnerPortfolios(results: readonly ScannedAccount[], owner: PublicKey): PickedPortfolio[] {
  const owned: PickedPortfolio[] = [];
  for (const r of results) {
    const data = toBuffer(r.account.data);
    if (isLpPortfolio(data)) continue;
    let ownerMatches = false;
    try {
      ownerMatches = parsePortfolioV17(data).owner.equals(owner);
    } catch {
      ownerMatches = false; // not a decodable portfolio: never select it
    }
    if (ownerMatches) owned.push({ pubkey: r.pubkey, data });
  }
  owned.sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()));
  return owned;
}

/**
 * The deterministic selector (see the module doc). `null` = no owned, non-LP
 * portfolio in `results`.
 *
 * Defined as the head of {@link listOwnerPortfolios} so the single-portfolio
 * selection every existing flow relies on stays bit-identical while
 * multi-portfolio callers adopt the list.
 */
export function pickOwnerPortfolio(results: readonly ScannedAccount[], owner: PublicKey): PickedPortfolio | null {
  return listOwnerPortfolios(results, owner)[0] ?? null;
}

export interface LookupRetry {
  /** Total attempts (default 3). */
  attempts?: number;
  /** Delay before attempt i+1, in ms (default [400, 1200]). */
  delaysMs?: readonly number[];
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The owner-filtered program scan, retried; throws `PortfolioLookupError` when every attempt fails. */
export async function scanOwnerPortfolios(
  connection: Pick<Connection, "getProgramAccounts">,
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey,
  retry: LookupRetry = {},
): Promise<readonly ScannedAccount[]> {
  const attempts = Math.max(1, retry.attempts ?? 3);
  const delays = retry.delaysMs ?? [400, 1200];
  const sleep = retry.sleep ?? defaultSleep;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delays[Math.min(i - 1, delays.length - 1)] ?? 0);
    try {
      const res = await connection.getProgramAccounts(programId, {
        filters: [
          { memcmp: { offset: 0, bytes: OWNER_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: OWNER_PORTFOLIO_MARKET_OFF, bytes: market.toBase58() } },
          { memcmp: { offset: OWNER_PORTFOLIO_OWNER_OFF, bytes: owner.toBase58() } },
        ],
      });
      if (!Array.isArray(res)) throw new Error("getProgramAccounts returned a non-array");
      return res as readonly ScannedAccount[];
    } catch (e) {
      last = e;
    }
  }
  throw new PortfolioLookupError(last);
}

/**
 * The wallet's portfolio on `market`: its pubkey, or `null` when the scan
 * DEFINITIVELY found none. Throws `PortfolioLookupError` on RPC failure.
 */
export async function findOwnerPortfolio(
  connection: Pick<Connection, "getProgramAccounts">,
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey,
  retry?: LookupRetry,
): Promise<PublicKey | null> {
  const results = await scanOwnerPortfolios(connection, programId, market, owner, retry);
  return pickOwnerPortfolio(results, owner)?.pubkey ?? null;
}
