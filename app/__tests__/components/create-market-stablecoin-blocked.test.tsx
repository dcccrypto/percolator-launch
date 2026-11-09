/**
 * Owner decision 2026-11-09 (Council R2-11 / R3-10, Creator seat, round-4 seats/creator/out/w7-mints.txt): on v2.2, mainnet USDC
 * (EPjFW...) and PYUSD (2b1kV6...) reached an ENABLED "HOLD TO LAUNCH" as perp underlyings, priced off USDC/USDT and PYUSD/USDC DLMM
 * pools at ~$1. Stablecoin perps are not launchable in v2.2: step 1 refuses them with one line and the launch stays disabled.
 * A normal token still reaches an enabled launch (control). Renders the real CreateMarketWizard (scaffold from
 * create-market-lot-launch-price.test.tsx); only I/O is faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";

const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
let MINT = CONTROL;
const POOL = "HC7ArykAUSamJSAJ1aYLrS8aAamvBb1JvqMf1woUtnKo";

const RESOLVE_BODY = {
  feedId: null, symbol: "e/acc", price: 0.0000015, source: "dexscreener",
  dexPoolAddress: POOL, dexType: "meteora-dlmm", oracleMode: "hyperp", cached: true,
};
// $48k liquidity = the "medium" tier: 1500 bps, shown as 6.5x.
const DEXSCREENER_BODY = {
  schemaVersion: "1.0.0",
  pairs: [{
    chainId: "solana", dexId: "meteora", url: `https://dexscreener.com/solana/${POOL.toLowerCase()}`,
    pairAddress: POOL,
    baseToken: { address: CONTROL, name: "e/acc", symbol: "e/acc" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
    priceNative: "0.0000651", priceUsd: "0.0000015",
    liquidity: { usd: 48210.55, base: 1900000, quote: 120.4 },
    volume: { h24: 10234.1 }, fdv: 12400000,
  }],
};

function deferred() {
  let release!: () => void;
  const p = new Promise<void>((r) => { release = r; });
  return { p, release };
}
let gateResolve = deferred();
let gateDex = deferred();
// Set to [] to model a token with no pool: then the resolve is the ONLY price source.
let dexPairs: unknown[] = DEXSCREENER_BODY.pairs;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.dexscreener.com/latest/dex/tokens/")) {
    await gateDex.p;
    return json({ ...DEXSCREENER_BODY, pairs: (dexPairs as Array<{ baseToken: object }>).map((p) => ({ ...p, baseToken: { ...p.baseToken, address: MINT } })) });
  }
  if (url.includes("/api/oracle/resolve/")) {
    await gateResolve.p;
    return json(RESOLVE_BODY);
  }
  // E2E B21: the pool search classifies candidates by mainnet owner; this pool is DLMM.
  if (url === "/api/dex/classify-pools") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { addresses?: string[] };
    return json({ classes: Object.fromEntries((body.addresses ?? []).map((a) => [a, "meteora-dlmm"])) });
  }
  return json({ error: "not mocked" }, 404);
}) as typeof fetch;

vi.mock("@/lib/tokenMeta", async (orig) => ({
  ...(await orig<object>()),
  fetchTokenMeta: vi.fn(async () => {
    await (globalThis as { __gateMeta?: { p: Promise<void> } }).__gateMeta?.p;
    return { name: "e/acc", symbol: "e/acc", decimals: 6 };
  }),
}));

const connection = {
  rpcEndpoint: "https://api.devnet.solana.com",
  getBalance: async () => 100e9,
  getAccountInfo: async () => null,
};
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: SystemProgram.programId, connected: true }),
  useConnectionCompat: () => ({ connection }),
}));

const create = vi.fn();
const IDLE = { step: 0, loading: false, error: null as string | null, stepErrors: {}, txSigs: [], slabAddress: null as string | null };
let createState = IDLE;
vi.mock("@/hooks/useCreateMarket", async (orig) => ({
  ...(await orig<object>()),
  useCreateMarket: () => ({
    state: createState,
    create, reset: vi.fn(), restoreSlabKeypair: vi.fn(), retryKeeperRegistration: vi.fn(),
  }),
}));
vi.mock("@/hooks/useStuckSlabs", () => ({ useStuckSlabs: () => ({ stuckSlab: null, stuckSlabs: [] }) }));
vi.mock("@/hooks/useDuplicateMarket", () => ({
  useDuplicateMarket: () => ({ checking: false, duplicates: [] }),
}));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getNetwork: () => "devnet" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));

import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const onStep2 = () => !!screen.queryByText(/STEP 2 \/ 2/);
// HoldToLaunch's button: the only rounded-full button; aria-label = disabledReason when disabled.
const launchBtn = () =>
  screen.getAllByRole("button").find((b) => b.className.includes("rounded-full") && b.hasAttribute("aria-label")) as HTMLButtonElement;

import { afterAll, beforeAll } from "vitest";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
import { isStablecoinPerpBlocked } from "@/lib/creator-copy";

const G = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
let view: ReturnType<typeof render> | null = null;

async function paste(mint: string) {
  MINT = mint;
  G.__gateMeta = deferred();
  view = render(<CreateMarketWizard />);
  fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: mint } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  G.__gateMeta.release(); await flush();
  gateDex.release(); gateResolve.release(); await flush();
}

describe("v2.2: stablecoin perps are not launchable (owner 2026-11-09, R2-11 / R3-10)", () => {
  beforeAll(() => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    __setLimitsFlagsForTest({ p1: true, p2: true, p2FeeCharged: false, p3: true } as Parameters<typeof __setLimitsFlagsForTest>[0]);
    __setLotMarketsEnabledForTest(true);
  });
  afterAll(() => {
    __setDevnetV21ForTest(null);
    __setDevnetV22ForTest(null);
    __setLimitsFlagsForTest(null);
    __setLotMarketsEnabledForTest(null);
  });
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear(); createState = IDLE;
    gateResolve = deferred(); gateDex = deferred(); dexPairs = DEXSCREENER_BODY.pairs;
    view?.unmount(); view = null;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  it("control: a normal token reaches an ENABLED hold-to-launch (the scaffold can launch)", async () => {
    await paste(CONTROL);
    await waitFor(() => expect(onStep2()).toBe(true));
    await act(async () => { fireEvent.click(screen.getByTestId("growth-launch-toggle")); });
    await flush();
    expect(launchBtn().disabled, launchBtn().getAttribute("aria-label") ?? "").toBe(false);
    expect(screen.queryByTestId("create-stablecoin-mint-blocked")).toBeNull();
  });

  for (const [name, mint] of [["USDC", USDC], ["PYUSD", PYUSD], ["USDT", USDT]] as const) {
    it(`${name}: step 1 says why, never reaches the launch step, and nothing is built or signed`, async () => {
      await paste(mint);
      await waitFor(() => expect(screen.queryByTestId("create-stablecoin-mint-blocked")).not.toBeNull());
      expect(screen.getByTestId("create-stablecoin-mint-blocked").textContent).toMatch(/stablecoin/i);
      // Auto-advance would have moved to step 2 by now on a launchable token (control above).
      await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
      expect(onStep2()).toBe(false);
      const cont = screen.queryByRole("button", { name: /continue/i }) as HTMLButtonElement | null;
      if (cont) expect(cont.disabled).toBe(true);
      expect(create).not.toHaveBeenCalled();
    });
  }
});

describe("isStablecoinPerpBlocked", () => {
  afterAll(() => __setDevnetV22ForTest(null));
  it("blocks USDC, PYUSD and USDT on v2.2 (trimmed input too); not other mints", () => {
    __setDevnetV22ForTest(true);
    for (const m of [USDC, PYUSD, USDT, ` ${USDC} `]) expect(isStablecoinPerpBlocked(m)).toBe(true);
    for (const m of [CONTROL, "So11111111111111111111111111111111111111112", ""]) expect(isStablecoinPerpBlocked(m)).toBe(false);
  });
  it("changes nothing off v2.2 (playground / production paths keep their behaviour)", () => {
    __setDevnetV22ForTest(false);
    expect(isStablecoinPerpBlocked(USDC)).toBe(false);
    expect(isStablecoinPerpBlocked(PYUSD)).toBe(false);
  });
});
