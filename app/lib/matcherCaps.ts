/**
 * Matcher fill caps — the market's per-trade and total-inventory ceilings.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every market's LP (the AMM counterparty) is protected by two caps chosen at
 * creation by `deriveMarketParams`:
 *
 *   maxInventoryAbs = LP collateral x leverage x 40%   (total LP exposure)
 *   maxFillAbs      = maxInventoryAbs / 4              (ONE trade)
 *
 * so a single trade can move at most `10% x LP x leverage` of notional. They
 * exist because without them the LP is "a free, unlimited, fixed-price
 * counterparty" — that is how the Jimothy market's LP reached $0 capital and
 * -$2,479 pnl (see the launch repo's 66fd991b).
 *
 * The order ticket had no idea they existed. It sizes orders off `collateral x
 * leverage` (a $500 account at 10x offers $5,000 of buying power) while the
 * market might only be able to fill $1,000 — and asking for more does NOT
 * partially fill. The matcher silently clamps the fill to `maxFillAbs` and
 * returns it WITHOUT the FLAG_PARTIAL_OK flag, so the wrapper's
 * `validate_matcher_return` rejects the whole trade with a bare
 * `ProgramError::InvalidAccountData` — surfaced to the user as "one of the
 * accounts has unexpected data", which is both wrong and unactionable.
 *
 * These caps are IMMUTABLE: the matcher program has exactly two instructions
 * (MATCHER_CALL, INIT_VAMM) and `process_init` refuses an already-initialised
 * context with AccountAlreadyInitialized. So once read they are cached for the
 * lifetime of the page — no TTL needed.
 *
 * NOTE the caps are denominated in BASE TOKEN units (the same `sizeQ` units
 * the trade instruction takes), not dollars, so their USD value moves with the
 * oracle price. That is exactly how a market whose feed published a
 * SOL-denominated price saw its $1,000 cap read as $9.57.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

/** v17 portfolio account magic (first 8 bytes, little-endian): PERCV16\0 */
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
/** Provenance header offset of market_group_id. */
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;
/** sizeof(PortfolioMatcherConfigV16), appended at the end of the account. */
const PORTFOLIO_MATCHER_CONFIG_LEN = 104;

/**
 * Start of the vAMM context inside the matcher context account
 * (= MATCHER_RETURN_LEN; the first 64 bytes are the matcher's return slot).
 */
const CTX_VAMM_OFFSET = 64;
/** Field offsets WITHIN the vAMM context (see percolator-match `struct MatcherCtx`). */
const CTX_MAX_FILL_ABS_OFF = 80;
const CTX_INVENTORY_BASE_OFF = 96;
const CTX_MAX_INVENTORY_ABS_OFF = 128;

export interface MatcherCaps {
  /** Largest |size| a SINGLE trade may request, in base-token (sizeQ) units. */
  maxFillAbs: bigint;
  /** Largest |net inventory| the LP will carry, in the same units. */
  maxInventoryAbs: bigint;
}

/** Read a little-endian u128 as a bigint. */
function readU128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/** Read a little-endian i128 (two's complement) as a signed bigint. */
function readI128LE(data: Buffer, offset: number): bigint {
  const u = readU128LE(data, offset);
  return u >= 1n << 127n ? u - (1n << 128n) : u;
}

/**
 * Parse the LP's LIVE net inventory (base-token units, signed: positive =
 * LP long, negative = LP short) out of a raw matcher-context account.
 * Unlike the caps this is mutated by every fill, so it must never share
 * their forever-cache.
 */
export function parseMatcherInventory(data: Buffer): bigint | null {
  const end = CTX_VAMM_OFFSET + CTX_INVENTORY_BASE_OFF + 16;
  if (data.length < end) return null;
  return readI128LE(data, CTX_VAMM_OFFSET + CTX_INVENTORY_BASE_OFF);
}

/**
 * Parse the fill caps out of a raw matcher-context account.
 * Returns null when the account is too short to hold a vAMM context.
 */
export function parseMatcherCaps(data: Buffer): MatcherCaps | null {
  const end = CTX_VAMM_OFFSET + CTX_MAX_INVENTORY_ABS_OFF + 16;
  if (data.length < end) return null;
  return {
    maxFillAbs: readU128LE(data, CTX_VAMM_OFFSET + CTX_MAX_FILL_ABS_OFF),
    maxInventoryAbs: readU128LE(data, CTX_VAMM_OFFSET + CTX_MAX_INVENTORY_ABS_OFF),
  };
}

/** Read the trailing PortfolioMatcherConfigV16.matcher_context, or null when disabled. */
function readMatcherContext(data: Buffer): PublicKey | null {
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN) return null;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN;
  if (data.readBigUInt64LE(off + 96) !== 1n) return null; // enabled != 1
  return new PublicKey(data.subarray(off + 32, off + 64));
}

/** Caps are immutable once initialised, so this cache never expires. */
const capsCache = new Map<string, MatcherCaps | null>();
const inflight = new Map<string, Promise<MatcherCaps | null>>();
/**
 * The matcher-context ADDRESS is as immutable as the caps (the LP's trailing
 * matcher config is written once), so cache it too: it turns every live
 * inventory refresh into ONE getAccountInfo instead of a program scan.
 */
const ctxAddressCache = new Map<string, PublicKey>();

async function resolveCtxAddress(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<PublicKey | null> {
  const key = `${programId.toBase58()}|${slabPk.toBase58()}`;
  const cached = ctxAddressCache.get(key);
  if (cached) return cached;

  // The market's LP portfolio holds the matcher config. Curated markets pin it
  // in PLAYGROUND_SLAB_META (one getAccountInfo); everything else scans.
  let matcherCtx: PublicKey | null = null;

  const knownLp = PLAYGROUND_SLAB_META[slabPk.toBase58()]?.lp_portfolio_address;
  if (knownLp) {
    try {
      const info = await connection.getAccountInfo(new PublicKey(knownLp), "confirmed");
      if (info) matcherCtx = readMatcherContext(Buffer.from(info.data));
    } catch {
      /* fall through to the scan */
    }
  }

  if (!matcherCtx) {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: slabPk.toBase58() } },
      ],
    });
    for (const { account } of accounts) {
      const ctx = readMatcherContext(Buffer.from(account.data));
      if (ctx) {
        matcherCtx = ctx;
        break;
      }
    }
  }

  if (matcherCtx) ctxAddressCache.set(key, matcherCtx);
  return matcherCtx;
}

async function resolveCaps(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<MatcherCaps | null> {
  const matcherCtx = await resolveCtxAddress(connection, programId, slabPk);
  if (!matcherCtx) return null;

  const ctxInfo = await connection.getAccountInfo(matcherCtx, "confirmed");
  if (!ctxInfo) return null;
  const caps = parseMatcherCaps(Buffer.from(ctxInfo.data));
  // maxFillAbs == 0 means "no matcher-side limit" (the matcher skips the clamp
  // entirely), so treat it as no cap rather than a cap of zero.
  if (!caps || caps.maxFillAbs === 0n) return null;
  return caps;
}

/**
 * Fetch the LP's CURRENT net inventory for this market (base-token units,
 * signed). Never cached — every fill moves it, and the whole point of reading
 * it is telling the user how much capacity is left RIGHT NOW. Resolves to
 * null when the market has no matcher context or the read fails.
 */
export async function getMatcherInventory(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<bigint | null> {
  try {
    const matcherCtx = await resolveCtxAddress(connection, programId, slabPk);
    if (!matcherCtx) return null;
    const ctxInfo = await connection.getAccountInfo(matcherCtx, "confirmed");
    if (!ctxInfo) return null;
    return parseMatcherInventory(Buffer.from(ctxInfo.data));
  } catch {
    return null;
  }
}

/**
 * Fetch (and permanently cache) a market's matcher fill caps.
 * Resolves to null when the market has no matcher-enabled LP, the context
 * can't be read, or the matcher is configured with no per-fill limit.
 */
export function getMatcherCaps(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<MatcherCaps | null> {
  const key = `${programId.toBase58()}|${slabPk.toBase58()}`;
  if (capsCache.has(key)) return Promise.resolve(capsCache.get(key)!);
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = resolveCaps(connection, programId, slabPk)
    .then((caps) => {
      // Only cache a successful read: a transient RPC failure must not pin
      // "no cap" for the rest of the session.
      if (caps) capsCache.set(key, caps);
      return caps;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
