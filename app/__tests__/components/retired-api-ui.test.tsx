/**
 * UI side of retiring percolator-api:
 *  - the live price store connects ONLY to NEXT_PUBLIC_WS_URL (the Railway price-ws service);
 *    it no longer derives a socket URL from the retired NEXT_PUBLIC_API_URL.
 *  - the dashboard Funding Rates panel hides itself when /api/funding/global cannot answer
 *    honestly, instead of printing an error or claiming "Funding: Off" for unread markets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { beforeEach as v22PinBefore, afterEach as v22PinAfter } from "vitest";
// v2.2 flag pinned OFF: the v2.2 preview has no registry and does not ask for funding/global (v22-no-backend-requests-rt5.test.tsx).
v22PinBefore(() => { vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "0"); }); // env, not the test seam: these tests reset modules
v22PinAfter(() => { vi.unstubAllEnvs(); });

const ws = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@/lib/priceStore/wsManager", () => ({
  getWsManager: (url: string) => {
    ws.urls.push(url);
    return {
      subscribeChannel: () => () => {},
      onMessage: () => () => {},
      onMessageForChannel: () => () => {},
      onStatusChange: () => () => {},
    };
  },
}));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  ws.urls = [];
});

async function wsUrlWith(env: Record<string, string | undefined>): Promise<string> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const store = await import("@/lib/priceStore/priceStore");
  const release = store.subscribeSlab("ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ", () => {});
  release();
  return ws.urls[ws.urls.length - 1];
}

describe("priceStore WebSocket URL", () => {
  it("uses NEXT_PUBLIC_WS_URL (the price-ws service)", async () => {
    const url = "wss://percolator-price-ws-production.up.railway.app";
    expect(await wsUrlWith({ NEXT_PUBLIC_WS_URL: url, NEXT_PUBLIC_API_URL: "https://dead.example" })).toBe(url);
  });
  it("never derives a socket from the retired NEXT_PUBLIC_API_URL: unset WS URL = WS disabled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await wsUrlWith({ NEXT_PUBLIC_WS_URL: undefined, NEXT_PUBLIC_API_URL: "https://dead.example" })).toBe("");
  });
});

describe("FundingRates panel", () => {
  async function renderWith(res: { ok: boolean; status: number; body: unknown }) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: res.ok, status: res.status, json: async () => res.body })));
    const { FundingRates } = await import("@/components/dashboard/FundingRates");
    return render(<FundingRates />);
  }

  it("route unavailable (503): renders nothing, no error text", async () => {
    const { container } = await renderWith({ ok: false, status: 503, body: { error: "x" } });
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
  it("a funding-on market could not be read: renders nothing rather than 'Funding: Off'", async () => {
    const { container } = await renderWith({
      ok: true,
      status: 200,
      body: { markets: [{ slabAddress: "a", baseSymbol: "PENGU", rateBpsPerSlot: 0, hourlyRatePercent: 0, dailyRatePercent: 0, fundingEnabled: false }], count: 1, ratesUnavailable: 1, source: "on-chain" },
    });
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
  it("every market read from chain with funding off: says so", async () => {
    const { findByText } = await renderWith({
      ok: true,
      status: 200,
      body: { markets: [{ slabAddress: "a", baseSymbol: "PENGU", rateBpsPerSlot: 0, hourlyRatePercent: 0, dailyRatePercent: 0, fundingEnabled: false }], count: 1, ratesUnavailable: 0, source: "on-chain" },
    });
    expect(await findByText("Funding: Off (disabled)")).toBeTruthy();
  });
});
