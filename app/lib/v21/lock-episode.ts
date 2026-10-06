/**
 * Devnet v2.1, P2b lock exits (percolator-prog #525): the close-only ("ADL") episode countdown and
 * when the permissionless tag 104 wind-down is worth offering. Pure; the episode decoder is the SDK
 * candidate's (`decodeAdlEpisode`, see ./sdk).
 *
 * Close-only = the engine keeps the asset reduce-only while either side's ADL factor is not 1
 * (lib/limits/adl-reduce-only.ts, unchanged and deployed). P2b adds a bounded way out: the first
 * tag 104 call in an episode records its start slot, and once `N` slots (default 9,000, about an
 * hour) have passed anyone may wind a position down at the mark, with no fee. A side that is
 * already dust (engine-checked, at most one whole unit of collateral of notional) is wound down at
 * once. Closing yourself (tag 44) always works and is never gated by any of this.
 */
import { isAdlReduceOnly } from "@/lib/limits/adl-reduce-only";
import { adlEpisodeSlotsRemaining, adlWindDownDustNotionalAtoms, decodeAdlEpisode, type AdlEpisode } from "./sdk";

/** Solana's target slot time. Only used to say "about N minutes". */
export const SLOT_MS = 400;
const POS_SCALE = 1_000_000n;

export interface CloseOnlyInput {
  raw: Uint8Array | null | undefined;
  assetIndex?: number;
  engine: {
    aLong: bigint;
    aShort: bigint;
    marketId: bigint;
    epochLong: bigint;
    epochShort: bigint;
    oiEffLongQ: bigint;
    oiEffShortQ: bigint;
    effectivePriceE6: bigint;
  } | null;
  /** The cluster slot now (the program uses the authenticated clock). */
  nowSlot: bigint | null;
  collateralDecimals: number;
}

export interface CloseOnlyState {
  closeOnly: boolean;
  /** The episode timer is running (some tag 104 has observed this episode). */
  armed: boolean;
  /** Slots until a wind-down may force-close; null = not armed or unknown. */
  remainingSlots: bigint | null;
  /** The wait is over (remaining 0). */
  expired: boolean;
  /** The larger side's notional is within the dust bound: tag 104 closes at once. */
  dust: boolean;
  /** A wind-down would close something now (expired or dust). */
  windDownNow: boolean;
  episode: AdlEpisode | null;
}

const NONE: CloseOnlyState = { closeOnly: false, armed: false, remainingSlots: null, expired: false, dust: false, windDownNow: false, episode: null };

export function deriveCloseOnlyState(i: CloseOnlyInput): CloseOnlyState {
  if (!i.engine || !isAdlReduceOnly(i.engine)) return NONE;
  let episode: AdlEpisode | null = null;
  if (i.raw) {
    try {
      episode = decodeAdlEpisode(i.raw, i.assetIndex ?? 0);
    } catch {
      episode = null;
    }
  }
  const remaining =
    episode && i.nowSlot !== null
      ? adlEpisodeSlotsRemaining(episode, i.engine.marketId, i.engine.epochLong, i.engine.epochShort, i.nowSlot)
      : null;
  const bigSideQ = i.engine.oiEffLongQ > i.engine.oiEffShortQ ? i.engine.oiEffLongQ : i.engine.oiEffShortQ;
  const notionalAtoms = (bigSideQ * i.engine.effectivePriceE6) / POS_SCALE;
  const dust = i.engine.effectivePriceE6 > 0n && notionalAtoms <= adlWindDownDustNotionalAtoms(i.collateralDecimals);
  const expired = remaining === 0n;
  return { closeOnly: true, armed: remaining !== null, remainingSlots: remaining, expired, dust, windDownNow: expired || dust, episode };
}

/** "about 42 min", "about 1 h 05 min", "under a minute". Rounds up so a countdown never says 0 early. */
export function slotsToDuration(slots: bigint): string {
  const totalSecs = Number((slots * BigInt(SLOT_MS) + 999n) / 1000n);
  if (totalSecs < 60) return "under a minute";
  const mins = Math.ceil(totalSecs / 60);
  if (mins < 60) return `about ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${String(m).padStart(2, "0")} min`;
}

/** The one line the banner shows under the headline. */
export function countdownLine(s: CloseOnlyState, copy: { countdown: (t: string) => string; countdownNotStarted: string; countdownReady: string; windDownDust: string }): string {
  if (!s.closeOnly) return "";
  if (s.dust) return copy.windDownDust;
  if (s.expired) return copy.countdownReady;
  if (s.remainingSlots !== null) return copy.countdown(slotsToDuration(s.remainingSlots));
  return copy.countdownNotStarted;
}
