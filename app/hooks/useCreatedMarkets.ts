"use client";

import { useMemo, useEffect, useState, useRef, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useMarketDiscovery } from "./useMarketDiscovery";
import {
  isV17MarketAccount,
  parseMarketGroupV17OI,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  type DiscoveredMarket,
  type V17MarketGroupOI,
} from "@percolatorct/sdk";
import { fetchTokenMeta } from "@/lib/tokenMeta";
import { isLpPortfolio } from "@/lib/userAccountScan";

/** v17 portfolio account magic (PERCV16\0), base64 for the memcmp filter. */
const V17_PORTFOLIO_MAGIC_B64 = Buffer.from([
  0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50,
]).toString("base64");
/** market_group_id — the slab a portfolio belongs to. */
const V17_PF_MARKET_OFF = 16;
/** Mutable owner (SDK PF_OWNER_OFF) — NOT provenance@80. */
const V17_PF_OWNER_OFF = 116;

/**
 * /my-markets creator dashboard — "markets you CREATED" only.
 *
 * This is a deliberately trimmed extraction of the old hooks/useMyMarkets.ts
 * (now deleted — it had exactly one consumer, this page). That hook did TWO
 * passes: (1) a cheap admin-detection filter over discovery's header-only
 * data, and (2) an expensive second pass that fetched every non-admin
 * market's full slab + ran a getProgramAccounts owner-scan to find markets
 * where the wallet merely TRADED or LP'd. The creator dashboard has no use
 * for pass (2) — "lp" is a strict subset of "admin" for a market's own
 * creator (the LP portfolio is owned by the creator's wallet by
 * construction — see lib/userAccountScan.ts's isLpPortfolio doc comment),
 * and "trader" positions across ALL markets are already covered by
 * /portfolio. Dropping it removes the single biggest RPC/perf cost on this
 * page (a getAccountInfo batch + a getProgramAccounts scan over every market
 * the wallet didn't create) with zero loss of the "your markets" feature.
 *
 * What's kept, verbatim in spirit:
 *  - The admin-detection effect (was useMyMarkets.ts:113-140).
 *  - The H11 v17 enrichment effect (was useMyMarkets.ts:367-435) — real
 *    OI/insurance from parseMarketGroupV17OI, plus the asset's accrue slot
 *    for real health/staleness. See that block's comments below for the full
 *    byte-offset derivation; unchanged from the original.
 */

// v17 market group accounts carry no v12 config — the asset's accrue slot
// (slot_last) has no SDK parser yet, so it's read directly off raw bytes.
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

export interface CreatedMarket extends DiscoveredMarket {
  /** Formatted label for display (token symbol or truncated address) — best
   *  effort from on-chain token metadata; the page prefers the richer
   *  symbol/name from the per-market API detail fetch once that resolves. */
  label: string;
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
 * Returns markets where the connected wallet is the ADMIN (creator) — see
 * this file's top comment for why trader/LP roles were dropped from this
 * hook. Every market returned here is one the wallet can administer.
 */
export function useCreatedMarkets() {
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

  const [createdMarkets, setCreatedMarkets] = useState<CreatedMarket[]>([]);

  useEffect(() => {
    if (!publicKey || !markets.length) {
      // Bail out instead of unconditionally calling setCreatedMarkets([]) —
      // a brand-new empty-array reference still fails React's Object.is
      // state-update check even when the value is semantically unchanged,
      // which forces an extra render every time this effect's OTHER deps
      // (e.g. `resolveLabel`, if a caller's connection reference happens to
      // be unstable) merely re-fire without publicKey/markets changing.
      setCreatedMarkets((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    const walletStr = publicKey.toBase58();

    // ── Which markets did THIS wallet create? ────────────────────────────
    //
    // NOT "marketauth == my wallet". A completed launch's LAST step
    // (StakeInitPool) irreversibly ROTATES marketauth to a stake-pool PDA —
    // verified on-chain against this playground's own wizard-launched markets
    // (e.g. dui5i3MN… → marketauth ByFxYX3a…, a PDA, not the creator). So the
    // authority check is FALSE for every fully-launched market, and a creator
    // saw "you haven't created a market with this wallet yet" while looking at
    // markets they had just launched. (The old useMyMarkets had the same
    // defect; its trader/LP roles merely masked it.)
    //
    // The durable creator marker is the market's LP PORTFOLIO — the AMM
    // counterparty holding the seeded liquidity, created by the wizard via
    // InitUser with the CREATOR's wallet as its owner, and never rotated. One
    // getProgramAccounts scan (magic + owner@116 == wallet, no market filter)
    // returns every portfolio this wallet owns across all markets; the ones
    // that are LP portfolios (isLpPortfolio — trailing matcher config enabled,
    // the same discriminator that keeps them OUT of trading-account lookups)
    // identify the markets it created. Their market_group_id@16 is the slab.
    //
    // Unioned with the authority check so INCOMPLETE launches (stake-pool step
    // never ran, marketauth still the wallet) also appear — exactly the markets
    // a creator most needs to see and finish.
    const run = async () => {
      const createdSlabs = new Set<string>(
        markets
          .filter((m) => (m.configV17?.marketauth ?? m.header?.admin)?.toBase58() === walletStr)
          .map((m) => m.slabAddress.toBase58()),
      );

      const programIds = Array.from(
        new Set(markets.map((m) => m.programId?.toBase58()).filter((p): p is string => !!p)),
      );
      await Promise.all(
        programIds.map(async (pid) => {
          try {
            const owned = await connection.getProgramAccounts(new PublicKey(pid), {
              filters: [
                { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_B64, encoding: "base64" } },
                { memcmp: { offset: V17_PF_OWNER_OFF, bytes: walletStr } },
              ],
            });
            for (const { account } of owned) {
              if (!isLpPortfolio(account.data)) continue; // a trading portfolio, not a market I created
              const data =
                account.data instanceof Buffer ? account.data : Buffer.from(account.data);
              // market_group_id — the slab this LP portfolio backs.
              createdSlabs.add(
                new PublicKey(data.subarray(V17_PF_MARKET_OFF, V17_PF_MARKET_OFF + 32)).toBase58(),
              );
            }
          } catch {
            /* transient RPC failure — the authority-derived set above still stands */
          }
        }),
      );

      if (cancelled) return;
      const mine = markets.filter((m) => createdSlabs.has(m.slabAddress.toBase58()));
      const results = await Promise.all(mine.map(async (m) => ({ ...m, label: await resolveLabel(m) })));
      if (!cancelled) setCreatedMarkets(results);
    };
    void run();

    return () => { cancelled = true; };
  }, [publicKey, markets, resolveLabel, connection]);

  // H11: enrich v17 markets with real OI/insurance/health data. Runs as a
  // separate pass (not folded into the admin effect above) because it needs a
  // batched raw-bytes read + the current on-chain slot, and should not block
  // or re-trigger role discovery.
  //
  // Keyed on a stable joined-string of v17 slab addresses (not the
  // `createdMarkets` array reference) so identical-content-but-new-reference
  // renders (e.g. the discovery SWR poll refreshing `markets` every 30s, or a
  // manual "refresh" click) don't spuriously reset the effect — and paired
  // with its OWN interval so the fetch itself still repeats periodically,
  // keeping OI/health/staleness live instead of freezing after the first
  // successful fetch.
  const [v17Enrichment, setV17Enrichment] = useState<{
    currentSlot: bigint | null;
    stats: Record<string, { oi: V17MarketGroupOI; assetSlotLast: bigint | null }>;
  }>({ currentSlot: null, stats: {} });

  const v17SlabsKey = useMemo(
    () => createdMarkets.filter((m) => m.configV17).map((m) => m.slabAddress.toBase58()).sort().join(","),
    [createdMarkets],
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
    if (Object.keys(v17Enrichment.stats).length === 0) return createdMarkets;
    return createdMarkets.map((m) => {
      const stats = v17Enrichment.stats[m.slabAddress.toBase58()];
      return stats ? { ...m, v17Stats: stats } : m;
    });
  }, [createdMarkets, v17Enrichment]);

  return {
    myMarkets: enrichedMarkets,
    // No second RPC pass here, so loading is purely discovery + the cheap
    // admin-detection resolveLabel() promise — never gated on the (removed)
    // trader/LP owner-scan.
    loading: discoveryLoading,
    error,
    connected: !!publicKey,
    /** Trigger a fresh discovery fetch (bypasses SWR dedup window). */
    refetch: discoveryRefetch,
    /** Current on-chain slot from the v17 enrichment fetch — null until it resolves. */
    currentSlot: v17Enrichment.currentSlot,
  };
}
