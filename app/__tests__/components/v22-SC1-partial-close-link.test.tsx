/** v2.2 QA SC-1: a partial close leaves the position open; its tx link must still be shown (words it as "Partly closed"). */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { LastCloseTxLink } from "@/components/trade/LastCloseTxLink";
import { __clearCloseTxs, recordCloseTx } from "@/lib/last-close-tx";

const SIG = "5NVB49mmZ5mhFJSnnGmH6CnKGiS4CQvYpQVqQuodiRaEL5PeK85Cyic5gzdFZLgvzFNqy9eMjMXLhH9gUyoDQyoh";
describe("LastCloseTxLink", () => {
  afterEach(() => { cleanup(); __clearCloseTxs(); });
  it("full close: 'Position closed.' with the link; partial close: 'Partly closed.' with the link", () => {
    const { getByTestId } = render(<LastCloseTxLink slabAddress="S" />);
    act(() => recordCloseTx("S", SIG, Date.now(), false));
    expect(getByTestId("last-close-tx").textContent).toContain("Position closed.");
    expect(getByTestId("last-close-tx").querySelector("a")?.getAttribute("href")).toContain(SIG);
    act(() => recordCloseTx("S", SIG, Date.now(), true));
    expect(getByTestId("last-close-tx").textContent).toContain("Partly closed.");
  });
});

import { bandMinLeg, legBelowBandMin, type BandRentView } from "@/lib/v22/band-rent-state";
describe("SC-1 follow-up: opens / adds / margin use the same visible link with their own lead-in", () => {
  afterEach(() => { cleanup(); __clearCloseTxs(); });
  it("a labelled record renders 'Position opened.' / 'Margin added.' + a link", () => {
    const { getByTestId } = render(<LastCloseTxLink slabAddress="S" />);
    act(() => recordCloseTx("S", SIG, Date.now(), false, "Position opened."));
    expect(getByTestId("last-close-tx").textContent).toContain("Position opened.");
    expect(getByTestId("last-close-tx").querySelector("a")?.getAttribute("href")).toContain(SIG);
    act(() => recordCloseTx("S", SIG, Date.now(), false, "Margin added."));
    expect(getByTestId("last-close-tx").textContent).toContain("Margin added.");
  });
});

// MIN-1: swordcat live values (2026-10-13): min 100 USDC, one lot = 32.116513 USDC.
const swordcat = { assetIndex: 0, lotExp: 4, band: { enabled: true, minLegNotionalAtoms: 100_000_000n }, price: { markE6: 32_116_513n } } as unknown as BandRentView;
describe("MIN-1: the real minimum on a lot market", () => {
  it("100 USDC min at 32.12 USDC per lot is 4 lots = 128.47 USDC, not 100", () => {
    expect(bandMinLeg(swordcat)).toEqual({ lots: 4n, minQ: 4_000_000n, notionalAtoms: 128_466_052n });
  });
  it("a 120 USDC order is 3 whole lots (96.35) and is below it; 4 lots is not; a full close is fine; adding to a leg counts the total", () => {
    expect(legBelowBandMin(swordcat, 0n, 3_000_000n)).toBe(true);
    expect(legBelowBandMin(swordcat, 0n, 4_000_000n)).toBe(false);
    expect(legBelowBandMin(swordcat, 5_000_000n, -5_000_000n)).toBe(false);
    expect(legBelowBandMin(swordcat, 5_000_000n, -2_000_000n)).toBe(true); // leaves 3 lots
    expect(legBelowBandMin(swordcat, 2_000_000n, 2_000_000n)).toBe(false); // 2 + 2 = 4 lots
  });
  it("no band / no lots data: nothing is enforced", () => {
    expect(bandMinLeg(null)).toBeNull();
    expect(legBelowBandMin(null, 0n, 1n)).toBe(false);
  });
});
