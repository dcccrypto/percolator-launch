// @vitest-environment node
/**
 * /api/markets/health clock-step safety: a backwards wall-clock step makes a cache
 * entry's age negative. It must count as expired (refetch), not "fresh" until the
 * clock catches up. Covers the response cache and the LP-scan cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const MURPHY = "7h3wNxjzPo6pTfWQ7uiTjDSsprGEeMNh696efmYrpAX2";
const PENGU = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ";

const m = vi.hoisted(() => ({ rpc: vi.fn(), scan: vi.fn(), ip: 0 }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({ getMultipleAccountsInfoAndContext: m.rpc }) }));
vi.mock("@/lib/lp-portfolio", () => ({
  getKnownMarketLpCapitals: async () => new Map<string, bigint>(),
  scanEnabledMarketLpCapitals: m.scan,
}));
vi.mock("@/lib/adl-since-store", () => ({ recordAdlObservations: async () => ({}) }));
vi.mock("@/lib/get-client-ip", () => ({ getClientIp: () => `10.1.0.${m.ip}` }));

const req = (slabs: string) => new NextRequest(`http://localhost/api/markets/health?slabs=${slabs}`);
const T0 = Date.parse("2026-11-18T12:00:00Z");

async function freshGet() {
  vi.resetModules();
  return (await import("../../app/api/markets/health/route")).GET;
}

vi.setConfig({ testTimeout: 60_000 }); // first test pays the cold route import

describe("/api/markets/health clock step", () => {
  beforeEach(() => {
    m.ip++;
    m.rpc.mockReset();
    m.scan.mockReset();
    m.rpc.mockImplementation(async (keys: unknown[]) => ({ context: { slot: 1 }, value: keys.map(() => null) }));
    m.scan.mockResolvedValue(new Map());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("response cache: control — same clock within TTL is served from cache", async () => {
    const GET = await freshGet();
    await GET(req(MURPHY));
    vi.setSystemTime(T0 + 5_000);
    await GET(req(MURPHY));
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it("response cache: a backwards clock step refetches instead of serving stale", async () => {
    const GET = await freshGet();
    await GET(req(MURPHY));
    vi.setSystemTime(T0 - 600_000);
    await GET(req(MURPHY));
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it("LP scan cache: control — rescan not repeated within TTL", async () => {
    const GET = await freshGet();
    await GET(req(MURPHY));
    vi.setSystemTime(T0 + 5_000);
    await GET(req(PENGU));
    expect(m.scan).toHaveBeenCalledTimes(1);
  });

  it("LP scan cache: a backwards clock step rescans instead of keeping a stale map", async () => {
    const GET = await freshGet();
    await GET(req(MURPHY));
    vi.setSystemTime(T0 - 600_000);
    await GET(req(PENGU));
    expect(m.scan).toHaveBeenCalledTimes(2);
  });
});
