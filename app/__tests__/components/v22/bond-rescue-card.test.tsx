import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import type { EarnV22Context } from "@/lib/v22/earn-context";
import type { BondPositionV20, BondTrancheV20 } from "@/lib/v22/sdk";
import { bondCardState, type BondReadings } from "@/lib/v22/bond-ui";
import { rescueView } from "@/lib/v22/rescue-ui";
import { V22_COPY } from "@/lib/v22/copy";

const h = vi.hoisted(() => ({ bond: {} as Record<string, unknown>, rescue: {} as Record<string, unknown> }));
vi.mock("@/hooks/useBondV22", () => ({ useBondV22: () => h.bond }));
vi.mock("@/hooks/useRescueV22", () => ({ useRescueV22: () => h.rescue }));

import { BondCard } from "@/components/earn/BondCard";
import { RescueAction } from "@/components/earn/RescueAction";

const k = () => Keypair.generate().publicKey;
const ctx: EarnV22Context = { market: k(), programId: k(), collateralMint: k(), decimals: 6, symbol: "SOL", registryDomain: 0, lpPortfolio: null, view: null, registryShares: null, oiLongQ: 0n, oiShortQ: 0n, lpEffAbsQ: 0n };
const tranche: BondTrancheV20 = { marketGroup: PublicKey.default, cBAtoms: 1_000_000_000n, bSharesTotal: 1_000_000_000n, principalInLpAtoms: 0n, bondDrawnOutstandingAtoms: 0n, lastCouponSlot: 0n, couponBpsPerYear: 800, couponUtilBonusBps: 0, bondCooldownSlots: 9000, bondCapBpsOfC: 5000, version: 1, bump: 1, lastUtilBps: 0, couponPaidTotalAtoms: 0n };
const position = (o: Partial<BondPositionV20> = {}): BondPositionV20 => ({ owner: PublicKey.default, shares: 100_000_000n, pendingWithdrawShares: 0n, requestSlot: 0n, version: 1, bump: 1, ...o });
const flat: BondReadings = { vaultValue: 5_000_000_000n, seniorClaimEff: 2_000_000_000n, oiLongQ: 0n, oiShortQ: 0n, lpEffAbsQ: 0n };

function setBond(o: { bond?: unknown; position?: BondPositionV20 | null; slot?: bigint; readings?: BondReadings }) {
  const readings = o.readings ?? flat;
  const bond = o.bond === undefined ? { tranche, position: o.position ?? null, trancheKey: k(), positionKey: null } : o.bond;
  const state = bond ? bondCardState({ tranche, position: (bond as { position: BondPositionV20 | null }).position, nowSlot: o.slot ?? 0n, readings }) : null;
  h.bond = { bond, state, readings, busy: false, message: null, connected: true, deposit: vi.fn(), requestWithdraw: vi.fn(), executeWithdraw: vi.fn() };
}

beforeEach(() => { __setDevnetV22ForTest(true); });
afterEach(() => { cleanup(); __setDevnetV22ForTest(null); });

describe("BondCard", () => {
  it("market without a tranche: renders nothing", () => {
    setBond({ bond: null });
    expect(render(<BondCard ctx={ctx} />).container.firstChild).toBeNull();
  });
  it("flag off: renders nothing even with a tranche (parity)", () => {
    __setDevnetV22ForTest(false);
    setBond({});
    expect(render(<BondCard ctx={ctx} />).container.firstChild).toBeNull();
  });
  it("honest copy: losses after the junior and before Earn, coupon from fees and capped, live exit only when flat", () => {
    setBond({});
    render(<BondCard ctx={ctx} />);
    expect(screen.getByTestId("bond-absorbs").textContent).toBe(V22_COPY.bond.absorbs);
    expect(screen.getByTestId("bond-coupon").textContent).toContain("paid from trading fees and is capped");
    expect(screen.getByTestId("bond-coupon").textContent).toContain("Up to 8%");
    expect(screen.getByTestId("bond-exit").textContent).toBe(V22_COPY.bond.exit);
  });
  it("impaired: deposits paused, deposit button disabled", () => {
    setBond({ readings: { ...flat, vaultValue: 2_500_000_000n } });
    render(<BondCard ctx={ctx} />);
    expect(screen.getByText(V22_COPY.bond.impaired)).toBeTruthy();
    fireEvent.change(screen.getByTestId("bond-amount"), { target: { value: "1" } });
    expect((screen.getByTestId("bond-deposit") as HTMLButtonElement).disabled).toBe(true);
  });
  it("healthy: a quote with the minimum shares shows before the deposit is enabled", () => {
    setBond({});
    render(<BondCard ctx={ctx} />);
    fireEvent.change(screen.getByTestId("bond-amount"), { target: { value: "100" } });
    expect(screen.getByTestId("bond-quote").textContent).toContain("at least 99.5");
    expect((screen.getByTestId("bond-deposit") as HTMLButtonElement).disabled).toBe(false);
  });
  it("cooldown pending: no execute button, a calm wait line", () => {
    setBond({ position: position({ pendingWithdrawShares: 10n, requestSlot: 1000n }), slot: 2000n });
    render(<BondCard ctx={ctx} />);
    expect(screen.getByTestId("bond-cooldown")).toBeTruthy();
    expect(screen.queryByTestId("bond-execute")).toBeNull();
  });
  it("cooldown ready and flat: Withdraw is enabled", () => {
    setBond({ position: position({ pendingWithdrawShares: 10n, requestSlot: 0n }), slot: 20_000n });
    render(<BondCard ctx={ctx} />);
    expect((screen.getByTestId("bond-execute") as HTMLButtonElement).disabled).toBe(false);
  });
  it("cooldown ready but the market is busy: Withdraw disabled with the locked line", () => {
    setBond({ position: position({ pendingWithdrawShares: 10n, requestSlot: 0n }), slot: 20_000n, readings: { ...flat, oiLongQ: 5n } });
    render(<BondCard ctx={ctx} />);
    expect((screen.getByTestId("bond-execute") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("bond-locked").textContent).toBe(V22_COPY.bond.locked);
  });
});

describe("RescueAction", () => {
  const set = (r: { v: bigint | null; par: bigint; shares: bigint }, quote?: unknown) => {
    h.rescue = { view: rescueView(r), readings: r, quote: () => quote ?? null, rescue: vi.fn(), busy: false, message: null, connected: true };
  };
  it("not impaired: the action is not rendered at all", () => {
    set({ v: 1_000_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n });
    expect(render(<RescueAction ctx={ctx} />).container.firstChild).toBeNull();
  });
  it("flag off: nothing", () => {
    __setDevnetV22ForTest(false);
    set({ v: 800_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n });
    expect(render(<RescueAction ctx={ctx} />).container.firstChild).toBeNull();
  });
  it("impaired: shows the title, the discount price, and the floor once an amount is quoted", () => {
    const r = { v: 800_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n };
    set(r, { admitted: true, refusal: null, shares: 250_000_000n, minShares: 248_750_000n, claimDelta: null });
    render(<RescueAction ctx={ctx} />);
    expect(screen.getByText(V22_COPY.rescue.title)).toBeTruthy();
    expect(screen.getByTestId("rescue-price").textContent).toBe(V22_COPY.rescue.price("$0.8000"));
    fireEvent.change(screen.getByTestId("rescue-amount"), { target: { value: "200" } });
    expect(screen.getByTestId("rescue-floor").textContent).toBe(V22_COPY.rescue.floor("248.75"));
    expect((screen.getByTestId("rescue-submit") as HTMLButtonElement).disabled).toBe(false);
  });
  it("past the NAV floor: the wind-down line instead of an action", () => {
    set({ v: 10_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n });
    render(<RescueAction ctx={ctx} />);
    expect(screen.getByText(V22_COPY.rescue.wound)).toBeTruthy();
    expect(screen.queryByTestId("rescue-amount")).toBeNull();
  });
});
