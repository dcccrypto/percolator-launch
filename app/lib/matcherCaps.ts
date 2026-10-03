/**
 * Matcher fill caps — the market's per-trade and total-inventory ceilings.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every market's LP (the AMM counterparty) is protected by two caps chosen at
 * creation by `deriveMarketParams`:
 *
 *   maxInventoryAbs = LP collateral x the creator's position limit (default 1x;
 *                     markets launched before 2026-10-01: LP x leverage x 40%)
 *   maxFillAbs      = maxInventoryAbs / 4              (ONE trade)
 *
 * (values are read back from each market's own context, never recomputed). They
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
 * The caps of a GIVEN context are immutable (the matcher program has exactly
 * two instructions and `process_init` refuses an already-initialised context)
 * — but WHICH context a market uses is not: SetMatcherConfig (tag 68) can
 * re-point or disable the LP's matcher config at any time. Hence the TTL +
 * failure-driven invalidation below rather than a forever-cache.
 *
 * NOTE the caps are denominated in BASE TOKEN units (the same `sizeQ` units
 * the trade instruction takes), not dollars, so their USD value moves with the
 * oracle price. That is exactly how a market whose feed published a
 * SOL-denominated price saw its $1,000 cap read as $9.57.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { resolveMarketLp } from "@/lib/market-lp";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { matcherLpSyncLive } from "@/lib/program-upgrade-detect";

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

/** Read a little-endian u128 as a bigint.
 *  DataView, NOT Buffer.readBigUInt64LE: in the browser this data is a
 *  Uint8Array, and Next's webpack Buffer polyfill lacks the BigInt read
 *  methods (see useTrade.ts readPortfolioMatcherConfig) — a throw here is
 *  swallowed by the callers' catch-to-null, silently disabling the whole
 *  caps/capacity/chunking safety layer while Node-side tests stay green. */
function readU128LE(data: Buffer, offset: number): bigint {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lo = dv.getBigUint64(offset, true);
  const hi = dv.getBigUint64(offset + 8, true);
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

/**
 * Caps and the ctx address are NEARLY immutable — but not actually: the LP
 * owner can re-point or disable the matcher config at any time via
 * SetMatcherConfig (tag 68). A forever-cache would then chunk closes by the
 * WRONG cap (every over-cap close reverts for the rest of the session) and
 * read inventory from an orphaned context (capacity row frozen). So: a TTL
 * bounds silent staleness, and invalidateMatcherCaps() heals immediately on
 * any trade/close failure (mirroring useTrade's account-cache invalidation).
 */
const CAPS_TTL_MS = 300_000;
const capsCache = new Map<string, { caps: MatcherCaps | null; ts: number }>();
const inflight = new Map<string, Promise<MatcherCaps | null>>();
const ctxAddressCache = new Map<string, { pk: PublicKey; lp: PublicKey; ts: number }>();

/** Drop cached caps + ctx address for one market — call on trade/close failure. */
export function invalidateMatcherCaps(programId: PublicKey, slabPk: PublicKey): void {
  const key = `${programId.toBase58()}|${slabPk.toBase58()}`;
  capsCache.delete(key);
  ctxAddressCache.delete(key);
}

async function resolveCtxAddress(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<PublicKey | null> {
  const key = `${programId.toBase58()}|${slabPk.toBase58()}`;
  const cached = ctxAddressCache.get(key);
  if (cached && Date.now() - cached.ts < CAPS_TTL_MS) return cached.pk;

  // The market's LP portfolio holds the matcher config. The LP is chosen by on-chain
  // identity (lib/market-lp.ts), never "the first enabled matcher": any portfolio owner can
  // enable one, and its caps would then size every user's closes.
  const known = PLAYGROUND_SLAB_META[slabPk.toBase58()]?.lp_portfolio_address;
  let knownPk: PublicKey | null = null;
  try {
    knownPk = known ? new PublicKey(known) : null;
  } catch {
    knownPk = null;
  }
  const lp = await resolveMarketLp(connection, programId, slabPk, knownPk);
  const matcherCtx: PublicKey | null = lp ? lp.matcherCtx : null;

  if (lp && matcherCtx) ctxAddressCache.set(key, { pk: matcherCtx, lp: lp.pubkey, ts: Date.now() });
  return matcherCtx;
}

/** The market's LP portfolio address (same resolution + cache as the ctx address). */
async function resolveLpAddress(connection: Connection, programId: PublicKey, slabPk: PublicKey): Promise<PublicKey | null> {
  const ctx = await resolveCtxAddress(connection, programId, slabPk);
  if (!ctx) return null;
  return ctxAddressCache.get(`${programId.toBase58()}|${slabPk.toBase58()}`)?.lp ?? null;
}

export interface LpInventoryState {
  /** The matcher ctx `inventory_base` counter (null = unread). */
  counterQ: bigint | null;
  /** The LP's REAL ADL-effective position on asset 0 (null = unread / InvalidLeg). */
  realQ: bigint | null;
  /** The upgraded wrapper + matcher are live for this LP (lib/program-upgrade-detect.ts). */
  syncLive: boolean;
}

/**
 * Matcher-inventory drift (2026-10-03): the counter AND the LP's real engine position, read
 * fresh in ONE getMultipleAccountsInfo (ctx, LP portfolio, market), plus whether the upgraded
 * programs are live. Never cached (every fill, liquidation and ADL moves them). Combine with
 * `lpInventoryRoomQ` (lib/limits/lp-inventory-room.ts). null = no LP / read failed.
 */
export async function getLpInventoryState(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<LpInventoryState | null> {
  try {
    const ctx = await resolveCtxAddress(connection, programId, slabPk);
    const lp = await resolveLpAddress(connection, programId, slabPk);
    if (!ctx || !lp) return null;
    const [ctxInfo, lpInfo, marketInfo] = await connection.getMultipleAccountsInfo([ctx, lp, slabPk], "confirmed");
    if (!ctxInfo) return null;
    const counterQ = parseMatcherInventory(Buffer.from(ctxInfo.data));
    const engine = marketInfo ? decodeMarketEngineView(new Uint8Array(marketInfo.data), 0) : null;
    const realQ = engine && lpInfo ? lpEffectiveSignedQ(new Uint8Array(lpInfo.data), engine, 0, engine.marketId) : null;
    // The ctx is owned by the LP's matcher program (resolveMarketLp checks ctx.owner == matcherProg).
    const syncLive = await matcherLpSyncLive(connection, programId, ctxInfo.owner).catch(() => false);
    return { counterQ, realQ, syncLive };
  } catch {
    return null;
  }
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
  const cached = capsCache.get(key);
  if (cached && Date.now() - cached.ts < CAPS_TTL_MS) return Promise.resolve(cached.caps);
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = resolveCaps(connection, programId, slabPk)
    .then((caps) => {
      // Only cache a successful read: a transient RPC failure must not pin
      // "no cap" for the rest of the session.
      if (caps) capsCache.set(key, { caps, ts: Date.now() });
      return caps;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/**
 * Is this market's matcher context in the state the wrapper's TradeCpi requires
 * BEFORE it will call the matcher? (`handle_trade_cpi`, v18.2: the matcher ctx
 * must be non-executable, owned by the matcher program, and at least 64 bytes —
 * any violation returns `PercolatorError::InvalidInstruction` = Custom(9), the
 * same code a limit-price (slippage) rejection uses.)
 *
 * "not-ready" is definitive (no enabled LP matcher config, ctx account missing,
 * wrong owner, or too short); "unknown" means the read itself failed, so the
 * caller must not draw a conclusion. Only meant for the post-failure diagnosis
 * path — one or two RPC reads, never on the happy path.
 */
export async function readMatcherContextReadiness(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
  matcherProgramId: PublicKey,
): Promise<"ready" | "not-ready" | "unknown"> {
  try {
    const ctx = await resolveCtxAddress(connection, programId, slabPk);
    if (!ctx) return "not-ready";
    const info = await connection.getAccountInfo(ctx, "confirmed");
    if (!info) return "not-ready";
    if (info.executable || !info.owner.equals(matcherProgramId) || info.data.length < 64) {
      return "not-ready";
    }
    return "ready";
  } catch {
    return "unknown";
  }
}
