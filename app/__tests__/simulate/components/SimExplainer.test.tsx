import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock localStorage
const mockStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mockStorage[k] || null,
  setItem: (k: string, v: string) => { mockStorage[k] = v; },
  removeItem: (k: string) => { delete mockStorage[k]; },
});

// Mock useEngineState with real shape — initially loading=true so no cards rendered
vi.mock("@/hooks/useEngineState", () => ({
  useEngineState: vi.fn(() => ({
    engine: null,
    fundingRate: null,
    insuranceFund: null,
    totalOI: null,
    loading: true,
  })),
}));

import { SimExplainer } from "@/app/simulate/components/SimExplainer";
import { useEngineState } from "@/hooks/useEngineState";

describe("SimExplainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  });

  it("returns null when loading (no cards)", () => {
    const { container } = render(<SimExplainer />);
    // When loading or no engine data, returns null → empty container
    expect(container.innerHTML).toBe("");
  });

  it("renders contextual insights header when engine has data", () => {
    vi.mocked(useEngineState).mockReturnValue({
      engine: {
        lifetimeLiquidations: 0n,
        lastCrankSlot: 100n,
      },
      fundingRate: 500n, // positive funding
      insuranceFund: { balance: 5000000000n },
      totalOI: 100000000000n,
      loading: false,
    } as any);
    render(<SimExplainer />);
    expect(screen.getByText(/Contextual Insights/i)).toBeTruthy();
  });

  it("shows funding rate card when funding is non-zero", () => {
    vi.mocked(useEngineState).mockReturnValue({
      engine: {
        lifetimeLiquidations: 0n,
        lastCrankSlot: 100n,
      },
      fundingRate: 500n,
      insuranceFund: { balance: 5000000000n },
      totalOI: 100000000000n,
      loading: false,
    } as any);
    render(<SimExplainer />);
    expect(screen.getByText(/Funding Rate Insight/i)).toBeTruthy();
  });

  it("shows insurance fund healthy card when ratio is good", () => {
    vi.mocked(useEngineState).mockReturnValue({
      engine: {
        lifetimeLiquidations: 0n,
        lastCrankSlot: 100n,
      },
      fundingRate: 100n,
      insuranceFund: { balance: 10000000000n }, // $10K
      totalOI: 100000000000n, // $100K → ratio 10%
      loading: false,
    } as any);
    render(<SimExplainer />);
    expect(screen.getByText(/Insurance Fund is Healthy/i)).toBeTruthy();
  });
});
