/**
 * #2588: a Leverage or Liquidity dial the user turned on step 2 must not snap
 * back to the auto-detected default when a detection result lands late: the
 * /api/oracle/resolve price, or the DexScreener pool scan after a manual
 * Continue. The late price must still reach the launch, and a new token must
 * still get its own defaults.
 *
 * Renders the real CreateMarketWizard, useQuickLaunch, useDexPoolSearch,
 * StepTokenSelect and StepControlRoom/RotaryDial/HoldToLaunch. Only I/O is
 * faked: global fetch (DexScreener + /api/oracle/resolve), fetchTokenMeta,
 * wallet/connection, useCreateMarket (spy), stuck slabs, duplicate-market
 * lookup, next/navigation. Fetch ordering is controlled with deferred promises.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";

const MINT = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const MINT_2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL = "HC7ArykAUSamJSAJ1aYLrS8aAamvBb1JvqMf1woUtnKo";

const RESOLVE_BODY = {
  feedId: null, symbol: "e/acc", price: 0.0124, source: "dexscreener",
  dexPoolAddress: POOL, dexType: "meteora-dlmm", oracleMode: "hyperp", cached: true,
};
// $48k liquidity = the "medium" tier: 1500 bps, shown as 6.5x.
const DEXSCREENER_BODY = {
  schemaVersion: "1.0.0",
  pairs: [{
    chainId: "solana", dexId: "meteora", url: `https://dexscreener.com/solana/${POOL.toLowerCase()}`,
    pairAddress: POOL,
    baseToken: { address: MINT, name: "e/acc", symbol: "e/acc" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
    priceNative: "0.0000651", priceUsd: "0.0124",
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
    // The pair's base token is whichever mint was asked for (DexScreener lists a pair under its base mint).
    const asked = url.slice("https://api.dexscreener.com/latest/dex/tokens/".length);
    return json({ ...DEXSCREENER_BODY, pairs: (dexPairs as Array<{ baseToken: object }>).map((p) => ({ ...p, baseToken: { ...p.baseToken, address: asked } })) });
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

const G = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
let view: ReturnType<typeof render> | null = null;
const dial = (name: string) => screen.getByRole("slider", { name });
const shown = (name: string) => dial(name).getAttribute("aria-valuetext");

async function paste(mint = MINT) {
  G.__gateMeta = deferred();
  if (!screen.queryByPlaceholderText("Paste mint address...")) view = render(<CreateMarketWizard />);
  fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: mint } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  G.__gateMeta.release(); await flush();
}
async function launch() {
  await act(async () => { fireEvent.mouseDown(launchBtn()); });
  await flush();
  const p = create.mock.calls[0]?.[0];
  return p && { initialMarginBps: p.initialMarginBps, lpCollateral: String(p.lpCollateral) };
}
// Leverage: 6.5x -> 6x (1667 bps). Liquidity: 1,000 -> 1,100.
async function turn(name: string) {
  const before = shown(name);
  await act(async () => { fireEvent.keyDown(dial(name), { key: name === "Leverage" ? "ArrowDown" : "ArrowUp" }); });
  await flush();
  const after = shown(name);
  expect(after).not.toBe(before);
  return after;
}
const TURNED = {
  Leverage: { initialMarginBps: 1667, lpCollateral: "1000000000" },
  Liquidity: { initialMarginBps: 1538, lpCollateral: "1100000000" },
} as const;

describe("dial reset when a detection result lands on step 2 (#2588)", () => {
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear(); createState = IDLE;
    gateResolve = deferred(); gateDex = deferred(); dexPairs = DEXSCREENER_BODY.pairs;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  // Auto-advance with the resolve pending, turn a dial, let the resolve land.
  it.each(["Leverage", "Liquidity"] as const)("%s turned while the resolve is pending", async (name) => {
    await paste();
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    const turned = await turn(name);
    gateResolve.release(); await flush();
    expect(shown(name)).toBe(turned);
    // The late price still reaches the wizard: the launch is no longer waiting on it.
    expect(launchBtn().getAttribute("aria-label") ?? "").not.toMatch(/waiting on price feed/i);
    expect(await launch()).toEqual(TURNED[name]);
  });

  // No pool, so the step-2 launch waits on the resolve price (the #2552 hang path).
  it("a late resolve price still reaches the launch without resetting a dial", async () => {
    dexPairs = [];
    await paste();
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    // Pending window: the button is blocked on the missing price.
    expect(launchBtn().disabled).toBe(true);
    const turned = await turn("Leverage");
    gateResolve.release(); await flush();
    expect(shown("Leverage")).toBe(turned);
    expect(launchBtn().disabled).toBe(false);
    expect((await launch())?.initialMarginBps).toBe(2222); // low tier 5x -> 4.5x
  });

  // Control: the same change after the resolve has landed.
  it.each(["Leverage", "Liquidity"] as const)("%s turned after the resolve landed (control)", async (name) => {
    await paste();
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    gateResolve.release(); await flush();
    const turned = await turn(name);
    expect(shown(name)).toBe(turned);
    expect(await launch()).toEqual(TURNED[name]);
  });

  // Manual Continue before the pool scan lands, dial turned, then the pools land
  // and the config is rebuilt at a different tier.
  it.each(["Leverage", "Liquidity"] as const)("%s turned before the pools land (manual Continue)", async (name) => {
    await paste();
    gateResolve.release(); await flush();
    expect(onStep2()).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    const turned = await turn(name);
    gateDex.release(); await flush();
    expect(shown(name)).toBe(turned);
  });

  // Untouched dial on the same path follows the tier the pools justify.
  it("an untouched Leverage dial follows the tier when the pools land", async () => {
    await paste();
    gateResolve.release(); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    const beforePools = shown("Leverage");
    gateDex.release(); await flush();
    expect(shown("Leverage")).not.toBe(beforePools);
    expect(await launch()).toEqual({ initialMarginBps: 1538, lpCollateral: "1000000000" });
  });

  // A dial turned away and back to the default is still the user's choice.
  it("a dial turned back to its default is kept when the pools land", async () => {
    await paste();
    gateResolve.release(); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    const lowTier = shown("Leverage"); // 5x, built before the pool scan
    await turn("Leverage");
    await act(async () => { fireEvent.keyDown(dial("Leverage"), { key: "ArrowUp" }); });
    await flush();
    expect(shown("Leverage")).toBe(lowTier);
    gateDex.release(); await flush(); // medium tier would default to 6.5x
    expect(shown("Leverage")).toBe(lowTier);
    expect((await launch())?.initialMarginBps).toBe(2000);
  });

  // Start Over replaces the wizard state, so the next launch of the same token
  // starts from its defaults again rather than from DEFAULT_STATE's blanks.
  it("Start Over after a failed launch, same mint pasted again", async () => {
    await paste();
    gateDex.release(); gateResolve.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    const defaults = { lev: shown("Leverage"), liq: shown("Liquidity") };
    await turn("Leverage");
    await turn("Liquidity");
    createState = { ...IDLE, step: 1, error: "user rejected" };
    view!.rerender(<CreateMarketWizard />); await flush();
    await act(async () => { fireEvent.click(screen.getByText("Start Over")); });
    createState = IDLE;
    view!.rerender(<CreateMarketWizard />); await flush();
    await paste();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    expect({ lev: shown("Leverage"), liq: shown("Liquidity") }).toEqual(defaults);
    expect(launchBtn().disabled).toBe(false);
    expect(await launch()).toEqual({ initialMarginBps: 1538, lpCollateral: "1000000000" });
  });

  // Launch while the pool scan is still pending, the launch fails, then the scan
  // lands and rebuilds the config at a higher tier. Retry resumes the same market,
  // so it must send what the first attempt sent.
  it("Retry resends the failed launch's values when the pools land in between", async () => {
    const sentParams = (p: { initialMarginBps: number; tradingFeeBps: number; lpCollateral: bigint; initialPriceE6: bigint }) =>
      ({ initialMarginBps: p.initialMarginBps, tradingFeeBps: p.tradingFeeBps, lpCollateral: String(p.lpCollateral), initialPriceE6: String(p.initialPriceE6) });
    // The pool quotes a different price from the resolve route, so a price that
    // moved between the attempts would show up too.
    dexPairs = DEXSCREENER_BODY.pairs.map((p) => ({ ...p, priceUsd: "0.0131" }));
    await paste();
    gateResolve.release(); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    await act(async () => { fireEvent.mouseDown(launchBtn()); }); await flush();
    const first = sentParams(create.mock.calls[0][0]);
    expect(first).toMatchObject({ initialMarginBps: 2000, tradingFeeBps: 20, initialPriceE6: "12400" }); // low tier, resolve price
    createState = { ...IDLE, step: 2, error: "blockhash expired", slabAddress: POOL };
    view!.rerender(<CreateMarketWizard />); await flush();
    gateDex.release(); await flush(); // medium tier: 1538 bps, 10 bps fee
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Continue$/i })); }); await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(sentParams(create.mock.calls[1][0])).toEqual(first);
  });

  // A new token resets both dials to its own defaults.
  it("Back and a new mint re-apply the defaults", async () => {
    await paste();
    gateDex.release(); gateResolve.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    const defaults = { lev: shown("Leverage"), liq: shown("Liquidity") };
    await turn("Leverage");
    await turn("Liquidity");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /back to token/i })); });
    await waitFor(() => expect(onStep2()).toBe(false));
    await paste(MINT_2);
    // Auto-advance fires once per mount; the second token needs Continue.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    expect({ lev: shown("Leverage"), liq: shown("Liquidity") }).toEqual(defaults);
    expect(await launch()).toEqual({ initialMarginBps: 1538, lpCollateral: "1000000000" });
  });
});
