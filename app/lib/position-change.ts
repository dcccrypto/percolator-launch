/**
 * The taker's position measured on chain before and after a trade (#3314), as the signed
 * ADL-EFFECTIVE quantity: the size the engine applies a trade to (`plan_delta`,
 * lib/limits/effective-quantity.ts), so a sell on an ADL-reduced long reads as the flip it is.
 *
 * Independent of the P1 limits flag: lib/limits/fill-check.ts measures raw basis, and only when
 * the flag is on (off by default), to decide what the ticket SAYS about a fill. This decides
 * what entry is SAVED for the position (lib/entry-price.ts `entryAfterTrade`).
 *
 * Reads are pinned with `minContextSlot` (the /api/rpc proxy caches account data ~1 s, keyed by
 * params): the "after" read to the trade's own slot, the "before" read to the slot of this
 * portfolio's previous measured trade, so a second trade right after a first can't read bytes
 * from before the first. Every failure is `null` and never fails a trade.
 */
import { parsePortfolio } from "@/lib/v22/layout";
import { fundingSampleOf, retryFundingRead, type FundingSample } from "@/lib/funding-flow";
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { effectiveLeg } from "@/lib/limits/effective-quantity";

export interface PositionChange {
  beforeQ: bigint;
  afterQ: bigint;
  /** r10: the portfolio's funding counters in the SAME post-trade read (no extra RPC call); null when not readable. */
  funding?: FundingSample | null;
}

/** portfolio -> slot of its last measured trade. Bounded. */
const lastSlot = new Map<string, number>();
function noteSlot(portfolio: string, slot: number): void {
  const prev = lastSlot.get(portfolio);
  if (prev !== undefined && prev >= slot) return;
  lastSlot.delete(portfolio);
  lastSlot.set(portfolio, slot);
  while (lastSlot.size > 64) {
    const first = lastSlot.keys().next().value;
    if (first === undefined) break;
    lastSlot.delete(first);
  }
}

/**
 * Signed effective position of `portfolio` on `market` (asset 0, the only asset a playground
 * market has; the same leg useClosePosition sizes from). 0n when there is no portfolio or no
 * active leg, or the leg is a prior-reset obligation (owns nothing). null when either account
 * can't be read or decoded, or the engine would refuse the leg.
 */
export async function readEffectivePositionQ(
  connection: Connection,
  portfolio: PublicKey,
  market: PublicKey,
  minContextSlot?: number,
): Promise<bigint | null> {
  const r = await readEffectivePosition(connection, portfolio, market, minContextSlot);
  return r === null ? null : r.q;
}

/** `readEffectivePositionQ` plus the funding counters of the same portfolio bytes (one RPC call). */
export async function readEffectivePosition(
  connection: Connection,
  portfolio: PublicKey,
  market: PublicKey,
  minContextSlot?: number,
): Promise<{ q: bigint; funding: FundingSample | null } | null> {
  try {
    const [pf, mk] = await connection.getMultipleAccountsInfo([portfolio, market], {
      commitment: "confirmed",
      ...(minContextSlot !== undefined ? { minContextSlot } : {}),
    });
    if (!mk) return null;
    if (!pf) return { q: 0n, funding: null };
    const engine = decodeMarketEngineView(new Uint8Array(mk.data));
    if (!engine) return null;
    const parsed = parsePortfolio(new Uint8Array(pf.data)); // VERSION-aware (v2.2 QA NB-1)
    // A funding read that fails must never cost the size measurement: it only leaves the trade result unknown.
    let funding: FundingSample | null = null;
    try {
      funding = fundingSampleOf(parsed);
    } catch {
      funding = null;
    }
    const leg = parsed.legs.find((l) => l.active);
    if (!leg) return { q: 0n, funding };
    const eff = effectiveLeg(engine, leg);
    return eff.kind === "invalid" ? null : { q: eff.signedQ, funding };
  } catch {
    return null;
  }
}

/** Waits between tries of the post-trade read. Shorter than the funding read: the trade result is waited for. */
const POST_TRADE_READ_RETRY_MS: readonly number[] = [300, 900];

/** The pre-trade read, pinned past this portfolio's previous measured trade. */
export function readBeforeTrade(connection: Connection, portfolio: PublicKey, market: PublicKey): Promise<bigint | null> {
  return readEffectivePositionQ(connection, portfolio, market, lastSlot.get(portfolio.toBase58()));
}

/** The post-trade read at the confirmed trade's own slot; null when the slot isn't known. */
export async function measurePositionChange(
  connection: Connection,
  portfolio: PublicKey,
  market: PublicKey,
  sig: string,
  beforeQ: bigint | null,
): Promise<PositionChange | null> {
  if (beforeQ === null) return null;
  try {
    const st = await connection.getSignatureStatuses([sig]);
    const slot = st.value[0]?.slot;
    if (slot === undefined || slot === null) return null;
    noteSlot(portfolio.toBase58(), slot);
    // A busy RPC (429) makes this read fail for a moment: retry with backoff before the trade result goes unknown (it carries the funding).
    const after = await retryFundingRead(() => readEffectivePosition(connection, portfolio, market, slot), POST_TRADE_READ_RETRY_MS);
    return after === null ? null : { beforeQ, afterQ: after.q, funding: after.funding };
  } catch {
    return null;
  }
}

/**
 * sig -> the pending measurement, so a caller of `useTrade().trade()` (which returns only the
 * signature) can wait for it without slowing every trade. Bounded like fill-check's map.
 */
const pending = new Map<string, Promise<PositionChange | null>>();
export function recordPositionChange(sig: string, p: Promise<PositionChange | null>): void {
  pending.set(sig, p);
  while (pending.size > 32) {
    const first = pending.keys().next().value;
    if (first === undefined) break;
    pending.delete(first);
  }
}

/** The measurement for `sig` (consumed), or null when there is none. Never rejects. */
export async function takePositionChange(sig: string | null | undefined, timeoutMs = 8_000): Promise<PositionChange | null> {
  if (!sig) return null;
  const p = pending.get(sig);
  pending.delete(sig);
  if (!p) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
