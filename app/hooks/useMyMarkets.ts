"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useMarketDiscovery } from "./useMarketDiscovery";
import {
  parseAllAccounts,
  parsePortfolioV17,
  isV17Account,
  isV17MarketAccount,
  parseMarketGroupV17OI,
  AccountKind,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  type DiscoveredMarket,
  type V17MarketGroupOI,
} from "@percolatorct/sdk";
import { fetchTokenMeta } from "@/lib/tokenMeta";
import { isLpPortfolio } from "@/lib/userAccountScan";

// v17 portfolios are standalone program-owned accounts — mirrors
// findV17Portfolio in useDeposit.ts/useUserAccount.ts. market_group_id at
// offset 16; mutable owner (SDK PF_OWNER_OFF) at offset 116. NOTE: offset 80
// is provenanceOwner — IMMUTABLE — filtering on it would still match a
// wrapped (NFT-escrowed) portfolio (commit 3ae16309).
const V17_PORTFOLIO_MAGIC_MM = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF_MM = 16;
const V17_PF_OWNER_OFF_MM = 116;

// H11: v17 markets carry an empty legacy `engine` block ({}), so /my-markets
// was reading OI/vault/insurance/health off fields that only ever populate on
// v12 — always 0, always "healthy". Real v17 OI + insurance come from
// parseMarketGroupV17OI(rawSlab), which needs the raw account bytes (discovery
// doesn't retain them) — fetched below in a dedicated enrichment pass. Real
// v17 health comes from the asset's accrue slot (`AssetStateV16Account.
// slot_last`, which advances only via crank/trade — NOT PushAuthMark, the
// display-price push) vs the current on-chain slot.
//
// slot_last has no SDK parser yet, so it's read directly off raw bytes here.
// Offset derivation (fully-packed repr(C) Pod struct, zero padding — verified
// by reproducing the SDK's own offsets exactly): AssetStateV16Account =
// market_id(8) + retired_slot(8) + lifecycle(1) + raw_oracle_target_price(8) +
// effective_price(8) + fund_px_last(8) = 41 bytes before slot_last (u64).
// Continuing the same packed sum through a_long..oi_eff_long_q lands exactly
// on the SDK's V17_ASSET_STATE_OI_LONG_REL=273, cross-confirming the method.
const V17_ASSET_SLOT_WRAPPER_SIZE = 512; // 512-byte T-wrapper preceding AssetStateV16Account in each slot
const V17_ASSET_STATE_SLOT_LAST_REL = 41; // slot_last offset within AssetStateV16Account

/** Read `AssetStateV16Account.slot_last` for one asset slot of a v17 market-group account. */
function readV17AssetSlotLast(data: Uint8Array, assetIndex = 0): bigint | null {
  const slotsBase = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const slotBase = slotsBase + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
  const off = slotBase + V17_ASSET_SLOT_WRAPPER_SIZE + V17_ASSET_STATE_SLOT_LAST_REL;
  if (off + 8 > data.length) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getBigUint64(off, true);
}

export interface MyMarket extends DiscoveredMarket {
  /** Formatted label for display (token symbol or truncated address) */
  label: string;
  /** Why this market appears in "my markets" */
  role: "admin" | "trader" | "lp";
  /**
   * v17 only: live OI + insurance parsed from the raw market-group account
   * bytes, plus the asset's accrue slot for real health/staleness. Undefined
   * until the enrichment fetch resolves (or for v12 markets, which use the
   * legacy `engine` block instead).
   */
  v17Stats?: {
    oi: V17MarketGroupOI;
    assetSlotLast: bigint | null;
  };
}

/**
 * Returns markets where the connected wallet is:
 *  - the admin (market creator)
 *  - has a User (trader) account
 *  - has an LP account
 *
 * Discovery returns header-only slices. For non-admin markets we do
 * a second-pass fetch of the full slab to check account ownership.
 * Capped at 30 markets to avoid excessive RPC usage.
 */
export function useMyMarkets() {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { markets, loading: discoveryLoading, error, refetch: discoveryRefetch } = useMarketDiscovery();

  // Token label cache: mint → symbol (persists across re-renders)
  const tokenLabelCache = useRef<Map<string, string>>(new Map());

  const resolveLabel = useCallback(async (m: DiscoveredMarket): Promise<string> => {
    const mint = m.config?.collateralMint;
    if (!mint) return m.slabAddress.toBase58().slice(0, 8) + "…";
    const mintStr = mint.toBase58();
    const cached = tokenLabelCache.current.get(mintStr);
    if (cached) return cached;
    try {
      const meta = await fetchTokenMeta(connection, mint);
      const label = meta.symbol || meta.name || mintStr.slice(0, 8) + "…";
      tokenLabelCache.current.set(mintStr, label);
      return label;
    } catch {
      return mintStr.slice(0, 8) + "…";
    }
  }, [connection]);

  // Admin markets are instant (from header data)
  const [adminMarkets, setAdminMarkets] = useState<MyMarket[]>([]);

  useEffect(() => {
    if (!publicKey || !markets.length) {
      setAdminMarkets([]);
      return;
    }
    let cancelled = false;
    const walletStr = publicKey.toBase58();
    // v17 markets carry an empty header ({}); the market authority lives in
    // configV17.marketauth. Falling back to header.admin keeps v12 working.
    // Optional chaining prevents the TypeError that otherwise blanked the whole
    // admin dashboard for anyone with a v17 market.
    const admins = markets.filter(
      (m) => (m.configV17?.marketauth ?? m.header?.admin)?.toBase58() === walletStr,
    );

    Promise.all(admins.map(async (m) => ({
      ...m,
      label: await resolveLabel(m),
      role: "admin" as const,
    }))).then((results) => {
      if (!cancelled) setAdminMarkets(results);
    });

    return () => { cancelled = true; };
  }, [publicKey, markets, resolveLabel]);

  // Second pass: fetch full slab data to find trader/LP accounts
  const [tradedMarkets, setTradedMarkets] = useState<MyMarket[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  // Track which (wallet + market-set) we've already completed a scan for, to
  // avoid re-blanking on poll. The key MUST include the wallet: it used to be
  // built from market addresses ONLY, so switching wallet A → B while both
  // wallets share the same market set produced an IDENTICAL key — the effect
  // then skipped straight past the "already scanned" check without ever
  // re-running checkAccounts for B, permanently showing A's traded markets to
  // B (HIGH wallet-bleed bug).
  const lastScannedKey = useRef<string>("");

  // requestId/generation guard — checkAccounts below has multiple sequential
  // awaits (a getAccountInfo batch, then a per-v17-market getProgramAccounts
  // call inside it). Without this, switching wallets (or the market set
  // emptying) mid-scan let an OLDER, slower in-flight scan resolve AFTER a
  // newer one and stomp its state (tradedMarkets/accountsLoading/
  // lastScannedKey). Mirrors useLpPositions.ts / useTradeHistory.ts.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!publicKey || !markets.length || discoveryLoading) {
      // Invalidate any in-flight scan from a previous wallet/market-set — it
      // must not land after this reset and stomp state below.
      requestIdRef.current++;
      // Don't clear tradedMarkets on re-poll — keep showing stale data. DO
      // reset accountsLoading though: a scan in flight when this effect's
      // deps changed (wallet disconnect, or markets emptied mid-scan) would
      // otherwise leave it stuck `true` forever — checkAccounts' own
      // `if (!stale())` guard, now permanently false for that scan, is the
      // ONLY place that clears it (stuck-loading bug).
      setAccountsLoading(false);
      return;
    }

    const walletStr = publicKey.toBase58();
    const adminAddrs = new Set(
      markets
        .filter((m) => (m.configV17?.marketauth ?? m.header?.admin)?.toBase58() === walletStr)
        .map((m) => m.slabAddress.toBase58())
    );
    const nonAdminMarkets = markets.filter((m) => !adminAddrs.has(m.slabAddress.toBase58()));

    const toCheck = nonAdminMarkets.slice(0, 30);

    // Build a key from wallet + market addresses to detect actual changes vs
    // poll refreshes — see the comment on `lastScannedKey` above for why the
    // wallet must be part of it.
    const scanKey = `${walletStr}:${toCheck.map((m) => m.slabAddress.toBase58()).sort().join(",")}`;
    if (scanKey === lastScannedKey.current) {
      // Same wallet + same markets, already scanned TO COMPLETION — skip to
      // avoid a blank flash. This used to also require `tradedMarkets.length
      // > 0`, which meant a wallet with ZERO traded markets could never
      // satisfy the skip check and re-ran the full scan every 30s forever
      // (MEDIUM empty-result rescan bug). `lastScannedKey` is only ever
      // written once a scan genuinely completes (see the end of
      // checkAccounts below), independent of how many results it found, so
      // comparing against it alone is sufficient — no result-count gate needed.
      return;
    }

    if (toCheck.length === 0) {
      // Invalidate any scan still in flight for a PRIOR (nonempty) toCheck —
      // otherwise it could resolve after this and overwrite the `[]` just
      // set below with stale results.
      requestIdRef.current++;
      setTradedMarkets([]);
      lastScannedKey.current = scanKey;
      return;
    }

    const requestId = ++requestIdRef.current;
    const stale = () => requestId !== requestIdRef.current;
    setAccountsLoading(true);

    async function checkAccounts() {
      const found: MyMarket[] = [];
      // v17 markets found in the batches below, keyed by slab address, so the
      // SINGLE batched owner-scan after this loop (fixing the N+1 bug: this
      // used to run one getProgramAccounts call PER v17 market found in each
      // batch — with N traded v17 markets that was N sequential round-trips
      // every scan) can match its results back to the market they belong to.
      const v17MarketsBySlab = new Map<string, DiscoveredMarket>();
      const v17ProgramIdsSeen = new Map<string, PublicKey>();

      for (let i = 0; i < toCheck.length; i += 5) {
        if (stale()) return;
        const batch = toCheck.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map((m) => connection.getAccountInfo(m.slabAddress))
        );
        if (stale()) return;

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status !== "fulfilled" || !result.value) continue;

          const accountInfo = result.value;
          const data = new Uint8Array(accountInfo.data);
          const market = batch[j];
          try {
            if (isV17Account(data)) {
              // v17: portfolios are standalone program-owned accounts, NOT
              // embedded in the slab — parseAllAccounts finds nothing here.
              // Just remember the market + its owning program; the actual
              // portfolio lookup is the single batched scan below.
              v17MarketsBySlab.set(market.slabAddress.toBase58(), market);
              v17ProgramIdsSeen.set(accountInfo.owner.toBase58(), accountInfo.owner);
              // v17 has no embedded LP account to detect here — LP positions
              // are tracked via LP-token balances (see useLpPositions.ts), not
              // a slab-scanned role.
            } else {
              // v12.x legacy path: accounts embedded in the slab.
              let role: "trader" | "lp" | null = null;
              const accounts = parseAllAccounts(data);
              for (const { account } of accounts) {
                if (account.owner.toBase58() === walletStr) {
                  if (account.kind === AccountKind.User) { role = "trader"; break; }
                  if (account.kind === AccountKind.LP) { role = role ?? "lp"; }
                }
              }
              if (role) {
                found.push({
                  ...market,
                  label: await resolveLabel(market),
                  role,
                });
              }
            }
          } catch {
            // Skip unparseable slabs
          }
        }
      }

      if (stale()) return;

      // ── v17 owner-scan: ONE getProgramAccounts per distinct v17 program ──
      // Filtered by magic + owner@116 only (dropped the per-market
      // market@16 filter, same as usePortfolio.ts's identical fix) — the
      // owner filter alone already scopes results to just this wallet's
      // portfolios across every v17 market under that program, so the
      // (typically small) result set is grouped by `portfolio.marketGroupId`
      // client-side instead of re-querying per market.
      if (v17MarketsBySlab.size > 0) {
        try {
          const portfolioScans = await Promise.all(
            Array.from(v17ProgramIdsSeen.values()).map((programId) =>
              connection.getProgramAccounts(programId, {
                filters: [
                  { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_MM.toString("base64"), encoding: "base64" } },
                  { memcmp: { offset: V17_PF_OWNER_OFF_MM, bytes: walletStr } },
                ],
              }).catch(() => [] as Awaited<ReturnType<typeof connection.getProgramAccounts>>),
            ),
          );
          if (stale()) return;

          // Guards against pushing the same market twice if more than one
          // portfolio account somehow resolved to it (shouldn't happen in
          // practice — one portfolio per wallet+market — but keeps `found`
          // parity with the old one-push-per-market-per-scan behavior).
          const seenTraderSlabs = new Set<string>();
          for (const portfolioResults of portfolioScans) {
            for (const { account: portAcct } of portfolioResults) {
              try {
                const portData = portAcct.data instanceof Buffer ? portAcct.data : Buffer.from(portAcct.data);
                // Skip the market's LP portfolio — a market CREATOR owns the
                // LP (offset-116 owner == the creator's wallet), but that
                // must not mark them as a "trader" on their own market; the
                // creator's admin role is already detected separately above
                // via configV17.marketauth. See isLpPortfolio's doc comment.
                if (isLpPortfolio(portData)) continue;
                const portfolio = parsePortfolioV17(portData);
                // Defense-in-depth: re-verify the mutable owner actually matches
                // after fetch — memcmp filters are advisory server-side.
                if (portfolio.owner.toBase58() !== walletStr) continue;
                const slabAddrStr = portfolio.marketGroupId?.toBase58();
                if (!slabAddrStr || seenTraderSlabs.has(slabAddrStr)) continue;
                const market = v17MarketsBySlab.get(slabAddrStr);
                // Portfolio belongs to a v17 market outside this scan's
                // toCheck set (e.g. capped at 30, or an admin market already
                // covered by the other effect) — nothing to attach it to here.
                if (!market) continue;

                found.push({
                  ...market,
                  label: await resolveLabel(market),
                  role: "trader",
                });
                seenTraderSlabs.add(slabAddrStr);
              } catch {
                // Skip unparseable portfolio accounts
              }
            }
          }
        } catch {
          // v17 owner-scan is best-effort — a total failure here must not
          // discard the v12 trader/LP results already collected above.
        }
      }

      if (!stale()) {
        setTradedMarkets(found);
        setAccountsLoading(false);
        lastScannedKey.current = scanKey;
      }
    }

    checkAccounts();
  }, [publicKey, markets, discoveryLoading, connection, resolveLabel]);

  // Merge admin + traded markets (admin first)
  const myMarkets = useMemo(() => {
    const seen = new Set(adminMarkets.map((m) => m.slabAddress.toBase58()));
    const unique = [...adminMarkets];
    for (const m of tradedMarkets) {
      if (!seen.has(m.slabAddress.toBase58())) {
        unique.push(m);
        seen.add(m.slabAddress.toBase58());
      }
    }
    return unique;
  }, [adminMarkets, tradedMarkets]);

  // H11: enrich v17 markets with real OI/insurance/health data. Runs as a
  // separate pass (not folded into the admin/traded effects above) because it
  // needs a batched raw-bytes read + the current on-chain slot, and should not
  // block or re-trigger role discovery.
  //
  // Keyed on a stable joined-string of v17 slab addresses (not the `myMarkets`
  // array reference) so identical-content-but-new-reference renders (e.g. the
  // discovery SWR poll refreshing `markets` every 30s, or a manual "refresh"
  // click) don't spuriously reset the effect — and paired with its OWN
  // interval so the fetch itself still repeats periodically, keeping
  // OI/health/staleness live instead of freezing after the first successful
  // fetch (which an earlier "skip if same key" version of this effect did).
  const [v17Enrichment, setV17Enrichment] = useState<{
    currentSlot: bigint | null;
    stats: Record<string, { oi: V17MarketGroupOI; assetSlotLast: bigint | null }>;
  }>({ currentSlot: null, stats: {} });

  const v17SlabsKey = useMemo(
    () => myMarkets.filter((m) => m.configV17).map((m) => m.slabAddress.toBase58()).sort().join(","),
    [myMarkets],
  );

  useEffect(() => {
    if (!v17SlabsKey) {
      setV17Enrichment({ currentSlot: null, stats: {} });
      return;
    }
    const v17Slabs = v17SlabsKey.split(",").map((s) => new PublicKey(s));

    let cancelled = false;
    async function enrich() {
      try {
        const [slot, infos] = await Promise.all([
          connection.getSlot(),
          connection.getMultipleAccountsInfo(v17Slabs),
        ]);
        if (cancelled) return;
        const stats: Record<string, { oi: V17MarketGroupOI; assetSlotLast: bigint | null }> = {};
        infos.forEach((info, i) => {
          if (!info?.data) return;
          const bytes = new Uint8Array(info.data);
          if (!isV17MarketAccount(bytes)) return;
          try {
            stats[v17Slabs[i].toBase58()] = {
              oi: parseMarketGroupV17OI(bytes),
              assetSlotLast: readV17AssetSlotLast(bytes),
            };
          } catch {
            // Unparseable slab — this market keeps no v17Stats (page shows "—")
          }
        });
        if (!cancelled) setV17Enrichment({ currentSlot: BigInt(slot), stats });
      } catch {
        // RPC failure — degrade gracefully, keep prior enrichment (if any)
      }
    }

    enrich();
    const interval = setInterval(enrich, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [v17SlabsKey, connection]);

  const enrichedMarkets = useMemo(() => {
    if (Object.keys(v17Enrichment.stats).length === 0) return myMarkets;
    return myMarkets.map((m) => {
      const stats = v17Enrichment.stats[m.slabAddress.toBase58()];
      return stats ? { ...m, v17Stats: stats } : m;
    });
  }, [myMarkets, v17Enrichment]);

  return {
    myMarkets: enrichedMarkets,
    loading: discoveryLoading || accountsLoading,
    error,
    connected: !!publicKey,
    /** Trigger a fresh discovery fetch (bypasses SWR dedup window). */
    refetch: discoveryRefetch,
    /** Current on-chain slot from the v17 enrichment fetch — null until it resolves. */
    currentSlot: v17Enrichment.currentSlot,
  };
}
