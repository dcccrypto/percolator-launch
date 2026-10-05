"use client";

/**
 * useMarketLimits — one read model for every P1/P2/P3 limits panel
 * (~/percolator-ops/ledger/frontend-limits-plan-2026-09-30.md §1, §1.5).
 *
 * Sources:
 *   - market slab bytes: SlabProvider `raw` (already polled; no extra RPC);
 *   - LP portfolio + matcher ctx (+ P3 vault state PDA): one getMultipleAccountsInfo
 *     per 20 s visible-tab poll, addresses cached 300 s (lib/limits/lp-discovery.ts).
 *     P3: when the asset has a bound vault LP, that key is the LP (no scan).
 *
 * Rules (v17 client gotchas): a request-id guard drops a stale market's reply
 * (#6); a failed read never blanks a good value; optional P1/P2/P3 reads remain
 * flag-gated. The trade ticket may opt into one additional canonical LP-owner
 * resolution after asset_admin is renounced because SameOwnerTrade is enforced
 * on-chain independently of those feature flags (#2976). That resolution runs
 * only for a CONNECTED wallet on a RENOUNCED market, is cached per market and
 * shared across mounts, and never blocks anything when the profile is unknown.
 */
import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { limitsFlags, type LimitsFlags } from "@/lib/limits/flags";
import {
  decodeAssetRiskLimits,
  decodeAssetVaultLp,
  decodeMarketEngineView,
  decodeMatcherCtx,
  decodePortfolioRisk,
  decodePortfolioLegs,
  type PortfolioLegView,
  decodeVaultLpState,
  decodeLpVaultRegistryShares,
  signedPositionForAsset,
  type AssetRiskLimits,
  type AssetVaultLp,
  type MarketEngineView,
  type MatcherCtxView,
  type PortfolioRiskView,
  type VaultLpStateView,
} from "@/lib/limits/decode";
import { deriveVaultLpStatePda, resolveLpAccounts } from "@/lib/limits/lp-discovery";
import { LP_VAULT_REGISTRY_SEED, VAULT_LP_STATE_SEED } from "@/lib/limits/constants";
import { effectiveExecBandBps } from "@/lib/limits/risk-limits";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { matcherLpSyncLive } from "@/lib/program-upgrade-detect";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { resolveMarketLp } from "@/lib/market-lp";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import { growthMarketView, type GrowthMarketView } from "@/lib/v21/growth-market";

const POLL_MS = 20_000;
/** Background retries after a failed same-owner LP resolution (never blocking). */
const SAME_OWNER_RETRY_MS = [2_000, 8_000, 30_000] as const;
/**
 * Upper bound on the open-blocking window while the first resolution is in flight.
 * After it, opens fail OPEN: the wrapper refuses SameOwnerTrade (Custom 67) on-chain
 * and useTrade's pre-sign simulation catches it, so no funds are at risk.
 */
const SAME_OWNER_PENDING_CAP_MS = 8_000;
/**
 * A resolved LP owner is cached per (program, market). The provenance owner is NOT
 * immutable: TransferPortfolioOwnership (tag 72, NFT CPI) rewrites p.owner and
 * p.provenance_header.owner (wrapper 553d76f0 v16_program.rs:30414-30415), so the
 * cache expires instead of living for the session.
 */
const SAME_OWNER_CACHE_TTL_MS = 5 * 60_000;

const sameOwnerCache = new Map<string, { owner: Uint8Array; at: number }>();
const sameOwnerInflight = new Map<string, Promise<Uint8Array | null>>();

/** Test hook: forget every cached / in-flight same-owner resolution. */
export function __resetSameOwnerLpCache(): void {
  sameOwnerCache.clear();
  sameOwnerInflight.clear();
}

function cachedSameOwner(key: string): Uint8Array | null {
  const hit = sameOwnerCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SAME_OWNER_CACHE_TTL_MS) {
    sameOwnerCache.delete(key);
    return null;
  }
  return hit.owner;
}

/** One shared resolution per market: concurrent mounts await the same promise. */
function resolveSameOwnerOnce(
  key: string,
  run: () => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const existing = sameOwnerInflight.get(key);
  if (existing) return existing;
  const p = run()
    .then((owner) => {
      if (owner) sameOwnerCache.set(key, { owner, at: Date.now() });
      return owner;
    })
    .finally(() => sameOwnerInflight.delete(key));
  sameOwnerInflight.set(key, p);
  return p;
}

export type LimitsState = "off" | "loading" | "ready" | "error";

export interface LpView extends PortfolioRiskView {
  address: PublicKey;
  posQ: bigint;
  /** Active legs (raw basis), for the Earn worse-of pricing bounds (lib/limits/earn-pricing.ts). */
  legs?: PortfolioLegView[];
}

export interface MarketLimits {
  state: LimitsState;
  flags: LimitsFlags;
  engine: MarketEngineView | null;
  /** P1 record; null = unreadable (refused bytes) or P1 off. */
  riskLimits: AssetRiskLimits | null;
  bandBps: number | null;
  /** P3 record (null = P3 off or unreadable). */
  vaultLp: AssetVaultLp | null;
  lp: LpView | null;
  matcher: MatcherCtxView | null;
  /**
   * The LP's REAL ADL-effective position on this asset (null = unread / InvalidLeg). The matcher
   * ctx `inventoryBase` counter drifts on liquidation / ADL / reset (2026-10-03).
   */
  lpRealQ: bigint | null;
  /** Upgraded wrapper + matcher live for this LP: the matcher prices from `lpRealQ`. */
  matcherSyncLive: boolean;
  vaultState: VaultLpStateView | null;
  /** P3: registry `total_lp_shares_outstanding` (the program's share count); null = unread. */
  registryShares: bigint | null;
  assetAdmin: Uint8Array | null;
  /**
   * Canonical matcher-LP provenance owner used by the unconditional
   * SameOwnerTrade gate when the optional limits phases are OFF.
   */
  sameOwnerLpOwner?: Uint8Array | null;
  /**
   * True only while the FIRST same-owner resolution for a connected wallet on a
   * renounced market is in flight (capped at SAME_OWNER_PENDING_CAP_MS). The ticket
   * holds OPENS (never closes) for that window. False for an unknown profile
   * (mock mode, legacy slab, initial load), for a non-renounced market and with
   * no wallet connected.
   */
  sameOwnerPending?: boolean;
  /**
   * Informational: resolution failed and is retrying in the background. Never
   * blocks: the on-chain rule and the pre-sign simulation still refuse an open.
   */
  sameOwnerUnresolved?: boolean;
  /**
   * Devnet v2.1: the asset's growth-v19 view. null on every market of today's programs (the
   * record reads all-zero) and whenever the v2.1 flag is off.
   */
  growth?: GrowthMarketView | null;
}

const OFF = (flags: LimitsFlags): MarketLimits => ({
  state: "off",
  flags,
  engine: null,
  riskLimits: null,
  bandBps: null,
  vaultLp: null,
  lp: null,
  matcher: null,
  lpRealQ: null,
  matcherSyncLive: false,
  vaultState: null,
  registryShares: null,
  assetAdmin: null,
});

/** Devnet v2.1: the growth view from what is already read; null when growth is OFF for the asset. */
function growthFor(
  slabPart: { engine: MarketEngineView | null; vaultLp: AssetVaultLp | null } | null,
  accPart: { lp: LpView | null } | null,
  lpRealQ: bigint | null,
  raw: Uint8Array | null,
  assetIndex: number,
): GrowthMarketView | null {
  const engine = slabPart?.engine;
  const lp = accPart?.lp;
  if (!engine || !lp || !raw) return null;
  const vault = slabPart?.vaultLp;
  const lpKey = lp.address.toBytes();
  const bound =
    !!vault?.bound && vault.vaultLpPortfolio.length === lpKey.length && lpKey.every((b, k) => b === vault.vaultLpPortfolio[k]);
  return growthMarketView({
    raw,
    assetIndex,
    engine,
    lp: { capital: lp.capital, pnl: lp.pnl, feeCredits: lp.feeCredits },
    lpEffectiveQ: lpRealQ,
    bound,
  });
}

/**
 * @param sameOwnerWallet  trade ticket only: the connected wallet (base58), or null.
 *   When set and the market's asset_admin is renounced, the canonical matcher LP owner
 *   is resolved (cached) so the post-burn creator stays close-only (#2976). Omitted /
 *   null: no extra RPC at all.
 */
export function useMarketLimits(
  slabAddress: string | null | undefined,
  assetIndex = 0,
  sameOwnerWallet: string | null = null,
): MarketLimits {
  const resolveSameOwnerLp = !!sameOwnerWallet;
  const flags = useMemo(() => limitsFlags(), []);
  const v21 = isDevnetV21Enabled();
  const anyOn = flags.p1 || flags.p2 || flags.p3 || v21;
  const { connection } = useConnectionCompat();
  const { raw, programId, assetProfile } = useSlabState();
  const programIdStr = programId?.toBase58() ?? null;
  const assetAdminObj = assetProfile?.assetAdmin ?? null;
  const assetAdminBytes = useMemo(
    () => (assetAdminObj ? assetAdminObj.toBytes() : null),
    [assetAdminObj],
  );
  // Unknown profile (null) is NOT "renounced": nothing is resolved and nothing blocks.
  const assetAdminRenounced =
    assetAdminBytes !== null && assetAdminBytes.every((x) => x === 0);

  const [accts, setAccts] = useState<{
    slab: string;
    lp: LpView | null;
    lpBytes: Uint8Array | null;
    matcher: MatcherCtxView | null;
    matcherSyncLive: boolean;
    vaultState: VaultLpStateView | null;
    registryShares: bigint | null;
    error: boolean;
  } | null>(null);

  // SameOwnerTrade is unconditional on-chain (wrapper 553d76f0 v16_program.rs:31882-31906:
  // `owners_equal` needs no asset_admin). Burn Admin Key removes asset_admin as an identity
  // but the creator still owns the matcher LP, so it stays close-only. Resolve that owner
  // only for a connected wallet on a renounced market, cached per market.
  const sameOwnerKey =
    resolveSameOwnerLp && assetAdminRenounced && slabAddress && programIdStr
      ? `${programIdStr}:${slabAddress}`
      : null;
  const [sameOwnerLp, setSameOwnerLp] = useState<{ key: string; owner: Uint8Array } | null>(null);
  /** key whose first attempt has settled (or hit the pending cap). */
  const [sameOwnerSettled, setSameOwnerSettled] = useState<string | null>(null);
  const [sameOwnerFailed, setSameOwnerFailed] = useState<string | null>(null);

  useEffect(() => {
    if (anyOn || !sameOwnerKey || !slabAddress || !programIdStr) return;
    const key = sameOwnerKey;
    const cached = cachedSameOwner(key);
    if (cached) {
      setSameOwnerLp({ key, owner: cached });
      setSameOwnerSettled(key);
      setSameOwnerFailed(null);
      return;
    }

    let slabPk: PublicKey;
    let programPk: PublicKey;
    try {
      slabPk = new PublicKey(slabAddress);
      programPk = new PublicKey(programIdStr);
    } catch {
      setSameOwnerSettled(key);
      return;
    }

    let alive = true;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Fail open after the cap even if the first attempt is still hanging.
    const capTimer = setTimeout(() => {
      if (alive) setSameOwnerSettled(key);
    }, SAME_OWNER_PENDING_CAP_MS);

    const run = async () => {
      let owner: Uint8Array | null = null;
      try {
        owner = await resolveSameOwnerOnce(key, async () => {
          const pinnedAddress = PLAYGROUND_SLAB_META[slabAddress]?.lp_portfolio_address ?? null;
          const pinned = pinnedAddress ? new PublicKey(pinnedAddress) : null;
          const lp = await resolveMarketLp(connection, programPk, slabPk, pinned);
          return lp ? lp.owner.toBytes() : null;
        });
      } catch {
        owner = null;
      }
      if (!alive) return;
      setSameOwnerSettled(key);
      if (owner) {
        setSameOwnerLp({ key, owner });
        setSameOwnerFailed(null);
        return;
      }
      setSameOwnerFailed(key);
      if (attempt < SAME_OWNER_RETRY_MS.length) {
        retryTimer = setTimeout(() => void run(), SAME_OWNER_RETRY_MS[attempt++]);
      }
    };
    void run();

    return () => {
      alive = false;
      clearTimeout(capTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [anyOn, sameOwnerKey, slabAddress, programIdStr, connection]);

  // Slab-derived parts: pure, recomputed per slab poll.
  const slabPart = useMemo(() => {
    if (!anyOn || !raw) return null;
    const engine = decodeMarketEngineView(raw, assetIndex);
    const riskLimits = flags.p1 ? decodeAssetRiskLimits(raw, assetIndex) : null;
    const vaultLp = flags.p3 || v21 ? decodeAssetVaultLp(raw, assetIndex) : null;
    return { engine, riskLimits, vaultLp };
  }, [anyOn, raw, assetIndex, flags.p1, flags.p3, v21]);

  const boundVaultLpKey = slabPart?.vaultLp?.bound ? new PublicKey(slabPart.vaultLp.vaultLpPortfolio).toBase58() : null;
  const marketId = slabPart?.engine?.marketId ?? null;

  useEffect(() => {
    setAccts(null);
    if (!anyOn || !slabAddress || !programIdStr) return;
    let slabPk: PublicKey;
    let programPk: PublicKey;
    try {
      slabPk = new PublicKey(slabAddress);
      programPk = new PublicKey(programIdStr);
    } catch {
      return;
    }
    // Per-effect liveness flag (gotcha #6): a reply from a previous market/effect is dropped.
    let alive = true;
    let fetching = false;
    const tick = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const known = boundVaultLpKey ? new PublicKey(boundVaultLpKey) : null;
        // E2E B17: LP discovery (a program scan when the LP is not known) can fail on a public
        // RPC; that must not hide the P3 vault state / registry reads the tranche card needs.
        const lpAccts = await resolveLpAccounts(connection, programPk, slabPk, known).catch(() => null);
        const keys: PublicKey[] = [];
        if (lpAccts) keys.push(lpAccts.lpPortfolio);
        if (lpAccts?.matcherCtx) keys.push(lpAccts.matcherCtx);
        const vaultPda = flags.p3 ? deriveVaultLpStatePda(programPk, slabPk, VAULT_LP_STATE_SEED) : null;
        if (vaultPda) keys.push(vaultPda);
        const registryPda = flags.p3 ? deriveVaultLpStatePda(programPk, slabPk, LP_VAULT_REGISTRY_SEED) : null;
        if (registryPda) keys.push(registryPda);
        const infos = keys.length ? await connection.getMultipleAccountsInfo(keys, "confirmed") : [];
        if (!alive) return; // market switched while in flight
        let k = 0;
        const lpInfo = lpAccts ? infos[k++] : null;
        const ctxInfo = lpAccts?.matcherCtx ? infos[k++] : null;
        const vaultInfo = vaultPda ? infos[k++] : null;
        const registryInfo = registryPda ? infos[k++] : null;
        let lp: LpView | null = null;
        let lpBytes: Uint8Array | null = null;
        if (lpAccts && lpInfo) {
          const d = new Uint8Array(lpInfo.data);
          lpBytes = d;
          const r = decodePortfolioRisk(d);
          if (r) lp = { ...r, address: lpAccts.lpPortfolio, posQ: marketId === null ? 0n : signedPositionForAsset(d, assetIndex, marketId), legs: decodePortfolioLegs(d) };
        }
        const matcher = ctxInfo ? decodeMatcherCtx(new Uint8Array(ctxInfo.data)) : null;
        // The ctx is owned by the LP's matcher program; unknown / failed detection = not live.
        const matcherSyncLive = ctxInfo ? await matcherLpSyncLive(connection, programPk, ctxInfo.owner).catch(() => false) : false;
        if (!alive) return;
        const vaultState = vaultInfo ? decodeVaultLpState(new Uint8Array(vaultInfo.data)) : null;
        const registryShares = registryInfo ? decodeLpVaultRegistryShares(new Uint8Array(registryInfo.data)) : null;
        setAccts((prev) => ({
          slab: slabAddress,
          // never blank a good value on a failed/empty read
          lp: lp ?? (prev?.slab === slabAddress ? prev.lp : null),
          lpBytes: lpBytes ?? (prev?.slab === slabAddress ? prev.lpBytes : null),
          matcher: matcher ?? (prev?.slab === slabAddress ? prev.matcher : null),
          matcherSyncLive: ctxInfo ? matcherSyncLive : prev?.slab === slabAddress ? prev.matcherSyncLive : false,
          vaultState: vaultState ?? (prev?.slab === slabAddress ? prev.vaultState : null),
          registryShares: registryShares ?? (prev?.slab === slabAddress ? prev.registryShares : null),
          error: false,
        }));
      } catch {
        if (alive) {
          setAccts((prev) => (prev && prev.slab === slabAddress ? { ...prev, error: true } : { slab: slabAddress, lp: null, lpBytes: null, matcher: null, matcherSyncLive: false, vaultState: null, registryShares: null, error: true }));
        }
      } finally {
        fetching = false;
      }
    };
    void tick();
    const dispose = pollWhenVisible(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      dispose();
    };
  }, [anyOn, slabAddress, programIdStr, connection, boundVaultLpKey, marketId, assetIndex, flags.p3]);

  return useMemo((): MarketLimits => {
    const admin = assetAdminBytes;
    // SameOwnerTrade is unconditional even when P1/P2/P3 are disabled.
    // After admin burn, use the canonical matcher-LP provenance owner.
    if (!anyOn) {
      // A cached owner applies on the first render of a remount (no pending flash, no RPC).
      const owner = sameOwnerKey
        ? (sameOwnerLp?.key === sameOwnerKey ? sameOwnerLp.owner : null) ?? cachedSameOwner(sameOwnerKey)
        : null;
      return {
        ...OFF(flags),
        assetAdmin: admin,
        sameOwnerLpOwner: owner,
        sameOwnerPending: !!sameOwnerKey && !owner && sameOwnerSettled !== sameOwnerKey,
        sameOwnerUnresolved: !!sameOwnerKey && !owner && sameOwnerFailed === sameOwnerKey,
      };
    }

    const accPart = accts && accts.slab === slabAddress ? accts : null;
    let state: LimitsState = "loading";
    if (slabPart && accPart) state = accPart.error && !accPart.lp ? "error" : "ready";
    if (slabPart && flags.p1 && slabPart.riskLimits === null && raw) state = "error";
    const lpRealQ =
      accPart?.lpBytes && slabPart?.engine
        ? lpEffectiveSignedQ(accPart.lpBytes, slabPart.engine, assetIndex, slabPart.engine.marketId)
        : null;
    return {
      state,
      flags,
      engine: slabPart?.engine ?? null,
      riskLimits: slabPart?.riskLimits ?? null,
      bandBps: slabPart?.riskLimits ? effectiveExecBandBps(slabPart.riskLimits.execBandBps) : null,
      vaultLp: slabPart?.vaultLp ?? null,
      lp: accPart?.lp ?? null,
      matcher: accPart?.matcher ?? null,
      lpRealQ,
      matcherSyncLive: accPart?.matcherSyncLive ?? false,
      vaultState: accPart?.vaultState ?? null,
      registryShares: accPart?.registryShares ?? null,
      assetAdmin: admin,
      sameOwnerLpOwner: null,
      sameOwnerPending: false,
      sameOwnerUnresolved: false,
      growth: v21 ? growthFor(slabPart, accPart, lpRealQ, raw, assetIndex) : null,
    };
  }, [
    v21,
    anyOn,
    flags,
    accts,
    slabAddress,
    slabPart,
    raw,
    assetAdminBytes,
    sameOwnerKey,
    sameOwnerLp,
    sameOwnerSettled,
    sameOwnerFailed,
    assetIndex,
  ]);
}
