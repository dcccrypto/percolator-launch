/**
 * #3377: a same-browser RESUME (RecoverSolBanner) signs and registers with the launch's own parameters,
 * not the live form's. Same real-wizard harness as create-market-oracle-race.real-hook (only I/O is
 * faked); the wallet balance is mutable through globalThis.__lamports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";

const MINT = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const POOL = "HC7ArykAUSamJSAJ1aYLrS8aAamvBb1JvqMf1woUtnKo";

const RESOLVE_BODY = {
  feedId: null, symbol: "e/acc", price: 0.0124, source: "dexscreener",
  dexPoolAddress: POOL, dexType: "meteora-dlmm", oracleMode: "hyperp", cached: true,
};
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
const fetchLog: string[] = [];

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  fetchLog.push(url);
  if (url.startsWith("https://api.dexscreener.com/latest/dex/tokens/")) {
    await gateDex.p;
    return json(DEXSCREENER_BODY);
  }
  if (url.includes("/api/oracle/resolve/")) {
    await gateResolve.p;
    const g = globalThis as { __resolveReply?: () => Response };
    return g.__resolveReply ? g.__resolveReply() : json(RESOLVE_BODY);
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
    const gg = globalThis as { __failMetaCall?: number; __metaCalls?: number };
    gg.__metaCalls = (gg.__metaCalls ?? 0) + 1;
    if (gg.__failMetaCall === gg.__metaCalls) throw new Error("rpc 429");
    return { name: "e/acc", symbol: "e/acc", decimals: 6 };
  }),
}));

const g0 = globalThis as { __lamports?: number };
const connection = {
  rpcEndpoint: "https://api.devnet.solana.com",
  getBalance: async () => g0.__lamports ?? 100e9,
  getAccountInfo: async () => null,
};
vi.mock("@/hooks/useWalletCompat", () => ({
  // `__noWallet` models a visitor who has not connected (the wallet gate on leaving step 1).
  useWalletCompat: () =>
    (globalThis as { __noWallet?: boolean }).__noWallet
      ? { publicKey: null, connected: false }
      : { publicKey: SystemProgram.programId, connected: true },
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
vi.mock("@/lib/launch-recovery", async (orig) => ({
  ...(await orig<object>()),
  // The chain read of InitMarket's initial_margin_bps (null = unreadable); the pin logic itself is real.
  readInitialMarginBps: vi.fn(async () => (globalThis as { __chainMargin?: number | null }).__chainMargin ?? null),
}));
vi.mock("@/components/create/RecoverSolBanner", () => ({
  RecoverSolBanner: (p: { onResume?: (slab: string, step: number) => void }) => (
    <button data-testid="resume-btn" onClick={() => p.onResume?.((globalThis as { __slab?: string }).__slab ?? "", (globalThis as { __fromStep?: number }).__fromStep ?? 2)}>RESUME</button>
  ),
}));
vi.mock("@/hooks/useStuckSlabs", () => ({ useStuckSlabs: () => ({ stuckSlab: null, stuckSlabs: [] }) }));
vi.mock("@/hooks/useDuplicateMarket", () => ({
  useDuplicateMarket: () => ({ checking: false, duplicates: [] }),
}));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getNetwork: () => (globalThis as { __network?: string }).__network ?? "devnet" }));
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


async function launchOnce() {
  const g = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
  g.__gateMeta = deferred();
  const utils = render(<CreateMarketWizard />);
  fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  await flush();
  g.__gateMeta.release(); await flush();
  gateResolve.release(); await flush();
  gateDex.release(); await flush();
  await waitFor(() => expect(onStep2()).toBe(true));
  await flush();
  return utils;
}

/** The wallet's balance changes and the tab regains focus (pollWhenVisible re-reads). */
async function balanceBecomes(sol: number) {
  g0.__lamports = sol * 1e9;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await flush();
}


const SLAB = "7YttLkHDoNj9wDbjdtzpXUp9ufJDGNYTx3rW3jgN5VBw";
const PIN_POOL = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
const PIN_CA = "So11111111111111111111111111111111111111112";
const seedLaunch = (o: { payload?: boolean; request?: boolean } = {}) => {
  localStorage.setItem(`perc.keeperProofTx.${SLAB}`, "proofSig");
  if (o.payload !== false) {
    localStorage.setItem(`perc.keeperPayload.${SLAB}`, JSON.stringify({
      slab_address: SLAB, deployer: SystemProgram.programId.toBase58(), symbol: "PINNED", name: "pinned token", dex_pool_address: PIN_POOL,
      mainnet_ca: PIN_CA, initial_price_e6: "123456", max_leverage: 6.5, trading_fee_bps: 77, lp_collateral: "1500000000",
    }));
  }
  if (o.request !== false) {
    localStorage.setItem(`perc.keeperRequest.${SLAB}`, JSON.stringify({ slabAddress: SLAB, mainnetCA: PIN_CA, dexPoolAddress: PIN_POOL, dexType: "raydium-clmm", symbol: "PINNED" }));
  }
};
const lastParams = () => create.mock.calls[create.mock.calls.length - 1][0] as Record<string, unknown>;

describe("same-browser resume pins the launch's parameters (#3377)", () => {
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    fetchLog.length = 0; gateResolve = deferred(); gateDex = deferred();
    g0.__lamports = 100e9; createState = IDLE;
    const g = globalThis as { __slab?: string; __fromStep?: number; __noWallet?: boolean };
    g.__slab = SLAB; g.__fromStep = 2; (globalThis as { __chainMargin?: number | null }).__chainMargin = 1538; g.__noWallet = false;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  it("a resumed launch signs the saved fee/price/LP/pool/symbol/CA/dex type, not the re-detected ones", async () => {
    seedLaunch();
    await launchOnce();
    await act(async () => { fireEvent.click(screen.getByTestId("resume-btn")); });
    await flush();
    await flush();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    const p = lastParams();
    expect(create.mock.calls[0][1]).toBe(2);
    expect(p).toMatchObject({
      initialPriceE6: 123456n, initialMarginBps: 1538, tradingFeeBps: 77, lpCollateral: 1_500_000_000n, dexPoolAddress: PIN_POOL, dexType: "raydium-clmm",
      symbol: "PINNED", name: "pinned token", mainnetCA: PIN_CA, oracleMode: "keeper",
    });
  });

  it("the detection effect does not overwrite the pinned fee and LP in the form", async () => {
    seedLaunch();
    const g = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
    g.__gateMeta = deferred();
    render(<CreateMarketWizard />);
    // Resume BEFORE detection lands; detection then resolves under the resumed wizard.
    await act(async () => { fireEvent.click(screen.getByTestId("resume-btn")); });
    await flush();
    fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    g.__gateMeta.release(); await flush();
    gateResolve.release(); await flush();
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    await flush();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(lastParams()).toMatchObject({ tradingFeeBps: 77, lpCollateral: 1_500_000_000n, dexPoolAddress: PIN_POOL });
    expect(document.body.textContent).toMatch(/1,500\+?Liquidity/);
  });

  it("Retry after a failed resumed step keeps the pinned values", async () => {
    seedLaunch();
    const { rerender } = await launchOnce();
    await act(async () => { fireEvent.click(screen.getByTestId("resume-btn")); });
    await flush();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    createState = { ...IDLE, step: 2, error: "Transaction failed", slabAddress: SLAB };
    rerender(<CreateMarketWizard />);
    await flush();
    fireEvent.click(screen.getByTestId("wizard-retry"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(lastParams()).toMatchObject({ tradingFeeBps: 77, dexPoolAddress: PIN_POOL, dexType: "raydium-clmm", symbol: "PINNED", mainnetCA: PIN_CA });
  });

  it("FAIL SAFE: no proof payload on this browser -> refuses with a one-line message, signs nothing", async () => {
    seedLaunch({ payload: false });
    await launchOnce();
    await act(async () => { fireEvent.click(screen.getByTestId("resume-btn")); });
    await flush();
    await flush();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/can't be resumed safely from here/);
  });

  it("FAIL SAFE: an unreadable on-chain margin refuses and signs nothing", async () => {
    seedLaunch();
    (globalThis as { __chainMargin?: number | null }).__chainMargin = null;
    await launchOnce();
    await act(async () => { fireEvent.click(screen.getByTestId("resume-btn")); });
    await flush();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/can't be resumed safely from here/);
  });

  it("a NON-resumed launch is unchanged: it signs the live form's values", async () => {
    seedLaunch(); // records exist for the slab, but no resume was taken
    await launchOnce();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toBeUndefined();
    const p = lastParams();
    expect(p.dexPoolAddress).toBe(POOL);
    expect(p.symbol).not.toBe("PINNED");
    expect(p.tradingFeeBps).not.toBe(77);
  });

  it("resuming from step 0 is left to the live form (nothing was signed yet)", async () => {
    seedLaunch();
    (globalThis as { __fromStep?: number }).__fromStep = 0;
    await launchOnce();
    await act(async () => { fireEvent.click(screen.getByTestId("resume-btn")); });
    await flush();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(lastParams().dexPoolAddress).toBe(POOL);
  });
});
