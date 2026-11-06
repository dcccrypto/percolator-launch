"use client";

/**
 * UX WP-5 (audit §3.7): the vault LP's value for the Earn card, never "Needs refresh".
 *  - certificate current (or LP flat): the program's own value, no RPC;
 *  - certificate stale: simulate a crank and value the post-state (lib/limits/earn-valuation-sim);
 *    while it runs the last known value shows with an "updating" dot; if it fails, the last known
 *    value shows "as of {time}".
 */
import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { vaultLpValueAtoms, type VaultLpValue } from "@/lib/limits/vault-tranche";
import { connectionValuationDeps, simulateVaultLpValue, VALUATION_CACHE_MS, type SimulatedValue } from "@/lib/limits/earn-valuation-sim";
import { crankOracleTail } from "@/lib/limits/vault-lp-repair";
import { pythCrankAccount } from "@/lib/limits/oracle-tail";
import { earnP3Enabled } from "@/lib/limits/flags";

export interface VaultLpValuation {
  value: VaultLpValue | null;
  /** The simulated post-crank state (stale certificate only), for the Earn worse-of pricing. */
  sim: SimulatedValue | null;
  /** A simulation is running; `value` is the last known one. */
  updating: boolean;
  /** Set when the value shown is from an earlier simulation (ms epoch). */
  asOf: number | null;
}

export function useVaultLpValuation(slab: string, limits: MarketLimits): VaultLpValuation {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const slabState = useSlabState();
  const [sim, setSim] = useState<SimulatedValue | null>(null);
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState(false);

  // GO1106 leftover: the same gate as earnPanelPricing / useMarketLimits (earnP3Enabled = P3 flag OR a v2.2 build). On
  // `flags.p3` alone the v2.2 preview (no NEXT_PUBLIC_LIMITS_P3) never simulated a stale certificate, so the rail priced a
  // bound vault with an open LP leg as unknown: TVL / Your Value "—" and withdraw Max 0, while the hub table (its own
  // simulation, readBoundVaultPricings) priced it.
  const bound = earnP3Enabled(limits.flags) && limits.vaultLp?.bound === true && !!limits.lp && !!limits.engine;
  const direct = bound ? vaultLpValueAtoms(limits.lp!, limits.engine!) : null;
  const stale = direct?.kind === "stale";
  const programId = slabState.programId?.toBase58() ?? null;
  const payerKey = publicKey?.toBase58() ?? (limits.vaultState ? new PublicKey(limits.vaultState.juniorOwner).toBase58() : null);
  const vaultLpKey = limits.vaultLp ? new PublicKey(limits.vaultLp.vaultLpPortfolio).toBase58() : null;
  // By value: SlabProvider rebuilds `config` on every slab fetch, and keying the effect on that object tore it down
  // (dropping the in-flight result, then skipping the re-run as "in flight") on every keeper push.
  const oracleTailKey = pythCrankAccount(slabState.config, slabState.wrapperConfigV17?.oracleMode)?.toBase58() ?? null;
  const simKey = stale && programId && payerKey && vaultLpKey ? `${programId}|${slab}|${vaultLpKey}|${payerKey}|${oracleTailKey ?? ""}` : null;
  // The inputs the latest render wants priced: a reply for older inputs is dropped (a newer run prices those).
  const wanted = useRef<string | null>(simKey);
  wanted.current = simKey;
  /** The input key whose simulation is in flight (one at a time per key; a new key never waits on an old one). */
  const inflight = useRef<string | null>(null);

  useEffect(() => {
    if (!simKey || !programId || !payerKey || !vaultLpKey) return;
    const key = simKey;
    const run = async () => {
      if (inflight.current === key) return;
      inflight.current = key;
      setUpdating(true);
      let r: SimulatedValue | null = null;
      try {
        r = await simulateVaultLpValue(
          {
            programId: new PublicKey(programId),
            market: new PublicKey(slab),
            vaultLp: new PublicKey(vaultLpKey),
            payer: new PublicKey(payerKey),
            oracleTail: crankOracleTail(oracleTailKey ? new PublicKey(oracleTailKey) : null),
          },
          connectionValuationDeps(connection, new PublicKey(payerKey)),
        );
      } catch {
        r = null;
      } finally {
        if (inflight.current === key) inflight.current = null;
      }
      if (wanted.current !== key) return;
      setUpdating(false);
      if (r) {
        setSim(r);
        setFailed(false);
      } else setFailed(true);
    };
    void run();
    const t = setInterval(() => void run(), VALUATION_CACHE_MS);
    return () => clearInterval(t);
  }, [simKey, programId, payerKey, vaultLpKey, oracleTailKey, slab, connection]);

  if (!bound) return { value: null, sim: null, updating: false, asOf: null };
  if (!stale) return { value: direct, sim: null, updating: false, asOf: null };
  return { value: sim?.value ?? null, sim, updating, asOf: failed && sim ? sim.at : null };
}
