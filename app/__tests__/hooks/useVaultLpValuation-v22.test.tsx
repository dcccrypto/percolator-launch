/**
 * GO1106 leftover (verify §4, 2026-11-06): "The panel shows TVL '—' and Your value '—'. Pool share shows 4.75%. The
 * Withdraw tab shows 'Max: 0 USDC' ... and 'See exit price' stays disabled", while the hub table priced the same vault.
 *
 * Cause: #3740 opened Earn's bound-vault pricing on a v2.2 build (earnP3Enabled) in earnPanelPricing / useMarketLimits,
 * but useVaultLpValuation still gated on `flags.p3`. The v2.2 preview has no NEXT_PUBLIC_LIMITS_P3, so a bound vault
 * whose LP certificate is stale (an open LP leg: SOL / PENGU after trading) was never simulated; earnPanelPricing then
 * had no LP state and returned withdrawSeniorValue null => the rail's "—" and a 0 Max. The table runs its own
 * simulation (readBoundVaultPricings), which is why it priced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { earnPanelPricing, lagBoundsMarketFromEngine, withSplitPotPricing } from "@/lib/limits/earn";
import { earnDisplayFigures } from "@/lib/limits/earn-display";
import { previewWithdrawAtoms } from "@/lib/limits/earn-withdraw";
import { vaultLpValueAtoms } from "@/lib/limits/vault-tranche";
import type { SimulatedValue } from "@/lib/limits/earn-valuation-sim";
import { ALL_ON, marketLimits } from "../lib/limits/fixtures";

const PROGRAM = Keypair.generate().publicKey;
const SLAB = Keypair.generate().publicKey.toBase58();

const h = vi.hoisted(() => ({ simulate: vi.fn(), connection: {} }));
// useConnectionCompat memoizes the shared connection: stable across renders.
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }), useConnectionCompat: () => ({ connection: h.connection }) }));
// SlabProvider rebuilds `config` on every slab fetch: a NEW object per render, like the app.
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ programId: PROGRAM, config: { slabFetch: Math.random() }, wrapperConfigV17: null }) }));
vi.mock("@/lib/limits/earn-valuation-sim", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/earn-valuation-sim")>()),
  simulateVaultLpValue: h.simulate,
}));

import { useVaultLpValuation } from "@/hooks/useVaultLpValuation";

const P3_OFF = { ...ALL_ON, p3: false };
const base = marketLimits({ flags: P3_OFF });
/** A bound vault whose LP certificate is stale (an open leg the certificate no longer covers). */
const stale = marketLimits({ flags: P3_OFF, lp: { ...base.lp!, cert: { ...base.lp!.cert, oracleEpoch: 1n } } });
/** What the crank simulation returns: the post-crank LP, certified. */
const sim: SimulatedValue = {
  value: vaultLpValueAtoms(base.lp!, base.engine!),
  at: Date.now(),
  lp: { ...base.lp!, legs: base.lp!.legs ?? [] },
  market: lagBoundsMarketFromEngine(base.engine!),
};
const NAV = 1_000_000_000n;
const HELD = 50_000_000n;
const displayState = (bound: boolean) => ({
  bound,
  userLpBalance: HELD,
  pendingRedemptionShares: 0n,
  lpSupply: 0n,
  vaultTotalAtoms: 0n,
  vaultSharePriceE6: 0n,
  userVaultValueAtoms: 0n,
  splitPot: null,
});

beforeEach(() => {
  h.simulate.mockReset();
  h.simulate.mockResolvedValue(sim);
});
afterEach(() => __setDevnetV22ForTest(null));

describe("useVaultLpValuation on a v2.2 build without NEXT_PUBLIC_LIMITS_P3", () => {
  it("fixture sanity: the stale LP is stale and, unsimulated, the rail has no price (the bug's '—' / Max 0)", () => {
    __setDevnetV22ForTest(true);
    expect(vaultLpValueAtoms(stale.lp!, stale.engine!).kind).toBe("stale");
    const pr = withSplitPotPricing(earnPanelPricing(stale, NAV, null), null);
    expect(pr?.withdrawSeniorValue ?? null).toBeNull();
    expect(earnDisplayFigures(displayState(true), pr).tvlAtoms).toBeNull();
  });

  it("simulates the stale certificate, and the rail's TVL / Your Value / Max are priced", async () => {
    __setDevnetV22ForTest(true);
    const { result } = renderHook(() => useVaultLpValuation(SLAB, stale));
    await waitFor(() => expect(result.current.sim).not.toBeNull());
    expect(h.simulate).toHaveBeenCalled();
    expect(result.current.value).toEqual(sim.value);

    // The rail's own composition (VaultDepositRail: earnPanelPricing(limits, nav, sim ?? value)).
    const pricing = withSplitPotPricing(earnPanelPricing(stale, NAV, result.current.sim ?? result.current.value), null);
    expect(pricing?.withdrawSeniorValue).not.toBeNull();
    const fig = earnDisplayFigures(displayState(true), pricing);
    expect(fig.tvlAtoms).not.toBeNull();
    expect(fig.tvlAtoms!).toBeGreaterThan(0n);
    expect(fig.userValueAtoms!).toBeGreaterThan(0n);
    // DepositWithdrawPanel's Max (userWithdrawableAtoms) at the same price: > 0 for a holder.
    expect(previewWithdrawAtoms(HELD, pricing!.totalShares, pricing!.withdrawSeniorValue)!).toBeGreaterThan(0n);
    // Same price as the hub (readBoundVaultPricings -> earnPanelPricing with the same simulation).
    expect(fig.tvlAtoms).toBe(earnPanelPricing(stale, NAV, sim)!.withdrawSeniorValue);
  });

  it("a slab refresh while the simulation is in flight does not drop its result (keeper pushes every few seconds)", async () => {
    __setDevnetV22ForTest(true);
    let resolve!: (v: SimulatedValue) => void;
    h.simulate.mockImplementation(() => new Promise<SimulatedValue>((r) => (resolve = r)));
    const { result, rerender } = renderHook(({ l }) => useVaultLpValuation(SLAB, l), { initialProps: { l: stale } });
    await waitFor(() => expect(h.simulate).toHaveBeenCalledTimes(1));
    // A slab poll: new limits / config objects, same vault, same inputs.
    rerender({ l: { ...stale } });
    rerender({ l: { ...stale } });
    expect(h.simulate).toHaveBeenCalledTimes(1); // the same inputs are not simulated twice at once
    resolve(sim);
    await waitFor(() => expect(result.current.sim).toEqual(sim));
    expect(result.current.value).toEqual(sim.value);
    expect(result.current.updating).toBe(false);
  });

  it("a failed simulation stays unknown ('—'), never a guessed price", async () => {
    __setDevnetV22ForTest(true);
    h.simulate.mockResolvedValue(null);
    const { result } = renderHook(() => useVaultLpValuation(SLAB, stale));
    await waitFor(() => expect(h.simulate).toHaveBeenCalled());
    expect(result.current.value).toBeNull();
    expect(earnPanelPricing(stale, NAV, result.current.sim ?? result.current.value)?.withdrawSeniorValue ?? null).toBeNull();
  });

  it("a current certificate is the program's own value, no simulation", () => {
    __setDevnetV22ForTest(true);
    const { result } = renderHook(() => useVaultLpValuation(SLAB, base));
    expect(result.current.value).toEqual(vaultLpValueAtoms(base.lp!, base.engine!));
    expect(h.simulate).not.toHaveBeenCalled();
  });

  it("CONTROL: not v2.2 and P3 off: no valuation, no RPC (a pre-P3 deployment is unchanged)", () => {
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useVaultLpValuation(SLAB, stale));
    expect(result.current).toEqual({ value: null, sim: null, updating: false, asOf: null });
    expect(h.simulate).not.toHaveBeenCalled();
  });
});
