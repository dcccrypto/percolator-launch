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
 * /my-markets creator dashboard — markets created by the connected wallet.
 *
 * Incomplete launches are identified through their remaining wallet
 * authority. Completed launches rotate marketauth to a stake-pool PDA, so
 * creator-owned LP portfolios are used as the durable creator marker.
 * Trading portfolios remain excluded.
 *
 * Creator verification is wallet-scoped and participates in loading/error
 * state so pending or failed scans are never rendered as confirmed-empty.
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
 * Returns markets created by the connected wallet.
 *
 * Incomplete launches are matched through their remaining wallet authority.
 * Completed launches are recovered through creator-owned LP portfolios
 * after marketauth rotates. Trading portfolios remain excluded.
 */
export function useCreatedMarkets() {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { markets, loading: discoveryLoading, error: discoveryError, refetch: discoveryRefetch } = useMarketDiscovery();

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

  type CreatorScanState = {
    key: string | null;
    status: 'idle' | 'loading' | 'success' | 'error';
    slabAddresses: string[];
    labels: Record<string, string>;
    error: string | null;
  };

  const [creatorScanState, setCreatorScanState] = useState<CreatorScanState>({
    key: null,
    status: 'idle',
    slabAddresses: [],
    labels: {},
    error: null,
  });
  const [creatorScanGeneration, setCreatorScanGeneration] = useState(0);

  const walletStr = publicKey?.toBase58() ?? null;

  // Keep the latest discovery objects without making the ownership
  // RPC scan depend on the markets array reference itself.
  // creatorScanKey remains the content-derived execution identity.
  const creatorScanMarketsRef = useRef(markets);

  useEffect(() => {
    creatorScanMarketsRef.current = markets;
  }, [markets]);

  // Use content-derived identities so same-content SWR array replacements do
  // not invalidate verified creator results. Authority and collateral mint are
  // included because either can change while a slab address remains stable.
  const creatorProgramIdsKey = useMemo(
    () =>
      Array.from(
        new Set(
          markets
            .map((market) => market.programId?.toBase58())
            .filter((programId): programId is string => !!programId),
        ),
      )
        .sort()
        .join(','),
    [markets],
  );

  const creatorMarketSetKey = useMemo(
    () =>
      markets
        .map((market) => {
          const slab = market.slabAddress.toBase58();
          const programId = market.programId?.toBase58() ?? '';
          const authority =
            (market.configV17?.marketauth ?? market.header?.admin)?.toBase58() ?? '';
          const collateralMint = market.config?.collateralMint?.toBase58() ?? '';
          return [slab, programId, authority, collateralMint].join(':');
        })
        .sort()
        .join('|'),
    [markets],
  );

  const creatorScanKey =
    walletStr && markets.length > 0
      ? [walletStr, creatorProgramIdsKey, creatorMarketSetKey, String(creatorScanGeneration)].join(
          '::',
        )
      : null;

  const refetch = useCallback(() => {
    // Changing the generation invalidates the verified scan immediately,
    // before the next effect executes, so stale results cannot remain visible.
    setCreatorScanGeneration((generation) => generation + 1);
    return discoveryRefetch();
  }, [discoveryRefetch]);

  useEffect(() => {
    if (!creatorScanKey || !walletStr) {
      setCreatorScanState((previous) => {
        if (
          previous.key === null &&
          previous.status === 'idle' &&
          previous.slabAddresses.length === 0 &&
          previous.error === null
        ) {
          return previous;
        }

        return {
          key: null,
          status: 'idle',
          slabAddresses: [],
          labels: {},
          error: null,
        };
      });
      return;
    }

    const scanKey = creatorScanKey;
    const scanMarkets = creatorScanMarketsRef.current;
    const programIds = creatorProgramIdsKey ? creatorProgramIdsKey.split(',') : [];
    let cancelled = false;

    setCreatorScanState((previous) => {
      // A same-key background revalidation may retain its last verified
      // snapshot. A wallet, market-set, program-set, or manual-refresh change
      // always has a new key and is withheld immediately by render-time gating.
      if (previous.key === scanKey && previous.status === 'success') {
        return previous;
      }

      return {
        key: scanKey,
        status: 'loading',
        slabAddresses: [],
        labels: {},
        error: null,
      };
    });

    const run = async () => {
      try {
        // Keep incomplete launches whose authority has not yet been rotated.
        const createdSlabs = new Set<string>(
          scanMarkets
            .filter(
              (market) =>
                (market.configV17?.marketauth ?? market.header?.admin)?.toBase58() === walletStr,
            )
            .map((market) => market.slabAddress.toBase58()),
        );

        // Every configured program scan is required for a verified result.
        // Promise.all intentionally rejects the scan if any RPC request fails,
        // preventing a partial result from being presented as confirmed empty.
        const ownedByProgram = await Promise.all(
          programIds.map((programId) =>
            connection.getProgramAccounts(new PublicKey(programId), {
              filters: [
                {
                  memcmp: {
                    offset: 0,
                    bytes: V17_PORTFOLIO_MAGIC_B64,
                    encoding: 'base64',
                  },
                },
                {
                  memcmp: {
                    offset: V17_PF_OWNER_OFF,
                    bytes: walletStr,
                  },
                },
              ],
            }),
          ),
        );

        if (cancelled) return;

        for (const owned of ownedByProgram) {
          for (const { account } of owned) {
            if (!isLpPortfolio(account.data)) continue;

            try {
              const data =
                account.data instanceof Buffer ? account.data : Buffer.from(account.data);

              if (data.length < V17_PF_MARKET_OFF + 32) continue;

              createdSlabs.add(
                new PublicKey(data.subarray(V17_PF_MARKET_OFF, V17_PF_MARKET_OFF + 32)).toBase58(),
              );
            } catch {
              // Ignore an individually malformed account without converting a
              // successful RPC request into a false creator match.
            }
          }
        }

        const mine = scanMarkets.filter((market) =>
          createdSlabs.has(market.slabAddress.toBase58()),
        );

        const labelEntries = await Promise.all(
          mine.map(async (market) => {
            const slab = market.slabAddress.toBase58();
            return [slab, await resolveLabel(market)] as const;
          }),
        );

        if (cancelled) return;

        setCreatorScanState({
          key: scanKey,
          status: 'success',
          slabAddresses: mine.map((market) => market.slabAddress.toBase58()),
          labels: Object.fromEntries(labelEntries),
          error: null,
        });
      } catch (cause) {
        if (cancelled) return;

        const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';

        setCreatorScanState({
          key: scanKey,
          status: 'error',
          slabAddresses: [],
          labels: {},
          error: `Unable to verify created markets${detail}`,
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [creatorScanKey, creatorProgramIdsKey, walletStr, resolveLabel, connection]);

  const creatorScanMatchesCurrentKey =
    creatorScanKey !== null && creatorScanState.key === creatorScanKey;

  const verifiedCreatorScan =
    creatorScanMatchesCurrentKey && creatorScanState.status === 'success' ? creatorScanState : null;

  // Always merge verified slab identities with the latest discovery objects.
  // This avoids retaining stale market snapshots when discovery refreshes.
  const createdMarkets = useMemo<CreatedMarket[]>(() => {
    if (!verifiedCreatorScan) return [];

    const verifiedSlabs = new Set(verifiedCreatorScan.slabAddresses);

    return markets
      .filter((market) => verifiedSlabs.has(market.slabAddress.toBase58()))
      .map((market) => {
        const slab = market.slabAddress.toBase58();
        return {
          ...market,
          label: verifiedCreatorScan.labels[slab] ?? slab.slice(0, 8) + '…',
        };
      });
  }, [markets, verifiedCreatorScan]);

  const creatorScanLoading =
    creatorScanKey !== null &&
    (!creatorScanMatchesCurrentKey ||
      creatorScanState.status === 'idle' ||
      creatorScanState.status === 'loading');

  const creatorScanError =
    creatorScanMatchesCurrentKey && creatorScanState.status === 'error'
      ? creatorScanState.error
      : null;

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
    loading: discoveryLoading || creatorScanLoading,
    error: discoveryError ?? creatorScanError,
    connected: !!publicKey,
    /** Refresh market discovery and wallet-scoped creator ownership. */
    refetch,
    /** Current on-chain slot from the v17 enrichment fetch — null until it resolves. */
    currentSlot: v17Enrichment.currentSlot,
  };
}
