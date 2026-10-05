"use client";

/**
 * Shared v17 on-chain scan store for useUserAccount / usePositionNft /
 * useNftWrappedPosition.
 *
 * WHY this exists (frontend perf audit, 2026-07-12): each of those hooks is
 * mounted many times simultaneously on the desktop trade page — useUserAccount
 * alone is mounted from OrderTicket, PositionsDock's PositionRow, TradingChart
 * (twice — the price-axis effect AND PositionSummary), useLiqPrice,
 * ChartPnlBadge, PositionNftPanel, and AutoDepositProvider (~8 instances) —
 * and EVERY instance re-ran its OWN `getProgramAccounts` scan every time
 * SlabProvider's `raw` changed (~every 10s, on every keeper AuthMark push).
 * That's 8-12 concurrent, near-identical RPC scans firing every ~10s, mostly
 * wasted work (deduped only when they happened to land inside batchRpc's
 * 100ms coalescing window). usePositionNft and useNftWrappedPosition
 * independently issue the SAME queries again on top of that.
 *
 * This module gives each of the two DISTINCT v17 queries exactly one shared,
 * subscriber-counted result per cache key, mirroring `lib/priceStore/
 * priceStore.ts`'s per-slab entry map and `useOracleFreshness`'s shared-ticker
 * pattern:
 *
 *   1. Portfolio scan (`triggerPortfolioScan` / `subscribePortfolioScan`) —
 *      magic + market_group_id (offset 16) + mutable owner (offset 116, SDK
 *      PF_OWNER_OFF — NOT provenance offset 80, a known footgun: MintPositionNft
 *      moves the mutable owner to the escrow PDA on wrap but leaves provenance
 *      pointing at the original wallet) memcmp filters. Used by useUserAccount
 *      (mapped to the legacy `Account` shape) AND by usePositionNft's v17 path
 *      (which needs the raw parsed portfolio + its own pubkey to derive the
 *      NFT PDA) — those two hooks issue byte-for-byte the same gPA query.
 *   2. Held-NFT scan (`triggerHeldNftScan` / `subscribeHeldNftScan`) —
 *      PositionNft accounts with `last_holder` (offset 167) == wallet. Used by
 *      usePositionNft's "received via transfer" fallback path AND by
 *      useNftWrappedPosition — again, byte-for-byte the same query.
 *
 * Dedup + "awaitable" design: every hook instance's effect fires in the same
 * React commit when SlabProvider's `raw` changes (all consumers read the SAME
 * `raw` object reference from context), so the trigger functions dedupe by
 * `raw` IDENTITY — the first call for a given `raw` starts the real RPC call
 * and stores the in-flight promise on the entry; every other call (same key,
 * same `raw`, whether from another instance of the SAME hook or from a
 * DIFFERENT hook needing the same query) joins that promise instead of
 * firing its own. Once resolved for that `raw`, later calls resolve
 * immediately from cache. Callers that need a value to keep working with
 * synchronously (usePositionNft's sequential mint/transfer/burn logic) can
 * simply `await` the trigger; callers that only need "the shared store will
 * eventually update" (useUserAccount) can fire-and-forget and read via
 * `useSyncExternalStore`.
 *
 * Equality bail-out: after a scan succeeds, the parsed result is compared
 * field-by-field against the entry's previously PUBLISHED snapshot. If
 * nothing meaningful changed (position size, capital, pnl, owner, pubkey,
 * fee state), the OLD object reference is kept — not just a value-equal new
 * object — so every subscriber's `useSyncExternalStore` treats it as
 * "no change" and skips re-rendering. This is what actually stops the ~10s
 * re-render storm on PositionsDock / PositionSummary / ChartPnlBadge, not
 * just the RPC dedup.
 *
 * Keep-last-good: a transient error (RPC 429, timeout, malformed bytes)
 * never publishes a blank/null result — the entry's last good snapshot is
 * left untouched so a single blip doesn't blank the user's position/balance
 * (or flip a minted NFT to "Not minted", inviting a doomed re-mint) across
 * every consumer. Only an actually-SUCCESSFUL scan that finds zero matching
 * accounts publishes "nothing here". Mirrors SlabProvider.tsx's
 * `s.config ? s : { ...s, error }` keep-last-good guard.
 */

import { listOwnerPortfolios } from "@/lib/owner-portfolio";
import { Buffer } from "buffer";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  AccountKind,
  parsePortfolioV17,
  type Account,
  type PortfolioLegV17,
  type PortfolioV17,
} from "@percolatorct/sdk";

// ---------------------------------------------------------------------------
// Shared UserAccountInfo shape + v17→legacy Account mapper.
// Moved here (from useUserAccount.ts) so both the portfolio-scan store and
// useNftWrappedPosition can use it without a circular import between
// useUserAccount.ts and this module. useUserAccount.ts re-exports both names
// so its existing public API (and useNftWrappedPosition's existing import
// site) doesn't need to change.
// ---------------------------------------------------------------------------

export interface UserAccountInfo {
  idx: number;
  account: Account;
  pubkey?: PublicKey;
  /** `true` only on the snapshot published immediately by
   *  `applyConfirmedFill` (a locally-patched confirmed-fill result), and
   *  only until the next real scan reconciles it (see that function's doc
   *  and `PortfolioEntry.provisionalUntil`). The position SIZE on this
   *  snapshot is already an accurate, confirmed on-chain fact — this flag
   *  exists purely so a consumer MAY show a subtle "settling" affordance
   *  while capital/pnl/fee fields on this same object are still the
   *  pre-trade values, not because the size itself is in doubt. Absent
   *  (`undefined`) on every snapshot that came from a real scan or the v12
   *  bitmap path. */
  provisional?: boolean;
}

/**
 * Map a parsed v17 portfolio to the legacy Account shape consumed by TradeForm,
 * DepositWithdrawCard, useClosePosition, useAutoDeposit, and usePortfolio.
 *
 * Mapping:
 *   capital       → portfolio.capital
 *   positionSize  → legs[0].basisPosQ if legs[0].active, else 0n
 *   entryPrice    → 0n (not stored in v17, same as v12.17)
 *   pnl           → portfolio.pnl
 *   kind          → AccountKind.User
 *   owner         → portfolio.owner
 *   matcherProgram/matcherContext → PublicKey.default (not needed for taker path)
 *   feeCredits    → portfolio.feeCredits
 *   All other v12 fields → safe zero defaults
 */
export function portfolioV17ToAccount(portfolio: PortfolioV17): Account {
  const ZERO_PK = new PublicKey(new Uint8Array(32));
  const activeLeg = portfolio.legs.find((l) => l.active);
  return {
    kind: AccountKind.User,
    accountId: 0n,
    capital: portfolio.capital,
    pnl: portfolio.pnl,
    reservedPnl: portfolio.reservedPnl,
    warmupStartedAtSlot: 0n,
    warmupSlopePerStep: 0n,
    positionSize: activeLeg ? activeLeg.basisPosQ : 0n,
    entryPrice: 0n,
    fundingIndex: 0n,
    matcherProgram: ZERO_PK,
    matcherContext: ZERO_PK,
    owner: portfolio.owner,
    feeCredits: portfolio.feeCredits,
    lastFeeSlot: portfolio.lastFeeSlot,
    feesEarnedTotal: 0n,
    exactReserveCohorts: null,
    exactCohortCount: null,
    overflowOlder: null,
    overflowOlderPresent: null,
    overflowNewest: null,
    overflowNewestPresent: null,
    fSnap: activeLeg ? activeLeg.fSnap : 0n,
    // The ADL factor frozen into the leg when it was opened. Carried through so
    // consumers can recover the position's EFFECTIVE exposure: auto-deleveraging
    // scales the asset's shared per-side `a` and never rewrites `basis_pos_q`, so
    // `positionSize` alone over-reports a deleveraged position (see lib/v17-adl.ts).
    // Was hardcoded 0n, which silently discarded the only leg-side input that math
    // needs. `entryPrice` above stays 0n — v17 genuinely does not store one.
    adlABasis: activeLeg ? activeLeg.aBasis : 0n,
    adlKSnap: activeLeg ? activeLeg.kSnap : 0n,
    adlEpochSnap: activeLeg ? activeLeg.epochSnap : 0n,
    schedPresent: null,
    schedRemainingQ: null,
    schedAnchorQ: null,
    schedStartSlot: null,
    schedHorizon: null,
    schedReleaseQ: null,
    pendingPresent: null,
    pendingRemainingQ: null,
    pendingHorizon: null,
    pendingCreatedSlot: null,
  } as Account;
}

// ---------------------------------------------------------------------------
// Portfolio scan store — magic + market_group_id + mutable owner (offset 116)
// ---------------------------------------------------------------------------

const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF = 16;
const V17_PF_OWNER_OFF = 116;

// ---------------------------------------------------------------------------
// LP-portfolio exclusion helper.
//
// Moved to lib/lpPortfolio.ts (2026-07-13) — that module carries the full
// "why" doc comment (creator LP-mistaken-for-own-account bug, plus the new
// server-side use by app/api/markets/[slab]/logo/route.ts) — so it's a plain
// (non `"use client"`) module a server route can import directly. Re-exported
// here so every existing call site in this file (and useMintPositionNft,
// usePortfolio, useDeposit, useWithdraw, useClosePosition, useTrade,
// useInitUser, useCreatedMarkets) keeps working unchanged.
// ---------------------------------------------------------------------------
export { PORTFOLIO_MATCHER_CONFIG_LEN, isLpPortfolio } from "@/lib/lpPortfolio";

/** Raw scan result: the owned portfolio's own account pubkey + full parsed
 *  state. Kept in this richer shape (rather than just the mapped `Account`)
 *  because usePositionNft needs the account's own pubkey (to derive the NFT
 *  PDA) and the full per-leg data (marketId, side, etc.) that
 *  `portfolioV17ToAccount` intentionally discards. */
export interface OwnPortfolioScanResult {
  pubkey: PublicKey;
  portfolio: PortfolioV17;
}

interface PortfolioEntry {
  /** Raw parsed result, or null if the wallet owns no matching portfolio.
   *  This is the SINGLE deterministic pick (lowest base58 pubkey) — it is
   *  `rawList[0]` by construction — and remains the sole thing every existing
   *  single-portfolio consumer (useUserAccount, deposit/withdraw default, the
   *  ticket) reads, so their behaviour is unchanged. */
  raw: OwnPortfolioScanResult | null;
  /** `raw` mapped through `portfolioV17ToAccount`, cached so
   *  `getPortfolioUserAccountSnapshot` returns a referentially STABLE object
   *  when `raw` hasn't changed (required for correct `useSyncExternalStore`
   *  behaviour — recomputing a fresh object on every read would defeat the
   *  whole point of the equality bail-out). */
  userAccount: UserAccountInfo | null;
  /** #2560: ALL of the wallet's portfolios on this market (the full set `raw`
   *  is the head of), sorted by base58 pubkey. Published from the SAME scan —
   *  no extra RPC. Empty when the wallet owns none. Consumers that render one
   *  row per portfolio (the multi-portfolio positions view) read this; with a
   *  single portfolio it holds exactly `[raw]`, so nothing about the one-
   *  portfolio UI changes. `null` = not yet scanned (distinct from `[]`). */
  rawList: OwnPortfolioScanResult[];
  /** `rawList` mapped through `portfolioV17ToAccount`, cached for a stable
   *  `useSyncExternalStore` reference (same discipline as `userAccount`).
   *  `null` until the first scan publishes. */
  userAccounts: UserAccountInfo[] | null;
  listeners: Set<() => void>;
  /** Identity of the `raw` (SlabProvider) Uint8Array that triggered the scan
   *  currently cached/in-flight. Every hook instance in the same React commit
   *  reads the SAME `raw` object reference from context, so comparing by
   *  `===` lets the FIRST caller "claim" this raw value and every other
   *  caller (same instance's sibling re-renders, other hook instances, or a
   *  different hook needing the same query) join instead of re-firing. */
  lastTriggerRaw: Uint8Array | null;
  /** In-flight scan promise for `lastTriggerRaw`, or null once settled. */
  inFlight: Promise<OwnPortfolioScanResult | null> | null;
  /** Epoch-ms deadline set by `applyConfirmedFill` after a locally-patched
   *  "provisional" publish (see that function's doc). `0` = not provisional.
   *  While `Date.now()` is before this deadline, the NEXT publish (the real
   *  scan already in flight via useTrade's refresh burst) must go through
   *  even if it happens to compare equal to the provisional snapshot —
   *  scans are the source of truth and must always be able to supersede a
   *  locally-guessed patch. Cleared on the next publish, whatever its
   *  outcome. */
  provisionalUntil: number;
  /** GH#2707: `true` once ANY portfolio scan for this key has completed
   *  successfully. Until then `userAccount === null` means "not known yet",
   *  NOT "this wallet has no account" — `getPortfolioScanResolved` exposes
   *  the difference so surfaces can render loading instead of absence. Never
   *  reset back to `false` (entries are never evicted; a failed later scan
   *  keeps the last good snapshot, which is still a resolved answer). */
  scanned: boolean;
}

const portfolioEntries = new Map<string, PortfolioEntry>();

export function makePortfolioScanKey(programId: PublicKey, slabAddress: string, wallet: PublicKey): string {
  return `${programId.toBase58()}|${slabAddress}|${wallet.toBase58()}`;
}

function getOrCreatePortfolioEntry(key: string): PortfolioEntry {
  let entry = portfolioEntries.get(key);
  if (!entry) {
    entry = {
      raw: null,
      userAccount: null,
      rawList: [],
      userAccounts: null,
      listeners: new Set(),
      lastTriggerRaw: null,
      inFlight: null,
      provisionalUntil: 0,
      scanned: false,
    };
    portfolioEntries.set(key, entry);
  }
  return entry;
}

function notifyPortfolio(entry: PortfolioEntry): void {
  for (const l of entry.listeners) l();
}

/** Field-by-field comparison of the meaningful primitive data carried by a
 *  v17 portfolio scan — position size, capital, pnl, owner, the portfolio
 *  account's own pubkey, and fee state. Two results that agree on all of
 *  these represent the SAME economic state even if they came from
 *  independent RPC round-trips, so the caller keeps the OLD object
 *  reference and skips the notify. */
function ownPortfolioResultsEqual(a: OwnPortfolioScanResult | null, b: OwnPortfolioScanResult | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (!a.pubkey.equals(b.pubkey)) return false;
  const pa = a.portfolio;
  const pb = b.portfolio;
  if (!pa.owner.equals(pb.owner)) return false;
  if (pa.capital !== pb.capital) return false;
  if (pa.pnl !== pb.pnl) return false;
  if (pa.reservedPnl !== pb.reservedPnl) return false;
  if (pa.feeCredits !== pb.feeCredits) return false;
  if (pa.lastFeeSlot !== pb.lastFeeSlot) return false;
  const legA = pa.legs.find((l) => l.active) ?? null;
  const legB = pb.legs.find((l) => l.active) ?? null;
  if ((legA === null) !== (legB === null)) return false;
  if (legA && legB) {
    if (legA.basisPosQ !== legB.basisPosQ) return false;
    if (legA.marketId !== legB.marketId) return false;
    if (legA.assetIndex !== legB.assetIndex) return false;
    if (legA.side !== legB.side) return false;
  }
  return true;
}

function publishPortfolioResult(entry: PortfolioEntry, result: OwnPortfolioScanResult | null): void {
  // A provisional (locally-patched by applyConfirmedFill) snapshot must
  // never "stick" past the next real scan, even if that scan's data happens
  // to compare equal field-for-field (e.g. the patch guessed the exact same
  // basisPosQ the engine landed on) — bypass the equality bail-out for this
  // one publish so the real, scan-sourced object always becomes the
  // published reference again.
  const bypassEqualityForProvisional = entry.provisionalUntil > 0 && Date.now() < entry.provisionalUntil;
  // GH#2707: the FIRST successful scan must always notify, even when its
  // result equals the initial `null` (a wallet with no account): that publish
  // is what flips subscribers from "pending" to "resolved: no account".
  const firstResolution = !entry.scanned;
  entry.scanned = true;
  if (!firstResolution && !bypassEqualityForProvisional && ownPortfolioResultsEqual(entry.raw, result)) return;
  entry.raw = result;
  entry.userAccount = result ? { idx: 0, account: portfolioV17ToAccount(result.portfolio), pubkey: result.pubkey } : null;
  entry.provisionalUntil = 0;
  notifyPortfolio(entry);
}

/** Element-wise `ownPortfolioResultsEqual` over two ordered lists (both are
 *  always base58-sorted by `listOwnerPortfolios`, so position is meaningful). */
function ownPortfolioListsEqual(a: OwnPortfolioScanResult[], b: OwnPortfolioScanResult[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!ownPortfolioResultsEqual(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Publish the full owned-portfolio list from a scan. Equality bail-out keeps
 * the old array reference (and skips the notify) when nothing meaningful
 * changed, exactly like `publishPortfolioResult`. The first publish always
 * goes through (null → array), so subscribers flip from "pending" to resolved
 * even for an empty list. Does NOT touch `raw`/`userAccount`.
 *
 * F3: `forcePublish` bypasses the equality bail-out when the entry is
 * provisional (a confirmed-fill patch is in flight) — the same guard
 * `publishPortfolioResult` applies to the single snapshot. Without it, an
 * equal-value reconciling scan would leave a stale `provisional:true` flag on
 * the list's primary entry and never notify. `runPortfolioScan` samples the
 * provisional state BEFORE `publishPortfolioResult` clears it and passes it here.
 *
 * F4: unchanged rows keep their previous mapped-object identity, so a memoized
 * multi-row view only re-renders the rows that actually changed. Identity reuse
 * is disabled on a `forcePublish` so the provisional flag is dropped from a
 * reconciled primary (the fresh mapped object carries no `provisional`).
 */
function publishPortfolioList(entry: PortfolioEntry, list: OwnPortfolioScanResult[], forcePublish = false): void {
  if (entry.userAccounts !== null && !forcePublish && ownPortfolioListsEqual(entry.rawList, list)) return;
  const prev = new Map<string, { res: OwnPortfolioScanResult; acct: UserAccountInfo }>();
  if (entry.userAccounts && !forcePublish) {
    entry.rawList.forEach((r, i) => prev.set(r.pubkey.toBase58(), { res: r, acct: entry.userAccounts![i] }));
  }
  entry.userAccounts = list.map((r) => {
    const p = prev.get(r.pubkey.toBase58());
    if (p && ownPortfolioResultsEqual(p.res, r)) return p.acct; // unchanged → stable identity
    return { idx: 0, account: portfolioV17ToAccount(r.portfolio), pubkey: r.pubkey };
  });
  entry.rawList = list;
  notifyPortfolio(entry);
}

export function subscribePortfolioScan(key: string, listener: () => void): () => void {
  const entry = getOrCreatePortfolioEntry(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    // Intentionally NOT deleting the Map entry on last-listener-gone (mirrors
    // priceStore's "last-known snapshot is intentionally kept cached" — a
    // quick remount / market switch-back shouldn't flash back to loading).
  };
}

/** Reactive read for useUserAccount — the mapped legacy `Account` shape. */
export function getPortfolioUserAccountSnapshot(key: string | null): UserAccountInfo | null {
  if (!key) return null;
  return portfolioEntries.get(key)?.userAccount ?? null;
}

/** A stable empty list so `getPortfolioListSnapshot` returns a referentially
 *  constant value before the first scan — `useSyncExternalStore` requires the
 *  getSnapshot result not to change identity unless the data did. */
const EMPTY_PORTFOLIO_LIST: readonly UserAccountInfo[] = Object.freeze([]);

/** #2560: reactive read of ALL the wallet's portfolios on this market (mapped
 *  `Account` shape, one per portfolio, base58-sorted). Empty array before the
 *  first scan or when the wallet owns none. For the common single-portfolio
 *  case this is `[getPortfolioUserAccountSnapshot(...)]`. */
export function getPortfolioListSnapshot(key: string | null): readonly UserAccountInfo[] {
  if (!key) return EMPTY_PORTFOLIO_LIST;
  return portfolioEntries.get(key)?.userAccounts ?? EMPTY_PORTFOLIO_LIST;
}

/**
 * GH#2707: reactive read of whether the portfolio scan for `key` has
 * completed successfully at least once. `false` while the first scan is in
 * flight (or has only ever failed), so `getPortfolioUserAccountSnapshot`'s
 * `null` is NOT yet proof the wallet has no account. A null key (no wallet /
 * not a v17 market) has nothing to scan and reads `true`.
 */
export function getPortfolioScanResolved(key: string | null): boolean {
  if (!key) return true;
  return portfolioEntries.get(key)?.scanned ?? false;
}

/** Non-reactive read for usePositionNft — the raw parsed portfolio + pubkey. */
export function getPortfolioRawSnapshot(key: string | null): OwnPortfolioScanResult | null {
  if (!key) return null;
  return portfolioEntries.get(key)?.raw ?? null;
}

export interface PortfolioScanParams {
  connection: Connection;
  programId: PublicKey;
  slabAddress: string;
  publicKey: PublicKey;
  /** Identity token for dedup — pass SlabProvider's `raw` Uint8Array. */
  raw: Uint8Array;
}

/**
 * Kick off (or join) the shared portfolio scan for this (program, slab,
 * wallet) key. Returns a promise resolving to the current best-known result
 * — the fresh scan's result on success, or the entry's last-good cached
 * result if this particular call's scan hit a transient error (keep-last-
 * good; the error itself is only logged, never thrown, so callers can always
 * `await` this without a try/catch of their own).
 */
export function triggerPortfolioScan(params: PortfolioScanParams): Promise<OwnPortfolioScanResult | null> {
  const key = makePortfolioScanKey(params.programId, params.slabAddress, params.publicKey);
  const entry = getOrCreatePortfolioEntry(key);

  if (entry.lastTriggerRaw === params.raw) {
    // Another instance already triggered (or completed) a scan for this
    // exact `raw` value — join the in-flight promise, or return the
    // already-settled cached result immediately.
    return entry.inFlight ?? Promise.resolve(entry.raw);
  }

  entry.lastTriggerRaw = params.raw;
  const promise = runPortfolioScan(entry, params).finally(() => {
    if (entry.inFlight === promise) entry.inFlight = null;
  });
  entry.inFlight = promise;
  return promise;
}

async function runPortfolioScan(
  entry: PortfolioEntry,
  params: PortfolioScanParams,
): Promise<OwnPortfolioScanResult | null> {
  let slabPk: PublicKey;
  try {
    slabPk = new PublicKey(params.slabAddress);
  } catch {
    return entry.raw; // malformed address — nothing to scan, keep whatever was cached
  }

  try {
    const results = await params.connection.getProgramAccounts(params.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: V17_PF_MARKET_OFF, bytes: slabPk.toBase58() } },
        { memcmp: { offset: V17_PF_OWNER_OFF, bytes: params.publicKey.toBase58() } },
      ],
    });

    // M-4 / #2560: the ONE selector every flow uses (lib/owner-portfolio.ts):
    // LP dropped, decoded mutable owner verified, base58-sorted. `listOwner-
    // Portfolios` returns the full owned set; the single deterministic pick the
    // existing flows act on is its head (`list[0]`), so `result` below is
    // byte-for-byte what `pickOwnerPortfolio` returned before — nothing about
    // the single-portfolio path changes.
    const owned = listOwnerPortfolios(results, params.publicKey);
    const list: OwnPortfolioScanResult[] = owned.map((p) => ({
      pubkey: p.pubkey,
      portfolio: parsePortfolioV17(p.data),
    }));
    const result: OwnPortfolioScanResult | null = list[0] ?? null;
    // F3: sample provisional BEFORE publishPortfolioResult clears it, so the
    // list publish applies the same provisional-bypass the single snapshot does.
    const wasProvisional = entry.provisionalUntil > 0 && Date.now() < entry.provisionalUntil;
    publishPortfolioResult(entry, result);
    publishPortfolioList(entry, list, wasProvisional);
    return entry.raw;
  } catch (e) {
    // Transient RPC error (429, timeout) — keep-last-good: do NOT publish,
    // so every subscriber (useUserAccount's ~8 instances + usePositionNft)
    // keeps showing the last good position/balance instead of all blanking
    // simultaneously on one blip.
    console.debug("[userAccountScan] portfolio scan failed, keeping last-good cache", e);
    // GH#2707: release the dedup claim on this `raw` so the next trigger for
    // the SAME slab bytes retries instead of joining a settled failure — a
    // failed FIRST scan would otherwise leave the key pending until new slab
    // bytes arrive. Only if no newer `raw` has claimed the entry since.
    if (entry.lastTriggerRaw === params.raw) entry.lastTriggerRaw = null;
    return entry.raw;
  }
}

/** How long a locally-applied confirmed-fill patch stays "provisional" (see
 *  `applyConfirmedFill` and the `provisionalUntil` field doc). Generous
 *  relative to useTrade's refresh burst ([1200, 2200, 3500]ms) so the real
 *  scan that reconciles the trade has every chance to land and force-replace
 *  the patch before the window closes; if nothing lands within it, the entry
 *  just reverts to normal equality-bail behaviour for whatever scan (if any)
 *  eventually catches up. */
const CONFIRMED_FILL_PROVISIONAL_MS = 5_000;

/**
 * Immediately apply a CONFIRMED trade's known signed size delta to the
 * cached portfolio snapshot for `key`, publishing through the normal path so
 * every subscriber (OrderTicket, PositionsDock, ChartPnlBadge, ...)
 * re-renders exactly once — without waiting for the next real scan to land.
 *
 * This is NOT speculative optimism: by the time a caller (useTrade, after
 * `sendTx`'s `pollConfirmation`) invokes this, the transaction has already
 * been verified on-chain. The fill is a confirmed fact; only this store's
 * cached READ of it is stale (racing /api/rpc's server-side account cache —
 * see useTrade.ts's post-confirm comment). This function patches the read,
 * not the future.
 *
 * Only `positionSize` (the active leg's `basisPosQ`, in the SAME
 * coin-margined native units as the trade's `size` param) is updated.
 * Capital/pnl/fee-credit changes from a fill are NOT fully deterministic
 * client-side (fees, funding accrual) — guessing them risks showing a WRONG
 * number where "still the pre-trade number, one row lower-fidelity for a
 * couple seconds" would have been honest. Those fields are left untouched;
 * the real scan already in flight (useTrade's refresh burst) reconciles them
 * within the existing ~1-2s window.
 *
 * No-op (returns `false`, no publish, no notify) when:
 *   - there is no cached scan result for `key` yet — this store doesn't know
 *     this portfolio's pubkey or leg layout at all yet, so there is nothing
 *     to patch (the eventual real scan populates it from scratch); or
 *   - the cached snapshot has no active leg — a delta can't be applied to a
 *     leg that doesn't exist locally (this function never fabricates a new
 *     leg's `marketId`/`assetIndex`/funding-accounting fields; a newly-opened
 *     first position still waits for the real scan, same as before this
 *     function existed).
 *
 * Marks the entry provisional for `CONFIRMED_FILL_PROVISIONAL_MS`:
 * `publishPortfolioResult`'s equality bail-out is bypassed for the next
 * publish that lands inside that window, so the following real scan ALWAYS
 * supersedes this patch — even in the edge case where it recomputes the
 * exact same `basisPosQ` this patch guessed. Scans remain the source of
 * truth; this function only shortens how long a confirmed fill's OWN size
 * change takes to reach the screen.
 */
export function applyConfirmedFill(key: string, signedSizeDeltaQ: bigint, targetPortfolioPk?: PublicKey): boolean {
  const entry = portfolioEntries.get(key);
  if (!entry) return false;

  // #2560: which portfolio did the fill land on? Default (no target) is the
  // primary (lowest-pubkey) `raw` — today's behaviour. An explicit target (a
  // chosen cross/isolated account) patches that portfolio's list entry, and
  // the primary single-snapshot too ONLY when the target IS the primary, so a
  // trade on a non-primary portfolio never bumps the primary's displayed size.
  const primaryPk = entry.raw?.pubkey ?? null;
  const patchesPrimary = !targetPortfolioPk || (primaryPk != null && primaryPk.equals(targetPortfolioPk));
  const li = targetPortfolioPk
    ? entry.rawList.findIndex((r) => r.pubkey.equals(targetPortfolioPk))
    : primaryPk
      ? entry.rawList.findIndex((r) => r.pubkey.equals(primaryPk))
      : -1;

  // The portfolio whose active leg we patch: the primary's `raw`, or the list
  // element for a non-primary target. No cached state → nothing to patch.
  const base: OwnPortfolioScanResult | null = patchesPrimary ? entry.raw : li !== -1 ? entry.rawList[li] : null;
  if (!base) return false;

  const prevPortfolio = base.portfolio;
  const legIdx = prevPortfolio.legs.findIndex((l) => l.active);
  if (legIdx === -1) return false;

  const prevLeg = prevPortfolio.legs[legIdx];
  const newLegs = prevPortfolio.legs.slice();
  newLegs[legIdx] = { ...prevLeg, basisPosQ: prevLeg.basisPosQ + signedSizeDeltaQ };
  const patched: OwnPortfolioScanResult = { pubkey: base.pubkey, portfolio: { ...prevPortfolio, legs: newLegs } };
  const patchedAccount: UserAccountInfo = { idx: 0, account: portfolioV17ToAccount(patched.portfolio), pubkey: patched.pubkey, provisional: true };

  // The single snapshot (useUserAccount) only moves when the primary moved.
  if (patchesPrimary) {
    entry.raw = patched;
    entry.userAccount = patchedAccount;
  }
  // Mirror into the multi-portfolio list so a consumer rendering from it gets
  // the same provisional snappiness. No-op if the portfolio isn't listed yet
  // (a first position still waits for the real scan).
  if (li !== -1 && entry.userAccounts) {
    const newList = entry.rawList.slice();
    newList[li] = patched;
    entry.rawList = newList;
    const newAccts = entry.userAccounts.slice();
    newAccts[li] = patchedAccount;
    entry.userAccounts = newAccts;
  }
  entry.provisionalUntil = Date.now() + CONFIRMED_FILL_PROVISIONAL_MS;
  notifyPortfolio(entry);
  return true;
}

// ---------------------------------------------------------------------------
// Held-NFT scan store — PositionNft accounts with last_holder (offset 167) == wallet
// ---------------------------------------------------------------------------

/** PositionNftV16 on-chain layout is exactly 199 bytes. */
const POSITION_NFT_V17_LEN = 199;
/** `last_holder` — the NFT's current/most-recent holder wallet (set to the
 *  minter at mint, rewritten to the recipient on every transfer). */
const NFT_LAST_HOLDER_OFF = 167;

export interface HeldNftRaw {
  pubkey: PublicKey;
  data: Uint8Array;
}

interface HeldNftEntry {
  /** null = never successfully scanned yet; [] = successfully scanned, wallet holds none. */
  snapshot: HeldNftRaw[] | null;
  listeners: Set<() => void>;
  lastTriggerRaw: Uint8Array | null;
  inFlight: Promise<HeldNftRaw[]> | null;
}

const heldNftEntries = new Map<string, HeldNftEntry>();

export function makeHeldNftScanKey(nftProgramId: PublicKey, wallet: PublicKey): string {
  return `${nftProgramId.toBase58()}|${wallet.toBase58()}`;
}

function getOrCreateHeldNftEntry(key: string): HeldNftEntry {
  let entry = heldNftEntries.get(key);
  if (!entry) {
    entry = { snapshot: null, listeners: new Set(), lastTriggerRaw: null, inFlight: null };
    heldNftEntries.set(key, entry);
  }
  return entry;
}

function notifyHeldNft(entry: HeldNftEntry): void {
  for (const l of entry.listeners) l();
}

/** Full byte-compare — held-NFT accounts are a handful of 199-byte records at
 *  most per wallet, so a byte compare is cheap and avoids parsing just to
 *  decide whether anything changed. */
function heldNftArraysEqual(a: HeldNftRaw[] | null, b: HeldNftRaw[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i].pubkey.equals(b[i].pubkey)) return false;
    if (a[i].data.length !== b[i].data.length) return false;
    for (let j = 0; j < a[i].data.length; j++) {
      if (a[i].data[j] !== b[i].data[j]) return false;
    }
  }
  return true;
}

function publishHeldNftResult(entry: HeldNftEntry, result: HeldNftRaw[]): void {
  if (heldNftArraysEqual(entry.snapshot, result)) return;
  entry.snapshot = result;
  notifyHeldNft(entry);
}

export function subscribeHeldNftScan(key: string, listener: () => void): () => void {
  const entry = getOrCreateHeldNftEntry(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function getHeldNftSnapshot(key: string | null): HeldNftRaw[] | null {
  if (!key) return null;
  return heldNftEntries.get(key)?.snapshot ?? null;
}

export interface HeldNftScanParams {
  connection: Connection;
  nftProgramId: PublicKey;
  wallet: PublicKey;
  /** Identity token for dedup — pass SlabProvider's `raw` Uint8Array. */
  raw: Uint8Array;
}

/**
 * Kick off (or join) the shared held-NFT scan for this (nft program, wallet)
 * key. Same dedup/keep-last-good/awaitable contract as `triggerPortfolioScan`
 * — see that function's doc and the module header.
 */
export function triggerHeldNftScan(params: HeldNftScanParams): Promise<HeldNftRaw[]> {
  const key = makeHeldNftScanKey(params.nftProgramId, params.wallet);
  const entry = getOrCreateHeldNftEntry(key);

  if (entry.lastTriggerRaw === params.raw) {
    return entry.inFlight ?? Promise.resolve(entry.snapshot ?? []);
  }

  entry.lastTriggerRaw = params.raw;
  const promise = runHeldNftScan(entry, params).finally(() => {
    if (entry.inFlight === promise) entry.inFlight = null;
  });
  entry.inFlight = promise;
  return promise;
}

async function runHeldNftScan(entry: HeldNftEntry, params: HeldNftScanParams): Promise<HeldNftRaw[]> {
  try {
    const results = await params.connection.getProgramAccounts(params.nftProgramId, {
      filters: [
        { dataSize: POSITION_NFT_V17_LEN },
        { memcmp: { offset: NFT_LAST_HOLDER_OFF, bytes: params.wallet.toBase58() } },
      ],
    });
    const mapped: HeldNftRaw[] = results.map((r) => ({
      pubkey: r.pubkey,
      data: r.account.data instanceof Uint8Array ? r.account.data : new Uint8Array(r.account.data),
    }));
    publishHeldNftResult(entry, mapped);
    return entry.snapshot ?? [];
  } catch (e) {
    // Keep-last-good — see runPortfolioScan's identical guard above.
    console.debug("[userAccountScan] held-NFT scan failed, keeping last-good cache", e);
    return entry.snapshot ?? [];
  }
}

/** Re-exported for hooks that only have `PortfolioLegV17` in scope via this module. */
export type { PortfolioLegV17 };
