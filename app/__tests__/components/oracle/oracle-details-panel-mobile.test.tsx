/**
 * The oracle details sheet rendered inline at z-50: a page's animate-fade-in wrapper capped it, and
 * MobileBottomNav (z-50, later in the DOM) covered the bottom of the mobile sheet. Its close button
 * was an unlabelled 24px "✕". It is now portaled to <body> above the nav, and the close button is
 * named and 44px below lg.
 */
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ config: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceUsd: 1.23 }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({
  useOracleFreshness: () => ({ mode: "admin", modeLabel: "Admin", elapsedSecs: 3, level: "fresh", color: "var(--long)" }),
}));
vi.mock("@/hooks/useOraclePublishers", () => ({
  useOraclePublishers: () => ({ publisherCount: null, publisherTotal: null, publishers: [] }),
}));

import { OracleDetailsPanel } from "@/components/oracle/OracleDetailsPanel";

describe("Oracle details sheet on phones", () => {
  afterEach(cleanup);

  it("renders under <body>, outside the page, above the bottom nav (z-50)", () => {
    const { container } = render(<OracleDetailsPanel onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Oracle details" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveClass("z-[60]");
  });

  it("names the close button and gives it a 44px tap target below lg", () => {
    render(<OracleDetailsPanel onClose={() => {}} />);
    // One per layout (desktop panel + mobile sheet); CSS shows one at a time.
    const closes = screen.getAllByRole("button", { name: "Close oracle details" });
    expect(closes).toHaveLength(2);
    for (const b of closes) expect(b).toHaveClass("h-11", "w-11", "lg:h-6", "lg:w-6");
  });
});
