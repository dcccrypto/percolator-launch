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
 * (#6); a failed read never blanks a good value; every phase is gated by its
 * flag so a flag-off build does no extra RPC at all.
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

const POLL_MS = 20_000;

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

export function useMarketLimits(slabAddress: string | null | undefined, assetIndex = 0): MarketLimits {
  const flags = useMemo(() => limitsFlags(), []);
  const anyOn = flags.p1 || flags.p2 || flags.p3;
  const { connection } = useConnectionCompat();
  const { raw, programId, assetProfile } = useSlabState();
  const programIdStr = programId?.toBase58() ?? null;

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

  // Slab-derived parts: pure, recomputed per slab poll.
  const slabPart = useMemo(() => {
    if (!anyOn || !raw) return null;
    const engine = decodeMarketEngineView(raw, assetIndex);
    const riskLimits = flags.p1 ? decodeAssetRiskLimits(raw, assetIndex) : null;
    const vaultLp = flags.p3 ? decodeAssetVaultLp(raw, assetIndex) : null;
    return { engine, riskLimits, vaultLp };
  }, [anyOn, raw, assetIndex, flags.p1, flags.p3]);

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
    const admin = assetProfile?.assetAdmin ? assetProfile.assetAdmin.toBytes() : null;
    // The creator (asset_admin) is close-only on-chain regardless of the limits flags
    // (SameOwnerTrade), so the OFF view still carries it for the ticket's same-owner gate.
    if (!anyOn) return { ...OFF(flags), assetAdmin: admin };
    const accPart = accts && accts.slab === slabAddress ? accts : null;
    let state: LimitsState = "loading";
    if (slabPart && accPart) state = accPart.error && !accPart.lp ? "error" : "ready";
    if (slabPart && flags.p1 && slabPart.riskLimits === null && raw) state = "error";
    return {
      state,
      flags,
      engine: slabPart?.engine ?? null,
      riskLimits: slabPart?.riskLimits ?? null,
      bandBps: slabPart?.riskLimits ? effectiveExecBandBps(slabPart.riskLimits.execBandBps) : null,
      vaultLp: slabPart?.vaultLp ?? null,
      lp: accPart?.lp ?? null,
      matcher: accPart?.matcher ?? null,
      lpRealQ:
        accPart?.lpBytes && slabPart?.engine
          ? lpEffectiveSignedQ(accPart.lpBytes, slabPart.engine, assetIndex, slabPart.engine.marketId)
          : null,
      matcherSyncLive: accPart?.matcherSyncLive ?? false,
      vaultState: accPart?.vaultState ?? null,
      registryShares: accPart?.registryShares ?? null,
      assetAdmin: admin,
    };
  }, [anyOn, flags, accts, slabAddress, slabPart, raw, assetProfile, assetIndex]);
}
