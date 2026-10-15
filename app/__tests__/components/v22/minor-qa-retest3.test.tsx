/** v2.2 QA retest 3 minors: close tx stays linkable; no analytics script / candle requests / indexer warning on the preview. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen } from "@testing-library/react";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __clearCloseTxs, lastCloseTx, LAST_CLOSE_TTL_MS, recordCloseTx } from "@/lib/last-close-tx";
import { LastCloseTxLink } from "@/components/trade/LastCloseTxLink";
import { NO_HISTORY_COPY, v22HasNoIndexer } from "@/lib/v22/indexer";

vi.mock("@/lib/config", async (orig) => ({ ...(await orig<typeof import("@/lib/config")>()), explorerTxUrl: (s: string) => `https://explorer.test/tx/${s}` }));
const src = (f: string) => readFileSync(path.join(__dirname, "../../..", f), "utf8");
const SIG = "5B92choPdcKVme3heiTR2DQykpbhNidQ8STpVJAKPo3JzwBttMpRgp9WwzdUkxW6YutYjJkGoLAG8eRoQTci98Fw";

describe("close tx stays visible", () => {
  afterEach(() => __clearCloseTxs());
  it("the link appears once a close is recorded for THIS market and expires after 10 minutes", () => {
    render(<LastCloseTxLink slabAddress="SLAB_A" />);
    expect(screen.queryByTestId("last-close-tx")).toBeNull();
    act(() => recordCloseTx("SLAB_B", SIG));
    expect(screen.queryByTestId("last-close-tx")).toBeNull();
    act(() => recordCloseTx("SLAB_A", SIG));
    const a = screen.getByRole("link");
    expect(a.getAttribute("href")).toBe(`https://explorer.test/tx/${SIG}`);
    expect(a.textContent).toContain("5B92…98Fw");
    expect(lastCloseTx("SLAB_A", Date.now() + LAST_CLOSE_TTL_MS + 1)).toBeNull();
  });
  it("useClosePosition records it; the ticket's Close tab and the positions dock render it in their empty state", () => {
    expect(src("hooks/useClosePosition.ts")).toContain("recordCloseTx(slabAddress, sig, Date.now(), closePercent < 100);");
    expect(src("components/trade/OrderTicketClosePanel.tsx")).toContain("<LastCloseTxLink slabAddress={slabAddress}");
    expect(src("components/trade/PositionsDock.tsx")).toContain("<LastCloseTxLink slabAddress={slabAddress}");
  });
});

describe("no indexer on the v2.2 preview", () => {
  afterEach(() => { __setDevnetV22ForTest(null); vi.unstubAllEnvs(); });
  it("v2.2 without an attested indexer: true; attested or flag off: false", () => {
    __setDevnetV22ForTest(true);
    expect(v22HasNoIndexer()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_V22_INDEXER_LOT_AWARE", "1");
    expect(v22HasNoIndexer()).toBe(false);
    vi.unstubAllEnvs();
    __setDevnetV22ForTest(false);
    expect(v22HasNoIndexer()).toBe(false);
  });
  it("candles are not requested there, the history view is calm, and the analytics script is not referenced", () => {
    expect(src("hooks/usePercolatorCandles.ts")).toContain("let endpointUnavailable = v22HasNoIndexer();");
    expect(src("lib/tv/data/candlesApiProvider.ts")).toContain("let candlesUnavailable = v22HasNoIndexer();");
    const th = src("components/dashboard/TradeHistory.tsx");
    expect(th).toContain("v22HasNoIndexer() ? NO_HISTORY_COPY.title");
    expect(th).toContain("{!v22HasNoIndexer() && (process.env.NEXT_PUBLIC_DEFAULT_NETWORK");
    expect(NO_HISTORY_COPY.title).toBe("No trade history on this test build");
    // #2826: the script is opt-in via NEXT_PUBLIC_VERCEL_ANALYTICS (unset on the preview), not tied to the v2.2 flag.
    expect(src("app/layout.tsx")).toContain("<VercelAnalytics />");
    expect(src("components/analytics/VercelAnalytics.tsx")).toContain("if (!vercelAnalyticsEnabled()) return null;");
  });
});
