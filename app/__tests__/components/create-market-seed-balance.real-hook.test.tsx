/**
 * R10 (Council r9 creator, low): the wizard showed seed 3,100 USDC, wallet 400, and HOLD TO LAUNCH was enabled with no
 * warning. The launch tops a short wallet up itself (/api/devnet-pre-fund), so: short + top-up available = HOLD on with a
 * plain note; short + top-up can't be confirmed = HOLD on, the note says so; short + top-up known unavailable = HOLD off
 * with "You need N USDC to seed this market; your wallet has M." (+ the faucet link only if /faucet would allow a claim);
 * balance unread / unreadable = HOLD off (with Retry); funded = HOLD on.
 * Same real-wizard harness as create-market-live-price-limit.real-hook.test.tsx.
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
const capCalls: { url: string; headers: Record<string, string> }[] = [];

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
  if (url.startsWith("/api/devnet-pre-fund?")) {
    const gp = globalThis as { __preFund?: { status: number; body: unknown } | "throw" };
    if (gp.__preFund === "throw") throw new Error("offline");
    return json(gp.__preFund?.body ?? { known: true, preFund: { available: true, nextClaimAt: null }, faucet: null }, gp.__preFund?.status ?? 200);
  }
  if (url === "/api/dex/classify-pools") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { addresses?: string[] };
    return json({ classes: Object.fromEntries((body.addresses ?? []).map((a) => [a, "meteora-dlmm"])) });
  }
  if (url.startsWith("/api/playground/keeper-capacity")) {
    const g = globalThis as { __cap?: { status: number; body: unknown } | "throw" };
    capCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (g.__cap === "throw") throw new Error("offline");
    return json(g.__cap?.body ?? {}, g.__cap?.status ?? 200);
  }
  return json({ error: "not mocked" }, 404);
}) as typeof fetch;

// The wizard reads the wallet's collateral balance for the seed check (lib/create-seed-check.ts); a funded wallet here.
const bal = vi.hoisted(() => ({ balance: 10n ** 15n as bigint | null, readFailed: false, retry: vi.fn() }));
vi.mock("@/hooks/useCollateralBalance", () => ({ useCollateralBalance: () => bal }));
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
import { PrivySessionHeadersContext } from "@/hooks/usePrivySafe";

const SESSION = { Authorization: "Bearer access", "x-privy-id-token": "idtok" };
const WithPrivy = ({ children }: { children: React.ReactNode }) => (
  <PrivySessionHeadersContext.Provider value={async () => SESSION}>{children}</PrivySessionHeadersContext.Provider>
);

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const onStep2 = () => !!screen.queryByText(/STEP 2 \/ 2/);
// HoldToLaunch's button: the only rounded-full button; aria-label = disabledReason when disabled.
const launchBtn = () =>
  screen.getAllByRole("button").find((b) => b.className.includes("rounded-full") && b.hasAttribute("aria-label")) as HTMLButtonElement;


async function reachStep2(withPrivy = true) {
  const g = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
  g.__gateMeta = deferred();
  const utils = render(withPrivy ? <WithPrivy><CreateMarketWizard /></WithPrivy> : <CreateMarketWizard />);
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



describe("seed balance check in the wizard", () => {
  const setPreFund = (v: { status: number; body: unknown } | "throw" | undefined) => { (globalThis as { __preFund?: unknown }).__preFund = v; };
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear();
    fetchLog.length = 0; gateResolve = deferred(); gateDex = deferred();
    g0.__lamports = 100e9;
    createState = IDLE;
    setPreFund(undefined);
    bal.balance = 10n ** 15n; bal.readFailed = false; bal.retry.mockReset();
    (globalThis as { __noWallet?: boolean }).__noWallet = false;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });
  afterEach(() => { g0.__lamports = undefined; setPreFund(undefined); });

  it("short, top-up available: HOLD stays on and the note says the launch adds the missing amount", async () => {
    bal.balance = 400_000_000n; // 400 USDC
    setPreFund({ status: 200, body: { known: true, preFund: { available: true, nextClaimAt: null }, faucet: { available: true, nextClaimAt: null } } });
    await reachStep2();
    await waitFor(() => expect(screen.getByTestId("seed-notice").textContent).toMatch(/Your wallet has 400 USDC\. The launch adds the missing [\d,]+ test USDC first\./));
    expect(launchBtn().disabled).toBe(false);
    expect(screen.getByTestId("seed-notice").querySelector("a")).toBeNull();
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("short, top-up can't be confirmed (status read fails): HOLD stays on, the note says it can't confirm", async () => {
    bal.balance = 400_000_000n;
    setPreFund("throw");
    await reachStep2();
    await waitFor(() => expect(screen.getByTestId("seed-notice").textContent).toMatch(/can't confirm/));
    expect(launchBtn().disabled).toBe(false);
  });

  it("short, top-up known unavailable (1 h window): HOLD off, shortfall line, faucet link when /faucet would allow a claim", async () => {
    bal.balance = 400_000_000n;
    setPreFund({ status: 200, body: { known: true, preFund: { available: false, nextClaimAt: "2099-01-01T00:00:00Z" }, faucet: { available: true, nextClaimAt: null } } });
    await reachStep2();
    await waitFor(() => expect(launchBtn().disabled).toBe(true));
    expect(launchBtn().getAttribute("aria-label")).toBe("Not enough USDC to seed");
    const note = screen.getByTestId("seed-notice");
    expect(note.textContent).toMatch(/You need [\d,]+ USDC to seed this market; your wallet has 400\./);
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/faucet");
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it("short, top-up unavailable and /faucet also refuses: no faucet link", async () => {
    bal.balance = 400_000_000n;
    setPreFund({ status: 200, body: { known: true, preFund: { available: false, nextClaimAt: null }, faucet: { available: false, nextClaimAt: "2099-01-01T00:00:00Z" } } });
    await reachStep2();
    await waitFor(() => expect(launchBtn().disabled).toBe(true));
    expect(screen.getByTestId("seed-notice").querySelector("a")).toBeNull();
  });

  it("balance still being read: HOLD is off and says so", async () => {
    bal.balance = null;
    await reachStep2();
    await waitFor(() => expect(launchBtn().disabled).toBe(true));
    expect(screen.getByTestId("seed-notice").textContent).toMatch(/Checking your wallet balance/);
  });

  it("balance could not be read: HOLD stays off (not silently on), with Retry", async () => {
    bal.balance = null; bal.readFailed = true;
    await reachStep2();
    await waitFor(() => expect(launchBtn().disabled).toBe(true));
    expect(screen.getByTestId("seed-notice").textContent).toMatch(/Could not read your wallet balance/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(bal.retry).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a funded wallet gets an enabled HOLD, no notice, and never asks the top-up status", async () => {
    await reachStep2();
    await flush();
    expect(launchBtn().disabled).toBe(false);
    expect(screen.queryByTestId("seed-notice")).toBeNull();
    expect(fetchLog.some((u) => u.startsWith("/api/devnet-pre-fund"))).toBe(false);
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
