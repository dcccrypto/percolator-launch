/**
 * MarketStatsCard and EngineHealthCard format open interest from useUsdToggle().showUsd, which
 * defaulted to false and is set nowhere in the app, so on /analytics/[slab] they showed OI as a
 * bare base-token amount ("1.8M") while OpenInterestCard showed USD ("$5,864"). It now defaults to USD.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsdToggleProvider, useUsdToggle } from "@/components/providers/UsdToggleProvider";

function Probe() {
  const { showUsd } = useUsdToggle();
  return <span data-testid="unit">{showUsd ? "usd" : "token"}</span>;
}

describe("UsdToggleProvider", () => {
  it("defaults to USD", () => {
    render(
      <UsdToggleProvider>
        <Probe />
      </UsdToggleProvider>,
    );
    expect(screen.getByTestId("unit")).toHaveTextContent("usd");
  });
});
