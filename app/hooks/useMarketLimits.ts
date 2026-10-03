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
 * on-chain independently of those feature flags.
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
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { resolveMarketLp } from "@/lib/market-lp";

const POLL_MS = 20_000;
const SAME_OWNER_RETRY_MS = [2_000, 8_000, 30_000] as const;

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
   * True while that canonical identity is still unresolved.
   * The trade ticket must fail closed during this window.
   */
  sameOwnerPending?: boolean;
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
  vaultState: null,
  registryShares: null,
  assetAdmin: null,
});

export function useMarketLimits(
  slabAddress: string | null | undefined,
  assetIndex = 0,
  resolveSameOwnerLp = false,
): MarketLimits {
  const flags = useMemo(() => limitsFlags(), []);
  const anyOn = flags.p1 || flags.p2 || flags.p3;
  const { connection } = useConnectionCompat();
  const { raw, programId, assetProfile } = useSlabState();
  const programIdStr = programId?.toBase58() ?? null;
  const assetAdminBytes = assetProfile?.assetAdmin
    ? assetProfile.assetAdmin.toBytes()
    : null;
  const assetAdminKnown = assetAdminBytes !== null;
  const assetAdminRenounced =
    assetAdminKnown &&
    assetAdminBytes.every((x) => x === 0);

  const [accts, setAccts] = useState<{
    slab: string;
    lp: LpView | null;
    matcher: MatcherCtxView | null;
    vaultState: VaultLpStateView | null;
    registryShares: bigint | null;
    error: boolean;
  } | null>(null);

  // SameOwnerTrade is unconditional on-chain. Burn Admin Key removes
  // asset_admin as an identity, but it does not remove the immutable
  // provenance owner of the market's matcher LP.
  //
  // Resolve that identity only for the trade ticket. A successful owner is
  // immutable for this market, so polling it every 20 s would only repeat an
  // expensive portfolio scan. Transient failures get a bounded retry.
  const [sameOwnerLp, setSameOwnerLp] = useState<{
    slab: string;
    owner: Uint8Array;
  } | null>(null);

  useEffect(() => {
    setSameOwnerLp(null);

    if (
      anyOn ||
      !resolveSameOwnerLp ||
      !assetAdminRenounced ||
      !slabAddress ||
      !programIdStr
    ) {
      return;
    }

    let slabPk: PublicKey;
    let programPk: PublicKey;

    try {
      slabPk = new PublicKey(slabAddress);
      programPk = new PublicKey(programIdStr);
    } catch {
      return;
    }

    let alive = true;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const resolve = async () => {
      try {
        const pinnedAddress =
          PLAYGROUND_SLAB_META[slabAddress]?.lp_portfolio_address ?? null;

        const pinned = pinnedAddress
          ? new PublicKey(pinnedAddress)
          : null;

        const lp = await resolveMarketLp(
          connection,
          programPk,
          slabPk,
          pinned,
        );

        if (!alive) return;

        if (lp) {
          setSameOwnerLp({
            slab: slabAddress,
            owner: lp.owner.toBytes(),
          });
          return;
        }
      } catch {
        // Retry below. Until identity is known, the ticket remains fail-closed.
      }

      if (
        alive &&
        attempt < SAME_OWNER_RETRY_MS.length
      ) {
        const delay = SAME_OWNER_RETRY_MS[attempt++];
        retryTimer = setTimeout(
          () => void resolve(),
          delay,
        );
      }
    };

    void resolve();

    return () => {
      alive = false;

      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
    };
  }, [
    anyOn,
    resolveSameOwnerLp,
    assetAdminRenounced,
    slabAddress,
    programIdStr,
    connection,
  ]);

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
        if (lpAccts && lpInfo) {
          const d = new Uint8Array(lpInfo.data);
          const r = decodePortfolioRisk(d);
          if (r) lp = { ...r, address: lpAccts.lpPortfolio, posQ: marketId === null ? 0n : signedPositionForAsset(d, assetIndex, marketId), legs: decodePortfolioLegs(d) };
        }
        const matcher = ctxInfo ? decodeMatcherCtx(new Uint8Array(ctxInfo.data)) : null;
        const vaultState = vaultInfo ? decodeVaultLpState(new Uint8Array(vaultInfo.data)) : null;
        const registryShares = registryInfo ? decodeLpVaultRegistryShares(new Uint8Array(registryInfo.data)) : null;
        setAccts((prev) => ({
          slab: slabAddress,
          // never blank a good value on a failed/empty read
          lp: lp ?? (prev?.slab === slabAddress ? prev.lp : null),
          matcher: matcher ?? (prev?.slab === slabAddress ? prev.matcher : null),
          vaultState: vaultState ?? (prev?.slab === slabAddress ? prev.vaultState : null),
          registryShares: registryShares ?? (prev?.slab === slabAddress ? prev.registryShares : null),
          error: false,
        }));
      } catch {
        if (alive) {
          setAccts((prev) => (prev && prev.slab === slabAddress ? { ...prev, error: true } : { slab: slabAddress, lp: null, matcher: null, vaultState: null, registryShares: null, error: true }));
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
    const sameOwnerPart =
      sameOwnerLp && sameOwnerLp.slab === slabAddress
        ? sameOwnerLp
        : null;

    // SameOwnerTrade is unconditional even when P1/P2/P3 are disabled.
    // After admin burn, use the canonical matcher-LP provenance owner.
    if (!anyOn) {
      return {
        ...OFF(flags),
        assetAdmin: admin,
        sameOwnerLpOwner:
          resolveSameOwnerLp && assetAdminRenounced
            ? sameOwnerPart?.owner ?? null
            : null,
        sameOwnerPending:
          resolveSameOwnerLp &&
          (
            !assetAdminKnown ||
            (assetAdminRenounced && !sameOwnerPart?.owner)
          ),
      };
    }

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
      vaultState: accPart?.vaultState ?? null,
      registryShares: accPart?.registryShares ?? null,
      assetAdmin: admin,
      sameOwnerLpOwner: null,
      sameOwnerPending: false,
    };
  }, [
    anyOn,
    flags,
    accts,
    slabAddress,
    slabPart,
    raw,
    assetAdminBytes,
    assetAdminKnown,
    assetAdminRenounced,
    sameOwnerLp,
    resolveSameOwnerLp,
  ]);
}
