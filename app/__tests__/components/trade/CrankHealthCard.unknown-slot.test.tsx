/**
 * Before the first cluster-slot read lands, the lag is unknown. The card used to treat it as 0
 * and show a green FRESH "Last update: 0.0s ago", even on a market whose updates had stopped.
 */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const f = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/CdN8r7FB.freshness.market.json"), "utf8"),
) as { contextSlot: number; dataBase64: string };
const raw = new Uint8Array(Buffer.from(f.dataBase64, "base64"));
const slot = vi.hoisted(() => ({ current: null as bigint | null }));

vi.mock("@/hooks/useEngineState", () => ({
  useEngineState: () => ({ engine: null, loading: false, isV17: true }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ raw }),
}));
vi.mock("@/hooks/useEngineFreshness", () => ({
  useEngineFreshness: () => ({ currentSlot: slot.current }),
}));
vi.mock("@/components/ui/Tooltip", () => ({ InfoIcon: () => null }));

import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { readV17AssetSlotLast } from "@/lib/v17-engine-clock";

describe("CrankHealthCard — cluster slot not known yet", () => {
  it("shows CHECKING with no age, not FRESH 0.0s ago", () => {
    slot.current = null;
    render(<CrankHealthCard />);
    expect(screen.getByText("CHECKING")).toBeInTheDocument();
    expect(screen.queryByText("FRESH")).not.toBeInTheDocument();
    expect(screen.getByText("Last update: —")).toBeInTheDocument();
  });

  it("a known slot far past the last update still reads STALE", () => {
    slot.current = BigInt(f.contextSlot) + 100_000n;
    render(<CrankHealthCard />);
    expect(screen.getByText("STALE")).toBeInTheDocument();
  });

  it("an update newer than the last slot read reads 0.0s ago, not negative", () => {
    slot.current = readV17AssetSlotLast(raw)! - 10n;
    render(<CrankHealthCard />);
    expect(screen.getByText("Last update: 0.0s ago")).toBeInTheDocument();
    expect(screen.getByText("FRESH")).toBeInTheDocument();
  });
});
