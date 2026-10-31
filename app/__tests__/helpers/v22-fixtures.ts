import { readFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { LAYOUT_V21, LAYOUT_V22 } from "@/lib/v22/sdk/layout";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { activeLayout } from "@/lib/v22/layout";
import { liftV22Portfolio } from "./portfolio-disc20";

const LAYOUT_V21_MAGIC = 0x5045_5243_5631_3600n;

/**
 * v2.2 (wrapper VERSION 19) account fixtures for tests that used to run on v2.1 (VERSION 18) bytes.
 *
 * Bytes are CAPTURED from the deployed v2.2 devnet program, never hand-built from the app's own decoders:
 *  - market: the one-slot SOL market (4,059 B), fixtures/v22-market-single-asset-SOL.json
 *  - portfolio: a flat 10,603 B trader portfolio, fixtures/v22-flat-winner-portfolio-2026-10-11.json (recorded before engine #299;
 *    v22PortfolioBase lifts it to disc 20 / 10,607 B, helpers/portfolio-disc20.ts)
 * Patches are written at offsets from the SDK table LAYOUT_V22 (pinned to rustc `offset_of!` by lib/v22/rust-layout-parity-d1.test.ts).
 */
const FX = join(__dirname, "..", "fixtures");
const RUST = JSON.parse(readFileSync(join(FX, "v22-rust-layout-aca02ba6.json"), "utf8")) as {
  offsets: { EngineAssetSlotV16Account: Record<string, number>; BackingBucketV16Account: Record<string, number> };
};
const MARKET_FX = JSON.parse(readFileSync(join(FX, "v22-market-single-asset-SOL.json"), "utf8")) as { market: string; owner: string; dataBase64: string };
const PORTFOLIO_FX = JSON.parse(readFileSync(join(FX, "v22-flat-winner-portfolio-2026-10-11.json"), "utf8")) as { market: string; owner: string; b64: string };

/** The v2.2 fresh-ID wrapper program. */
export const V22_PROGRAM = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
/** Address the captured one-slot market lived at. */
export const V22_SLAB = new PublicKey(MARKET_FX.market);
/** The captured portfolio's owner. */
export const V22_OWNER = new PublicKey(PORTFOLIO_FX.owner);

/** A fresh copy of the captured one-slot v2.2 market account (4,059 B, VERSION 19). */
export const v22MarketBytes = (): Uint8Array => new Uint8Array(Buffer.from(MARKET_FX.dataBase64, "base64"));
/** A fresh copy of the captured flat v2.2 portfolio (10,603 B, VERSION 19). */
export const v22PortfolioBase = (): Buffer => Buffer.from(liftV22Portfolio(new Uint8Array(Buffer.from(PORTFOLIO_FX.b64, "base64")))); // recorded pre-#299: lifted to disc 20 / 10,607 B

const LEG = LAYOUT_V22.portfolio.leg;
const LEG0 = LAYOUT_V22.portfolio.legsOff;
export const V22_LEG_ACTIVE = LEG0 + LEG.active;
export const V22_LEG_SIDE = LEG0 + LEG.side;
export const V22_LEG_BASIS = LEG0 + LEG.basisPosQ;

/** The captured portfolio with its first leg patched (and, optionally, re-owned / re-homed). */
export function v22Portfolio(o: { side: 0 | 1; basis: bigint; active?: boolean; owner?: PublicKey; market?: PublicKey }): Buffer {
  const d = v22PortfolioBase();
  (o.market ?? V22_SLAB).toBuffer().copy(d, 16);
  if (o.owner) o.owner.toBuffer().copy(d, 116);
  d[V22_LEG_ACTIVE] = o.active === false ? 0 : 1;
  d[V22_LEG_SIDE] = o.side;
  d.writeBigUInt64LE(o.basis, V22_LEG_BASIS);
  return d;
}

/**
 * A v2.2 portfolio whose PortfolioMatcherConfigV16 control word has `enabled` set (an LP) or clear (a trader). The control word is the last
 * u64 of the 104 B config: matcher_program[32] | matcher_context[32] | matcher_delegate[32] | control[8] (bit 0 = enabled).
 */
export function v22MatcherPortfolio(enabled: boolean, base: Buffer = v22PortfolioBase()): Buffer {
  const d = Buffer.from(base);
  d.writeBigUInt64LE(enabled ? 1n : 0n, LAYOUT_V22.portfolio.matcherConfigOff + 96);
  return d;
}

/** As {@link v22MatcherPortfolio} on the ACTIVE mode's layout (v2.1 9,563 B flag off, captured v2.2 10,603 B flag on). */
export function matcherPortfolio(enabled: boolean): Buffer {
  const d = isDevnetV22Enabled() ? v22PortfolioBase() : blankPortfolio();
  d.writeBigUInt64LE(enabled ? 1n : 0n, activePortfolioGeometry().matcherConfigOff + 96);
  return d;
}

/**
 * An otherwise-ZERO v2.2 market (one slot, 4,059 B) that keeps only what makes it a market the decoders accept: the wrapper header
 * (magic, VERSION 19, kind 1) and the group config up to the vault field (slot capacity). Callers write the fields they test through
 * `marketOffsets(d).hdr(C.H_*)`, so every other field reads 0, the way the old zero-filled v2.1 fixtures did.
 */
export function v22BlankMarket(slots = 1): Uint8Array {
  const src = v22MarketBytes();
  const d = new Uint8Array(LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen + slots * LAYOUT_V22.assetSlotStride);
  const g = LAYOUT_V22.marketGroupOff;
  d.set(src.subarray(0, 16));
  d.set(src.subarray(g, g + LAYOUT_V22.group.vault), g);
  return d;
}

/**
 * An otherwise-ZERO v2.2 portfolio (10,603 B): the wrapper header (magic, VERSION 19, kind 2) and the engine provenance header
 * (version + layout discriminator) that the guard checks. Fields before the legs are written at the v2.1 constants (they do not move);
 * fields after the legs (receipt, stale states, locks) at `constant + V22_AFTER_LEGS_SHIFT`.
 */
export function v22BlankPortfolio(): Buffer {
  const src = v22PortfolioBase();
  const d = Buffer.alloc(src.length);
  const P = LAYOUT_V22.portfolio;
  src.copy(d, 0, 0, 16);
  src.copy(d, P.provenanceVersionOff, P.provenanceVersionOff, P.provenanceDiscriminatorOff + 2);
  return d;
}

/** Bytes by which every portfolio field AFTER the legs moved from v2.1 to v2.2: `legCount * (legStride - 152)` (1,040). */
export const V22_AFTER_LEGS_SHIFT = LAYOUT_V22.portfolio.legCount * (LAYOUT_V22.portfolio.legStride - 152);

/** Pin the v2.2 flag ON (and lot exponent 0, so the N1 lot gate is open) for every test of the calling file, in every mode. */
export function pinV22(): void {
  beforeEach(() => {
    __setDevnetV22ForTest(true);
    __setUnknownLotExpForTest(0);
  });
  afterEach(() => {
    __setDevnetV22ForTest(null);
    __setUnknownLotExpForTest(null);
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// MODE-AWARE builders. A test converted to these runs the SAME assertions in every mode: flag OFF keeps exercising the v2.1
// (VERSION 18) bytes that the live v2 playground still uses; the flag ON (v2.2) modes exercise captured / layout-true VERSION-19
// bytes. Nothing here pins the flag: the mode comes from the environment, exactly as in production.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bytes by which every portfolio field AFTER the legs moved from v2.1 to v2.2 (0 when the flag is off). */
export const afterLegsShift = (): number => (isDevnetV22Enabled() ? V22_AFTER_LEGS_SHIFT : 0);

/** The portfolio geometry of the ACTIVE layout (v2.1 flag off, v2.2 flag on). */
export const activePortfolioGeometry = () => activeLayout().portfolio;

/** An otherwise-zero portfolio of the ACTIVE layout: header (magic, VERSION, kind 2) and, on v2.2, the provenance header. */
export function blankPortfolio(): Buffer {
  if (isDevnetV22Enabled()) return v22BlankPortfolio();
  const d = Buffer.alloc(LAYOUT_V21.portfolio.accountLen);
  d.writeBigUInt64LE(LAYOUT_V21_MAGIC, 0);
  d.writeUInt16LE(LAYOUT_V21.version, 8);
  d[10] = 2;
  return d;
}

/**
 * An otherwise-zero market of the ACTIVE layout: header (magic, VERSION, kind 1) and, on v2.2, the group config. `slots` = whole asset slots
 * after the group (v2.1 default 0, i.e. the group only, as the old fixtures were; v2.2 default 1, the smallest market the program creates).
 */
export function blankMarket(slots = 0): Uint8Array {
  if (isDevnetV22Enabled()) return v22BlankMarket(slots || 1);
  const d = new Uint8Array(LAYOUT_V21.marketGroupOff + LAYOUT_V21.marketGroupLen + slots * LAYOUT_V21.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, LAYOUT_V21_MAGIC, true);
  v.setUint16(8, LAYOUT_V21.version, true);
  d[10] = 1;
  return d;
}

/**
 * The captured one-slot market + flat trader portfolio of the ACTIVE mode: v2.2 captured bytes with the flag on; with the flag off the
 * v2.1 ANSEM market and DAC2a44p portfolio the v2.1 tests have always used.
 */
export function modeFixtures(): { market: Uint8Array; portfolioBase: Buffer; owner: PublicKey; slab: PublicKey; program: PublicKey } {
  if (isDevnetV22Enabled()) return { market: v22MarketBytes(), portfolioBase: v22PortfolioBase(), owner: V22_OWNER, slab: V22_SLAB, program: V22_PROGRAM };
  const b64 = (f: string) => Buffer.from(JSON.parse(readFileSync(join(FX, f), "utf8")).dataBase64, "base64");
  const base = b64("DAC2a44p.portfolio.json");
  return {
    market: new Uint8Array(b64("5bVTTMRc.ansem.market.json")),
    portfolioBase: base,
    owner: new PublicKey(base.subarray(116, 148)),
    slab: new PublicKey(base.subarray(16, 48)), // the market this portfolio belongs to
    program: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
  };
}

/** `v22Portfolio` on the ACTIVE mode's fixtures (leg offsets 356 / 369 / 370 are the same on v2.1 and v2.2). */
export function modePortfolio(fx: ReturnType<typeof modeFixtures>, o: { side: 0 | 1; basis: bigint; active?: boolean; owner?: PublicKey; market?: PublicKey }): Buffer {
  const d = Buffer.from(fx.portfolioBase);
  (o.market ?? fx.slab).toBuffer().copy(d, 16);
  if (o.owner) o.owner.toBuffer().copy(d, 116);
  d[V22_LEG_ACTIVE] = o.active === false ? 0 : 1;
  d[V22_LEG_SIDE] = o.side;
  d.writeBigUInt64LE(o.basis, V22_LEG_BASIS);
  return d;
}

/**
 * The captured one-slot v2.2 market with its backing buckets LAPSED: both sides' bucket is Fresh (status 1) with an expiry slot long in the past,
 * so the engine would accept ExpireBackingBucket (tag 71) and the app plans a self-heal "expire" repair. Offsets are the rustc `offset_of!` values
 * of the deployed struct (EngineAssetSlotV16Account.backing_long/short, BackingBucketV16Account.status/expiry_slot in v22-rust-layout-aca02ba6.json),
 * read from that JSON rather than from the app's own tables.
 */
export function v22LapsedMarket(): Uint8Array {
  const d = v22MarketBytes();
  const engine = LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen + LAYOUT_V22.wrapperSlotLen;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (const side of [RUST.offsets.EngineAssetSlotV16Account.backing_long, RUST.offsets.EngineAssetSlotV16Account.backing_short]) {
    const b = engine + side;
    d[b + RUST.offsets.BackingBucketV16Account.status] = 1; // BUCKET_STATUS_FRESH
    dv.setBigUint64(b + RUST.offsets.BackingBucketV16Account.expiry_slot, 1n, true);
  }
  return d;
}

/**
 * A market of the ACTIVE mode whose asset 0 `asset_admin` is `admin`. asset_admin sits at the asset's wrapper-slot prefix + 368
 * (AssetOracleProfileV16.asset_admin, v22-rust-layout-aca02ba6.json), in both layouts. Flag off: a zero buffer long enough to hold it (the v2.1
 * reader never looked at more); flag on: an otherwise-zero VERSION-19 one-slot market, because the VERSION-keyed reader needs a real header and
 * `assetProfileOff` refuses to guess the layout without the bytes.
 */
export function marketWithAssetAdmin(admin: PublicKey): Uint8Array {
  const slot0 = isDevnetV22Enabled() ? LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen : LAYOUT_V21.marketGroupOff + LAYOUT_V21.marketGroupLen;
  const d = isDevnetV22Enabled() ? v22BlankMarket(1) : new Uint8Array(slot0 + 368 + 4096);
  d.set(admin.toBytes(), slot0 + 368);
  return d;
}

/**
 * A market-account image of exactly `len` bytes for the ACTIVE mode's wrapper header: magic + VERSION (18 / 19) + kind 1 and, on v2.2, the group
 * config of the captured market, so the VERSION-keyed readers accept the header. Used where a test varies only the account LENGTH (resume paths).
 */
export function marketImageOfLen(len: number): Buffer {
  const d = Buffer.alloc(len);
  const head = Buffer.from(blankMarket(1)).subarray(0, len);
  head.copy(d, 0);
  if (!isDevnetV22Enabled()) {
    d.writeBigUInt64LE(LAYOUT_V21_MAGIC, 0);
    d.writeUInt16LE(LAYOUT_V21.version, 8);
  }
  return d;
}

/**
 * Open the v2.2 N1 lot gate with exponent 0 for every test of the calling file (flag off this is a no-op). With the flag on, a market's price is
 * withheld until its lot exponent has been observed from market bytes; tests whose fixtures carry no market bytes say "this market has no lots"
 * explicitly instead of relying on the app to guess. Reset after each test.
 */
export function seedLotExp0(): void {
  beforeEach(() => {
    __setUnknownLotExpForTest(0);
  });
  afterEach(() => {
    __setUnknownLotExpForTest(null);
  });
}
