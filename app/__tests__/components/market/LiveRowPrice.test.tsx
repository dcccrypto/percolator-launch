/**
 * /markets list price cell (#2733): list prices must flash green on an
 * up-tick and red on a down-tick, like the trade header, and the static
 * fallback (no tick yet) must never flash. Drives the REAL price store.
 */
import "@testing-library/jest-dom";
import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRowPrice } from "@/components/market/LiveRowPrice";
import { seedFromOnChain, applyOnChainPoll } from "@/lib/priceStore/priceStore";
import { seedLotExp0 } from "../../helpers/v22-fixtures";

seedLotExp0();

// Unique slab per test so the module-level store never leaks state between cases.
let n = 0;
const nextSlab = () => `TestSlab${++n}${"1".repeat(30)}`;

describe("LiveRowPrice", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tick = (slab: string, e6: bigint) =>
    act(() => {
      applyOnChainPoll(slab, e6);
      vi.advanceTimersByTime(20); // let any rAF/microtask-flushed notify land
    });

  it("shows the fallback without flashing before any tick", () => {
    render(<LiveRowPrice slab={nextSlab()} fallback={0.007595} />);
    const el = screen.getByTestId("markets-row-price");
    expect(el).toHaveTextContent("$0.007595");
    expect(el).not.toHaveAttribute("data-flash");
    expect(el.className).not.toMatch(/--long|--short/);
  });

  it("flashes green on an up-tick and red on a down-tick, then rests", () => {
    const slab = nextSlab();
    act(() => { seedFromOnChain(slab, 7_595n); });
    render(<LiveRowPrice slab={slab} fallback={null} />);
    const el = screen.getByTestId("markets-row-price");
    expect(el).not.toHaveAttribute("data-flash");

    tick(slab, 7_598n);
    expect(el).toHaveAttribute("data-flash", "up");
    expect(el.className).toContain("text-[var(--long)]");

    tick(slab, 7_526n);
    expect(el).toHaveAttribute("data-flash", "down");
    expect(el.className).toContain("text-[var(--short)]");

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(el).not.toHaveAttribute("data-flash");
    expect(el.className).not.toMatch(/--long|--short/);
  });
});

describe("/markets page uses the flashing cell", () => {
  it("renders LiveRowPrice for both the mobile and desktop rows", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../../app/markets/page.tsx"), "utf8");
    expect(src).toMatch(/import \{ LiveRowPrice \} from "@\/components\/market\/LiveRowPrice"/);
    expect(src.match(/<LiveRowPrice /g)?.length).toBe(2);
  });
});
