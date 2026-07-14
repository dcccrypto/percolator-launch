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

import { Buffer } from "buffer";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  AccountKind,
  parsePortfolioV17,
  type Account,
  type PortfolioLegV17,
  type PortfolioV17,
} from "@percolatorct/sdk";
import { isLpPortfolio } from "@/lib/lpPortfolio";

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
    fSnap: 0n,
    adlABasis: 0n,
    adlKSnap: 0n,
    adlEpochSnap: 0n,
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
  /** Raw parsed result, or null if the wallet owns no matching portfolio. */
  raw: OwnPortfolioScanResult | null;
  /** `raw` mapped through `portfolioV17ToAccount`, cached so
   *  `getPortfolioUserAccountSnapshot` returns a referentially STABLE object
   *  when `raw` hasn't changed (required for correct `useSyncExternalStore`
   *  behaviour — recomputing a fresh object on every read would defeat the
   *  whole point of the equality bail-out). */
  userAccount: UserAccountInfo | null;
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
      listeners: new Set(),
      lastTriggerRaw: null,
      inFlight: null,
      provisionalUntil: 0,
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
  if (!bypassEqualityForProvisional && ownPortfolioResultsEqual(entry.raw, result)) return;
  entry.raw = result;
  entry.userAccount = result ? { idx: 0, account: portfolioV17ToAccount(result.portfolio) } : null;
  entry.provisionalUntil = 0;
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

    let result: OwnPortfolioScanResult | null = null;
    // Drop the market's LP portfolio BEFORE the sort/pick below — see
    // isLpPortfolio's doc comment. Only relevant when this wallet is the
    // market's CREATOR (the LP's owner == the creator's wallet); for every
    // other wallet the owner filter above already excludes it.
    const nonLpResults = results.filter(({ account }) => !isLpPortfolio(account.data));
    if (nonLpResults.length > 0) {
      // M10: getProgramAccounts doesn't guarantee stable ordering across RPC
      // nodes/calls. If more than one account ever matches this owner+market
      // filter, picking an arbitrary array element can select a DIFFERENT
      // portfolio than useDeposit.ts / useWithdraw.ts pick for the exact same
      // wallet+market — the displayed account could silently disagree with
      // the one deposit/withdraw actually mutate. Sort deterministically by
      // pubkey so every caller (useUserAccount AND usePositionNft, both fed
      // by this same store) converges on the same account.
      const sorted = [...nonLpResults].sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()));
      const data = sorted[0].account.data;
      const portfolio = parsePortfolioV17(data instanceof Buffer ? data : Buffer.from(data));
      // Defense-in-depth: re-verify the mutable owner actually matches after fetch —
      // memcmp filters are advisory server-side; don't trust them blindly.
      if (portfolio.owner.equals(params.publicKey)) {
        result = { pubkey: sorted[0].pubkey, portfolio };
      }
    }
    publishPortfolioResult(entry, result);
    return entry.raw;
  } catch (e) {
    // Transient RPC error (429, timeout) — keep-last-good: do NOT publish,
    // so every subscriber (useUserAccount's ~8 instances + usePositionNft)
    // keeps showing the last good position/balance instead of all blanking
    // simultaneously on one blip.
    console.debug("[userAccountScan] portfolio scan failed, keeping last-good cache", e);
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
export function applyConfirmedFill(key: string, signedSizeDeltaQ: bigint): boolean {
  const entry = portfolioEntries.get(key);
  if (!entry || !entry.raw) return false;

  const prevPortfolio = entry.raw.portfolio;
  const legIdx = prevPortfolio.legs.findIndex((l) => l.active);
  if (legIdx === -1) return false;

  const prevLeg = prevPortfolio.legs[legIdx];
  const newBasisPosQ = prevLeg.basisPosQ + signedSizeDeltaQ;

  const newLegs = prevPortfolio.legs.slice();
  newLegs[legIdx] = { ...prevLeg, basisPosQ: newBasisPosQ };

  const patched: OwnPortfolioScanResult = {
    pubkey: entry.raw.pubkey,
    portfolio: { ...prevPortfolio, legs: newLegs },
  };

  entry.raw = patched;
  entry.userAccount = { idx: 0, account: portfolioV17ToAccount(patched.portfolio), provisional: true };
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
