/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk-growth @ 15cf3be (#429 360 B record, burst memory),
 * src/abi/lev-guard-v22.ts: the kind-17 guard account DECODER, report freshness and the W1 round test (the ticket now reads the guard:
 * app bug 2026-10-29, product review finding 4). Only the imports are retargeted (the vendored ./layout has no LevGuard kind, so the kind
 * byte is a local constant). Delete when @percolatorct/sdk >= 9.0.0 ships these and point ./index.ts at the package. Re-synced with percolator-sdk PR #432 (prog#611: 16-byte tags, cap 256). Do not edit here;
 * fix upstream in percolator-sdk.
 */
import { PublicKey } from "@solana/web3.js";
import { LAYOUT_V22, UnknownLayoutError, resolveLayout } from "./layout";
import type { LayoutTable } from "./layout";
import {
  LEV_GUARD_FLAG_V22, LEV_GUARD_KEY_TAG_LEN_V22, LEV_GUARD_TOUCHED_CAP_V22, LEV_GUARD_TOUCHED_LEN_V22, LEV_GUARD_VERSION_V22,
  LEV_REPORT_FRESH_SLOTS_V22, LEV_REPORT_HELD_SLOTS_V22, LEV_W1_ROUND_SLOTS_V22,
} from "./lev-guard-v22";

/** `ACCOUNT_KIND::LevGuard` (header byte 10). */
export const LEV_GUARD_ACCOUNT_KIND_V22 = 17;
/** The record length since prog #605 (burst memory; the SDK's `LEV_GUARD_REC_LEN_V22`), and before it (./lev-guard-v22's 344). */
export const LEV_GUARD_REC_LEN_BURST_V22 = 360;
export const LEV_GUARD_REC_LEN_PRE_BURST_V22 = 344;
export const LEV_GUARD_ACCOUNT_LEN_BURST_V22 = 16 + LEV_GUARD_REC_LEN_BURST_V22 + LEV_GUARD_TOUCHED_LEN_V22;

/** Field offsets INSIDE the 360-byte record (rustc `offset_of!`; add 16 for the account). */
export const LEV_GUARD_FIELD_OFF_V22 = Object.freeze({
  market: 0, riskKey: 32, t0Slot: 64, assetIndex: 72, version: 74, bump: 75, flags: 76, roundActive: 77, roundLpLong: 78, pad0: 79,
  repJDumpBps: 80, repMIndBps: 82, repLCapX100: 84, repNMultBps: 86, repSlot: 88,
  holderDumpBps: 96, roundKeepBps: 98, touchedN: 100, pad1: 102, holderDumpSlot: 104,
  pbLastPx: 112, pbLastSlot: 120, pbRefPx: 128, pbRefSlot: 136, pbFreezeUntil: 144, pbOracleUntil: 152,
  frozenLX100: 160, pad2: 162, frozenNQ: 168,
  navps: 184, navLastEquity: 200, navLastIn: 216, navLastOut: 232, navPeakCur: 248, navPeakPrev: 264, navRef: 280,
  navBucketStart: 296, navLastSlot: 304, roundId: 312, roundTargetQ: 320, roundOpenSlot: 336,
  burstVarPeakX100: 344, pad3: 348, burstPeakSlot: 352,
} as const);

/** Decoded `LevGuardV22`. u64 fields are `bigint`, u128 fields `bigint`, u8 / u16 fields `number`. */
export interface LevGuardV22 {
  market: PublicKey;
  /** The holder risk key; all-zero = none. */
  riskKey: PublicKey;
  /** T0: the earliest slot the program vouches for as the token's start. */
  t0Slot: bigint;
  assetIndex: number;
  version: number;
  bump: number;
  flags: number;
  /** Bit 0 of `flags`: the pinned base mint was last seen with a live mint authority. */
  mintAuthLive: boolean;
  /** Bit 1 of `flags`: ... a live freeze authority. */
  freezeAuthLive: boolean;
  /** W1: a stop round is open. */
  roundActive: boolean;
  /** W1: the LP side when the round opened. */
  roundLpLong: boolean;
  repJDumpBps: number;
  repMIndBps: number;
  repLCapX100: number;
  repNMultBps: number;
  /** Authenticated slot of the last report; 0 = never reported. */
  repSlot: bigint;
  holderDumpBps: number;
  roundKeepBps: number;
  touchedN: number;
  holderDumpSlot: bigint;
  pbLastPx: bigint;
  pbLastSlot: bigint;
  pbRefPx: bigint;
  pbRefSlot: bigint;
  pbFreezeUntil: bigint;
  pbOracleUntil: bigint;
  frozenLX100: number;
  frozenNQ: bigint;
  /** NAV per share, scale {@link LEV_NAV_ONE_V22} (1e12). */
  navps: bigint;
  navLastEquity: bigint;
  navLastIn: bigint;
  navLastOut: bigint;
  navPeakCur: bigint;
  navPeakPrev: bigint;
  navRef: bigint;
  navBucketStart: bigint;
  navLastSlot: bigint;
  roundId: bigint;
  roundTargetQ: bigint;
  /** Slot the current W1 round opened (record offset 336). */
  roundOpenSlot: bigint;
  /** Burst memory (decision 28, prog#605): the running peak of the market's vol variance (x100) (record offset 344). */
  burstVarPeakX100: number;
  /** Slot the burst peak was set (record offset 352); the peak is read decayed with a 7-day half-life. */
  burstPeakSlot: bigint;
  /** The first `touchedN` tags of the touched set: the first `LEV_GUARD_KEY_TAG_LEN_V22` (16) bytes of each cut portfolio key, as a LE unsigned integer (prog#611). Compare with `levKeyTagV22`. */
  touchedTags: bigint[];
}

function u128At(v: DataView, off: number): bigint {
  return (v.getBigUint64(off + 8, true) << 64n) | v.getBigUint64(off, true);
}
function allZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/**
 * Decode a leverage guard account (`16 + 360 + 4096 = 4472` bytes, header kind 17). Mirrors the program's `validate_guard`
 * (version 1, only known flag bits, booleans 0/1, `touched_n <= 256`, `round_keep_bps <= 10 000`, report bps in range, padding zero).
 *
 * @param data   Raw account bytes.
 * @param table  Layout table (default {@link LAYOUT_V22}); only its header version is used.
 * @returns The decoded guard.
 * @throws {@link UnknownLayoutError} on a wrong header / kind, a short account, or a record that fails validation.
 * @example
 * ```ts
 * const g = decodeLevGuardV22(info.data);
 * const band = levAgeBandV22(g.t0Slot, BigInt(slot));
 * ```
 */
export function decodeLevGuardV22(data: Uint8Array, table: LayoutTable = LAYOUT_V22): LevGuardV22 {
  const parser = "decodeLevGuardV22";
  const L = resolveLayout(data, { parser, kind: LEV_GUARD_ACCOUNT_KIND_V22, versions: [table.version] });
  const b = L.headerLen;
  if (b !== 16) throw new UnknownLayoutError("INVALID_RECORD", parser, `invalid account data: header length ${b} != 16`, { kind: LEV_GUARD_ACCOUNT_KIND_V22 });
  // Exact lengths only (security review M-1): 4456 (record 344, prog#604) or 4472 (record 360, prog#605 burst
  // memory). Anything else is refused rather than decoded at shifted offsets.
  const recLen = data.length - b - LEV_GUARD_TOUCHED_LEN_V22;
  if (recLen !== LEV_GUARD_REC_LEN_BURST_V22 && recLen !== LEV_GUARD_REC_LEN_PRE_BURST_V22) {
    throw new UnknownLayoutError(
      data.length < b + LEV_GUARD_REC_LEN_PRE_BURST_V22 + LEV_GUARD_TOUCHED_LEN_V22 ? "TOO_SHORT" : "INVALID_RECORD",
      parser,
      `lev guard account length ${data.length}: expected ${b + LEV_GUARD_REC_LEN_PRE_BURST_V22 + LEV_GUARD_TOUCHED_LEN_V22} or ${LEV_GUARD_ACCOUNT_LEN_BURST_V22}`,
      { version: L.version, kind: LEV_GUARD_ACCOUNT_KIND_V22 },
    );
  }
  const burst = recLen === LEV_GUARD_REC_LEN_BURST_V22;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const F = LEV_GUARD_FIELD_OFF_V22;
  const u16 = (o: number): number => v.getUint16(b + o, true);
  const u64 = (o: number): bigint => v.getBigUint64(b + o, true);
  const u128 = (o: number): bigint => u128At(v, b + o);
  const flags = data[b + F.flags];
  const g: LevGuardV22 = {
    market: new PublicKey(data.slice(b + F.market, b + F.market + 32)),
    riskKey: new PublicKey(data.slice(b + F.riskKey, b + F.riskKey + 32)),
    t0Slot: u64(F.t0Slot),
    assetIndex: u16(F.assetIndex),
    version: data[b + F.version],
    bump: data[b + F.bump],
    flags,
    mintAuthLive: (flags & LEV_GUARD_FLAG_V22.MINT_AUTH_LIVE) !== 0,
    freezeAuthLive: (flags & LEV_GUARD_FLAG_V22.FREEZE_AUTH_LIVE) !== 0,
    roundActive: data[b + F.roundActive] === 1,
    roundLpLong: data[b + F.roundLpLong] === 1,
    repJDumpBps: u16(F.repJDumpBps),
    repMIndBps: u16(F.repMIndBps),
    repLCapX100: u16(F.repLCapX100),
    repNMultBps: u16(F.repNMultBps),
    repSlot: u64(F.repSlot),
    holderDumpBps: u16(F.holderDumpBps),
    roundKeepBps: u16(F.roundKeepBps),
    touchedN: u16(F.touchedN),
    holderDumpSlot: u64(F.holderDumpSlot),
    pbLastPx: u64(F.pbLastPx),
    pbLastSlot: u64(F.pbLastSlot),
    pbRefPx: u64(F.pbRefPx),
    pbRefSlot: u64(F.pbRefSlot),
    pbFreezeUntil: u64(F.pbFreezeUntil),
    pbOracleUntil: u64(F.pbOracleUntil),
    frozenLX100: u16(F.frozenLX100),
    frozenNQ: u128(F.frozenNQ),
    navps: u128(F.navps),
    navLastEquity: u128(F.navLastEquity),
    navLastIn: u128(F.navLastIn),
    navLastOut: u128(F.navLastOut),
    navPeakCur: u128(F.navPeakCur),
    navPeakPrev: u128(F.navPeakPrev),
    navRef: u128(F.navRef),
    navBucketStart: u64(F.navBucketStart),
    navLastSlot: u64(F.navLastSlot),
    roundId: u64(F.roundId),
    roundTargetQ: u128(F.roundTargetQ),
    roundOpenSlot: u64(F.roundOpenSlot),
    burstVarPeakX100: burst ? v.getUint32(b + F.burstVarPeakX100, true) : 0,
    burstPeakSlot: burst ? u64(F.burstPeakSlot) : 0n,
    touchedTags: [],
  };
  const rawBool = (o: number): boolean => data[b + o] <= 1;
  const bad =
    g.version !== LEV_GUARD_VERSION_V22 ||
    (flags & ~(LEV_GUARD_FLAG_V22.MINT_AUTH_LIVE | LEV_GUARD_FLAG_V22.FREEZE_AUTH_LIVE)) !== 0 ||
    !rawBool(F.roundActive) || !rawBool(F.roundLpLong) ||
    g.touchedN > LEV_GUARD_TOUCHED_CAP_V22 || g.roundKeepBps > 10_000 ||
    g.repJDumpBps > 10_000 || g.repMIndBps > 10_000 || g.repNMultBps > 10_000 ||
    data[b + F.pad0] !== 0 || !allZero(data.subarray(b + F.pad1, b + F.pad1 + 2)) || !allZero(data.subarray(b + F.pad2, b + F.pad2 + 6)) ||
    (burst && !allZero(data.subarray(b + F.pad3, b + F.pad3 + 4)));
  if (bad) throw new UnknownLayoutError("INVALID_RECORD", parser, "invalid account data: lev guard fails the program's validate_guard", { kind: LEV_GUARD_ACCOUNT_KIND_V22 });
  const t = b + recLen;
  for (let i = 0; i < g.touchedN; i++) g.touchedTags.push(u128At(v, t + LEV_GUARD_KEY_TAG_LEN_V22 * i));
  return g;
}


/**
 * The tag the program stores for a cut portfolio: the first `LEV_GUARD_KEY_TAG_LEN_V22` bytes of its key as a LE unsigned integer
 * (`key_tag`). Always derive it here so the width stays in one place (the SDK's `levKeyTagV22`).
 */
export function levKeyTagV22(key: PublicKey): bigint {
  const b = key.toBytes(); // a fresh copy; never read `.buffer` of a pooled Buffer
  return u128At(new DataView(b.buffer, b.byteOffset, b.byteLength), 0);
}

/** Freshness of the holder risk report (`ReportAge`). */
export type LevReportAgeV22 = "None" | "Fresh" | "Held" | "Stale";

/**
 * Report freshness (`lev_guard_v22::report_age`): `None` when never reported (slot 0), `Fresh` within 27 000 slots (3 h), `Held`
 * within 216 000 (24 h), else `Stale`; a report stamped in the future is `Stale`.
 *
 * @param repSlot  Guard `repSlot`.
 * @param nowSlot  Current slot.
 * @returns The freshness class.
 * @example
 * ```ts
 * levReportAgeV22(g.repSlot, BigInt(slot));
 * ```
 */
export function levReportAgeV22(repSlot: bigint, nowSlot: bigint): LevReportAgeV22 {
  if (repSlot === 0n) return "None";
  if (nowSlot < repSlot) return "Stale";
  const a = nowSlot - repSlot;
  if (a <= LEV_REPORT_FRESH_SLOTS_V22) return "Fresh";
  if (a <= LEV_REPORT_HELD_SLOTS_V22) return "Held";
  return "Stale";
}


/**
 * Whether a W1 round is live (`w1_round_live`): `round_active == 1` and `now - round_open_slot <= 9 000`. While live, a fill that
 * grows the LP's net is refused with error 133 (log `lev_guard_refused lp_stop_round`).
 *
 * @param g        The guard (or its `roundActive` / `roundOpenSlot`).
 * @param nowSlot  Current slot.
 * @returns True while the round blocks LP-growing fills.
 * @example
 * ```ts
 * levW1RoundLiveV22(guard, BigInt(slot));
 * ```
 */
export function levW1RoundLiveV22(g: Pick<LevGuardV22, "roundActive" | "roundOpenSlot">, nowSlot: bigint): boolean {
  if (!g.roundActive) return false;
  const d = nowSlot > g.roundOpenSlot ? nowSlot - g.roundOpenSlot : 0n;
  return d <= LEV_W1_ROUND_SLOTS_V22;
}
