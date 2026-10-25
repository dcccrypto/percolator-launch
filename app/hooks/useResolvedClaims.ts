"use client";

/**
 * What the connected wallet can still claim on a RESOLVED market, read from chain (lib/v22/resolved-claims.ts plans the rows).
 *
 * Reads, every 20 s while the panel is mounted: the market (already in SlabProvider), the wallet's own portfolios
 * (`loadOwnPortfolios`), its Earn shares (`readEarnPositions`) and its stake LP in this market's pool. Nothing is sent from here.
 * v2.2 builds only; a market that is not Resolved shows nothing and reads nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { deriveStakePool } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { useSlabState } from "@/components/providers/SlabProvider";
import { decodeResolvedMarket } from "@/lib/limits/decode";
import { loadOwnPortfolios } from "@/lib/limits/own-portfolio-cleanup";
import { readEarnPositions } from "@/lib/limits/earn-positions";
import { decodeTerminalInsuranceCapacity } from "@/lib/v22/records";
import { decodeStakePoolV1, STAKE_POOL_SIZE_V1 } from "@/hooks/useStakePool";
import { getConfig } from "@/lib/config";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { ownerWindow, planClaimRows, stakeRecoverState, type ClaimRow, type ClaimViewer, type OwnerWindow } from "@/lib/v22/resolved-claims";

const POLL_MS = 20_000;

export interface ResolvedClaimsState {
  /** The market is Resolved (the panel renders only then). */
  resolved: boolean;
  rows: ClaimRow[];
  window: OwnerWindow | null;
  /** The wallet holds something here (any row with an action). */
  hasClaims: boolean;
  /** Some read has not finished or failed: rows may be missing, never invented. */
  loading: boolean;
}

export function useResolvedClaims(slabAddress: string | null): ResolvedClaimsState {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { raw, programId } = useSlabState();
  const nowSlot = useClusterSlot(isDevnetV22Enabled());
  const market = useMemo(() => (raw ? decodeResolvedMarket(raw) : null), [raw]);
  const resolved = isDevnetV22Enabled() && market !== null && market.mode === 1;
  const owner = wallet.publicKey ?? null;
  const [viewer, setViewer] = useState<ClaimViewer>({ positions: null, earnShares: null, stakeShares: null, stakeNeedsRecover: false });
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (!resolved || !slabAddress || !programId || !owner || !raw) return;
    const market = new PublicKey(slabAddress);
    const wrapper = new PublicKey(programId);
    const next: ClaimViewer = { positions: null, earnShares: null, stakeShares: null, stakeNeedsRecover: false };
    const [own, earn, stake] = await Promise.allSettled([
      loadOwnPortfolios(connection, wrapper, market, owner),
      readEarnPositions(connection, wrapper, owner, [slabAddress]),
      (async (): Promise<bigint> => {
        const stakeProgram = new PublicKey((getConfig() as { vaultProgramId?: string }).vaultProgramId ?? DEVNET_PROGRAM_IDS.stake);
        const [pool] = deriveStakePool(market, stakeProgram);
        const info = await connection.getAccountInfo(pool, "confirmed");
        if (!info || !info.owner.equals(stakeProgram) || info.data.length < STAKE_POOL_SIZE_V1) return 0n;
        const { lpMint } = decodeStakePoolV1(info.data);
        const ata = getAssociatedTokenAddressSync(lpMint, owner);
        const ataInfo = await connection.getAccountInfo(ata, "confirmed");
        return ataInfo ? unpackAccount(ata, ataInfo).amount : 0n;
      })(),
    ]);
    if (own.status === "fulfilled") next.positions = own.value.length;
    if (earn.status === "fulfilled") next.earnShares = earn.value.get(slabAddress)?.shares ?? 0n;
    if (stake.status === "fulfilled") {
      next.stakeShares = stake.value;
      try {
        next.stakeNeedsRecover = stakeRecoverState(decodeTerminalInsuranceCapacity(raw, 0)).offer;
      } catch {
        next.stakeNeedsRecover = false;
      }
    }
    if (alive.current) setViewer(next);
  }, [resolved, slabAddress, programId, owner, raw, connection]);

  useEffect(() => {
    if (!resolved || !owner) return;
    let cancelled = false;
    setLoading(true);
    void read().finally(() => {
      if (!cancelled && alive.current) setLoading(false);
    });
    const stop = pollWhenVisible(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [resolved, owner, read]);

  const rows = useMemo(() => (market && resolved ? planClaimRows(market, viewer) : []), [market, resolved, viewer]);
  const window = useMemo(() => (market && resolved ? ownerWindow(market, nowSlot, Date.now()) : null), [market, resolved, nowSlot]);
  return { resolved, rows, window, hasClaims: rows.some((r) => r.actions.length > 0), loading };
}
