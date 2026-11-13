/**
 * Backstop pin (#3779 review Low): launch() and retry() themselves refuse a NEW stablecoin launch, whichever caller reaches
 * them, because step 1 and the disabled HOLD TO LAUNCH make the in-function check unreachable from a normal flow.
 * Here the real wizard reaches the launch step for the mint while the block is OFF (a test seam on the predicate), then the
 * block turns ON, as when the mint changes after step 1. A failed-launch panel (Retry / bond "Try again") is what calls
 * retry() / launch(); neither may reach create() for a stablecoin with no slab. A launch that already has a slab continues.
 * Scaffold: create-market-stablecoin-blocked.test.tsx.
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

// The wizard reads the wallet's collateral balance for the seed check (lib/create-seed-check.ts); a funded wallet here.
vi.mock("@/hooks/useCollateralBalance", () => ({ useCollateralBalance: () => ({ balance: 10n ** 15n, readFailed: false, retry: () => {} }) }));
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
const seam = vi.hoisted(() => ({ force: null as boolean | null }));
vi.mock("@/lib/v22/stablecoin-perps", async (orig) => {
  const actual = await orig<typeof import("@/lib/v22/stablecoin-perps")>();
  return { ...actual, isStablecoinPerpBlocked: (ca: string) => (seam.force === null ? actual.isStablecoinPerpBlocked(ca) : seam.force) };
});
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
import { bondNeedsSingleTxMessage } from "@/lib/v22/launch-wire";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";

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



async function reachLaunchStep(mint: string) {
  MINT = mint;
  G.__gateMeta = deferred();
  view = render(<CreateMarketWizard />);
  fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: mint } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  G.__gateMeta.release(); await flush();
  gateDex.release(); gateResolve.release(); await flush();
  await waitFor(() => expect(onStep2()).toBe(true));
  await act(async () => { fireEvent.click(screen.getByTestId("growth-launch-toggle")); });
  await flush();
}

async function showPanel(state: typeof IDLE & { error: string | null }) {
  createState = state;
  await act(async () => { view!.rerender(<CreateMarketWizard />); });
  await flush();
}

describe("v2.2: launch()/retry() backstop for stablecoin launches", () => {
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
    create.mockReset(); localStorage.clear(); sessionStorage.clear(); createState = IDLE; seam.force = false;
    gateResolve = deferred(); gateDex = deferred(); dexPairs = DEXSCREENER_BODY.pairs;
    view?.unmount(); view = null;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });
  afterAll(() => { seam.force = null; });

  const retryBtn = () => screen.queryByTestId("wizard-retry") as HTMLButtonElement | null;
  const FAILED = { ...IDLE, error: "boom" };

  it("control: with the block off, Retry at step 0 reaches create()", async () => {
    await reachLaunchStep(USDC);
    await showPanel(FAILED);
    expect(retryBtn()).not.toBeNull();
    await act(async () => { fireEvent.click(retryBtn()!); });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retry(): a stablecoin with no slab yet is a NEW launch and never reaches create(); says why", async () => {
    await reachLaunchStep(USDC);
    seam.force = true;
    await showPanel(FAILED);
    expect(retryBtn()).not.toBeNull();
    await act(async () => { fireEvent.click(retryBtn()!); });
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByTestId("retry-blocked-note").textContent).toMatch(/stablecoin/i);
  });

  it("retry(): a launch that already has a slab continues (its market exists)", async () => {
    await reachLaunchStep(USDC);
    seam.force = true;
    await showPanel({ ...IDLE, step: 3, error: "boom", slabAddress: "GRMMNsNPM1GbgxFh3S34f3jvUX6jPbPiH3oxopnDFiWM" });
    await act(async () => { fireEvent.click(retryBtn()!); });
    expect(screen.queryByTestId("retry-blocked-note")?.textContent ?? "").not.toMatch(/stablecoin/i);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("launch(): the bond Try again (a fresh launch) never reaches create() for a stablecoin", async () => {
    await reachLaunchStep(USDC);
    seam.force = true;
    await showPanel({ ...IDLE, error: bondNeedsSingleTxMessage });
    const again = screen.getByRole("button", { name: /try again/i });
    await act(async () => { fireEvent.click(again); });
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByTestId("retry-blocked-note").textContent).toMatch(/stablecoin/i);
  });
});
