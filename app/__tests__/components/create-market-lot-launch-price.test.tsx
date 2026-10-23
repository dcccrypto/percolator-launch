/**
 * #3610 (wizard): a v2.2 lot launch sends InitMarket the per-LOT price rounded once from the unrounded token price, on
 * BOTH InitMarket paths (handleLaunch and the Retry/Continue path). A $0.0000015 token is a lot of 10^7 at $15, never
 * the $20 the whole-e6-rounded price (2 e6) gave.
 *
 * Renders the real CreateMarketWizard (scaffold from create-market-dial-reset.test.tsx): only I/O is faked. Flags are pinned
 * on for this file (v2.1 growth block, P3 wizard, v2.2, lot markets), whatever mode the suite runs in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";

const MINT = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const MINT_2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
    baseToken: { address: MINT, name: "e/acc", symbol: "e/acc" },
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
    return json({ ...DEXSCREENER_BODY, pairs: dexPairs });
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

const G = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
let view: ReturnType<typeof render> | null = null;

async function paste() {
  G.__gateMeta = deferred();
  view = render(<CreateMarketWizard />);
  fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  G.__gateMeta.release(); await flush();
}
const sent = (p: { initialPriceE6: bigint; v22?: { lotExp: number } }) => ({ initialPriceE6: p.initialPriceE6, lotExp: p.v22?.lotExp });

describe("v2.2 lot launch price reaches InitMarket unrounded (#3610)", () => {
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
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  it("launch and retry both send $15 per lot of 10^7 for a $0.0000015 token", async () => {
    await paste();
    gateDex.release(); gateResolve.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    await act(async () => { fireEvent.click(screen.getByTestId("growth-launch-toggle")); });
    await flush();
    expect(launchBtn().disabled, launchBtn().getAttribute("aria-label") ?? "").toBe(false);
    await act(async () => { fireEvent.mouseDown(launchBtn()); }); await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sent(create.mock.calls[0][0])).toEqual({ initialPriceE6: 15_000_000n, lotExp: 7 });
    // Retry (the second InitMarket path) sends the same per-lot price.
    createState = { ...IDLE, step: 1, error: "blockhash expired", slabAddress: POOL };
    view!.rerender(<CreateMarketWizard />); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Continue$/i })); }); await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(sent(create.mock.calls[1][0])).toEqual({ initialPriceE6: 15_000_000n, lotExp: 7 });
  });
});
