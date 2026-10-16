/**
 * #3267 re-review, wizard level: a wallet switch during a chain resume aborts the running create() BEFORE
 * resetting, and a Retry refused by the chain-resume gate says why in the launch-progress view.
 *
 * Same real-wizard harness as create-market-oracle-race.real-hook (only I/O is
 * faked); the wallet balance is mutable through globalThis.__lamports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { PublicKey, SystemProgram } from "@solana/web3.js";

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
  useWalletCompat: () => (globalThis as { __wallet?: unknown }).__wallet,
  useConnectionCompat: () => ({ connection }),
}));

const WALLET_A = { publicKey: SystemProgram.programId, connected: true };
const WALLET_B = { publicKey: new PublicKey("DrrDGxiojUPHnLZaNw7DN6JYoEKKqu3bG4PmNjv8P1yG"), connected: true };
(globalThis as { __wallet?: unknown }).__wallet = WALLET_A;
const create = vi.fn();
const order: string[] = [];
const cancelInFlightLaunch = vi.fn(() => order.push("cancel"));
const resetSpy = vi.fn(() => order.push("reset"));
const restoreSlabAddress = vi.fn();
const clearChainResume = vi.fn();
const IDLE = { step: 0, loading: false, error: null as string | null, stepErrors: {}, txSigs: [], slabAddress: null as string | null };
let createState = IDLE;
vi.mock("@/hooks/useCreateMarket", async (orig) => ({
  ...(await orig<object>()),
  useCreateMarket: () => ({
    state: createState,
    create, reset: resetSpy, restoreSlabKeypair: vi.fn(), restoreSlabAddress, clearChainResume, cancelInFlightLaunch, retryKeeperRegistration: vi.fn(),
  }),
}));
const SLAB_Y = "GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL";
// the card is covered by its own test; here it only hands a verified launch to the wizard
let verifiedCreator = SystemProgram.programId.toBase58();
vi.mock("@/components/create/ResumeFromChainCard", () => ({
  ResumeFromChainCard: ({ onVerified }: { onVerified: (l: unknown, step: number) => void }) => (
    <button data-testid="stub-verify" onClick={() => onVerified({ creator: verifiedCreator, request: { slabAddress: SLAB_Y, mainnetCA: MINT }, tradingFeeBps: 5, initialMarginBps: 1000, lpCollateralAtoms: 100_000_000n, maxPortfolioAssets: 14, symbol: "T", name: "t", poolAddress: "P", dexType: "meteora-dlmm", initialPriceE6: 1n }, 2)}>verify</button>
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


async function launchOnce(resume?: string, verifyFirst = false) {
  const g = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
  g.__gateMeta = deferred();
  const utils = render(<CreateMarketWizard resumeSlabParam={resume} />);
  if (verifyFirst) { fireEvent.click(screen.getByTestId("stub-verify")); await flush(); }
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

describe("chain resume lifecycle in the wizard", () => {
  beforeEach(() => {
    create.mockReset(); order.length = 0; cancelInFlightLaunch.mockClear(); resetSpy.mockClear(); restoreSlabAddress.mockClear();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    localStorage.clear(); sessionStorage.clear();
    fetchLog.length = 0; gateResolve = deferred(); gateDex = deferred();
    g0.__lamports = 100e9; createState = IDLE;
    (globalThis as { __wallet?: unknown }).__wallet = WALLET_A;
    verifiedCreator = SystemProgram.programId.toBase58();
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });
  afterEach(() => { createState = IDLE; (globalThis as { __wallet?: unknown }).__wallet = WALLET_A; });

  it("switching wallet during a chain resume aborts the running create() first, then resets", async () => {
    const { rerender } = await launchOnce(SLAB_Y);
    fireEvent.click(screen.getByTestId("stub-verify"));
    await flush();
    expect(restoreSlabAddress).toHaveBeenCalledWith(SLAB_Y);
    expect(cancelInFlightLaunch).not.toHaveBeenCalled();
    order.length = 0;
    (globalThis as { __wallet?: unknown }).__wallet = WALLET_B;
    rerender(<CreateMarketWizard resumeSlabParam={SLAB_Y} />);
    await flush();
    expect(order).toEqual(["cancel", "reset"]);
  });

  it("CONTROL: a wallet switch with no chain resume aborts nothing", async () => {
    const { rerender } = render(<CreateMarketWizard />);
    await flush();
    (globalThis as { __wallet?: unknown }).__wallet = WALLET_B;
    rerender(<CreateMarketWizard />);
    await flush();
    expect(cancelInFlightLaunch).not.toHaveBeenCalled();
  });
});
