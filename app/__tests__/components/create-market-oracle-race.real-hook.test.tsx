/**
 * #2582: the create-market wizard must never launch a pool-backed token as an
 * admin-oracle market because /api/oracle/resolve landed after step 1.
 *
 * Renders the real CreateMarketWizard, useQuickLaunch, useDexPoolSearch,
 * StepTokenSelect and StepControlRoom/HoldToLaunch. Only I/O is faked: global
 * fetch (DexScreener + /api/oracle/resolve), fetchTokenMeta, wallet/connection,
 * useCreateMarket (spy), stuck slabs, duplicate-market lookup, next/navigation.
 *
 * Ordering is controlled with deferred promises:
 *  - control: resolve lands first, then the DexScreener scan (which is what
 *    lets auto-advance fire).
 *  - race: DexScreener lands, the wizard auto-advances, then resolve lands.
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

// The wizard reads the wallet's collateral balance for the seed check (lib/create-seed-check.ts); a funded wallet here.
vi.mock("@/hooks/useCollateralBalance", () => ({ useCollateralBalance: () => ({ balance: 10n ** 15n, readFailed: false, retry: () => {} }) }));
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

const connection = {
  rpcEndpoint: "https://api.devnet.solana.com",
  getBalance: async () => 100e9,
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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const onStep2 = () => !!screen.queryByText(/STEP 2 \/ 2/);
// HoldToLaunch's button: the only rounded-full button; aria-label = disabledReason when disabled.
const launchBtn = () =>
  screen.getAllByRole("button").find((b) => b.className.includes("rounded-full") && b.hasAttribute("aria-label")) as HTMLButtonElement;

function snapshot(tag: string) {
  const btn = launchBtn();
  const feed = screen.getByText("Price feed").parentElement?.textContent?.replace("Price feed", "") ?? "?";
  const s = { tag, step2: onStep2(), priceFeed: feed, disabled: btn?.disabled, ariaLabel: btn?.getAttribute("aria-label") };
  process.stdout.write(JSON.stringify(s) + "\n");
  return s;
}

type Order = "control" | "race" | "race-pools-before-meta";

async function run(order: Order) {
  const g = globalThis as { __gateMeta?: ReturnType<typeof deferred> };
  g.__gateMeta = deferred();
  render(<CreateMarketWizard />);
  // Paste the mint into the REAL StepTokenSelect input (400ms debounce inside).
  fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
  await flush();
  expect(fetchLog.some((u) => u.includes("dexscreener"))).toBe(true);

  if (order === "race-pools-before-meta") {
    // DexScreener answers before token metadata does, so config's FIRST value
    // already carries the pool price and auto-advance fires in that same commit.
    gateDex.release(); await flush();
    expect(onStep2()).toBe(false);
  }
  g.__gateMeta.release(); await flush();
  await waitFor(() => expect(fetchLog.some((u) => u.includes("/api/oracle/resolve/"))).toBe(true));

  if (order === "control") {
    expect(onStep2()).toBe(false);
    gateResolve.release(); await flush();
    expect(onStep2()).toBe(false); // advance still waiting on the pool scan
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
  } else {
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true)); // auto-advanced BEFORE resolve landed
    snapshot(`${order}: advanced, resolve pending`);
    gateResolve.release(); await flush();
  }
  snapshot(`${order}: resolve landed`);
  await act(async () => { fireEvent.mouseDown(launchBtn()); });
  await flush();
  const p = create.mock.calls[0]?.[0];
  const params = p && {
    oracleMode: p.oracleMode, dexPoolAddress: p.dexPoolAddress, dexType: p.dexType,
    initialPriceE6: String(p.initialPriceE6),
  };
  process.stdout.write(`CREATE ${order} ${JSON.stringify(params ?? null)}\n`);
  return params;
}

describe("oracle resolve vs auto-advance, real hooks", () => {
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear();
    fetchLog.length = 0; gateResolve = deferred(); gateDex = deferred();
    // reduced motion => HoldToLaunch fires on press, no rAF hold needed
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  // Every case asserts the CORRECT outcome (keeper market on its pool); a failure is the bug.
  it.each<Order>(["control", "race", "race-pools-before-meta"])("%s -> keeper market", async (order) => {
    const params = await run(order);
    expect(params?.oracleMode).toBe("keeper");
    expect(params?.dexPoolAddress).toBe(POOL);
  });
});

// Edge cases of the #2582 fix: the launch must wait for the lookup, say why,
// and never fall back to an admin market on a pool-backed or unknown token.
describe("oracle resolve lands after the advance: edge cases", () => {
  const g = globalThis as {
    __gateMeta?: ReturnType<typeof deferred>;
    __resolveReply?: () => Response;
    __network?: string;
    __failMetaCall?: number;
    __metaCalls?: number;
  };
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear();
    fetchLog.length = 0; gateResolve = deferred(); gateDex = deferred();
    delete g.__resolveReply; delete g.__network; delete g.__failMetaCall; g.__metaCalls = 0;
    createState = IDLE;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  /** Paste, let meta + pools land, auto-advance; the resolve is still gated. */
  async function advanceWithResolvePending() {
    g.__gateMeta = deferred();
    const view = render(<CreateMarketWizard />);
    fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    g.__gateMeta.release(); await flush();
    gateDex.release(); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    const s = snapshot("pending");
    expect(s.disabled).toBe(true);
    expect(s.ariaLabel).toBe("Resolving price feed");
    expect(s.priceFeed).toBe("Resolving…");
    return view;
  }
  async function pressLaunch() {
    await act(async () => { fireEvent.mouseDown(launchBtn()); });
    await flush();
  }

  it("resolve fails: stays blocked and never launches admin", async () => {
    g.__resolveReply = () => json({ error: "upstream" }, 503);
    await advanceWithResolvePending();
    gateResolve.release(); await flush();
    const s = snapshot("failed");
    expect(s.disabled).toBe(true);
    expect(s.ariaLabel).toMatch(/pool type we can't price yet/);
    await pressLaunch();
    expect(create).not.toHaveBeenCalled();
  });

  it("resolve finds no supported pool: blocked with the no-pool message", async () => {
    g.__resolveReply = () => json({ ...RESOLVE_BODY, dexPoolAddress: null, dexType: null, oracleMode: "admin" });
    await advanceWithResolvePending();
    gateResolve.release(); await flush();
    const s = snapshot("no pool");
    expect(s.disabled).toBe(true);
    expect(s.ariaLabel).toMatch(/pool type we can't price yet/);
    await pressLaunch();
    expect(create).not.toHaveBeenCalled();
  });

  it("the oracle sync writes only oracle fields: a dial turned while resolving is kept", async () => {
    await advanceWithResolvePending();
    const dial = screen.getByRole("slider", { name: "Insurance" });
    const before = Number(dial.getAttribute("aria-valuenow"));
    fireEvent.keyDown(dial, { key: "ArrowUp" });
    const after = Number(screen.getByRole("slider", { name: "Insurance" }).getAttribute("aria-valuenow"));
    expect(after).toBeGreaterThan(before);
    gateResolve.release(); await flush();
    await pressLaunch();
    const p = create.mock.calls[0]?.[0];
    expect(p?.oracleMode).toBe("keeper");
    expect(p?.dexPoolAddress).toBe(POOL);
    expect(p?.insuranceAmount).toBe(BigInt(after) * 1_000_000n);
  });

  it("retry after a failed step re-sends the same keeper oracle and pool", async () => {
    const view = await advanceWithResolvePending();
    gateResolve.release(); await flush();
    await pressLaunch();
    expect(create).toHaveBeenCalledTimes(1);
    createState = { ...IDLE, step: 1, error: "Block height exceeded", slabAddress: SystemProgram.programId.toBase58() };
    view.rerender(<CreateMarketWizard />); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Continue$/i })); });
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    for (const [p] of create.mock.calls) {
      expect(p.oracleMode).toBe("keeper");
      expect(p.dexPoolAddress).toBe(POOL);
      expect(p.dexType).toBe("meteora-dlmm");
    }
  });

  it("Continue before the pool scan: the pool that lands afterwards is what launches", async () => {
    g.__gateMeta = deferred();
    render(<CreateMarketWizard />);
    fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    g.__gateMeta.release(); await flush();
    gateResolve.release(); await flush();
    expect(onStep2()).toBe(false); // pool scan still pending, so no auto-advance
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    gateDex.release(); await flush();
    await pressLaunch();
    const p = create.mock.calls[0]?.[0];
    expect(p?.oracleMode).toBe("keeper");
    expect(p?.dexPoolAddress).toBe(POOL);
    expect(p?.dexType).toBe("meteora-dlmm");
  });

  it("a failed token-meta fetch in useQuickLaunch shows the error, not a permanent 'Resolving'", async () => {
    g.__failMetaCall = 2;
    g.__gateMeta = deferred();
    render(<CreateMarketWizard />);
    fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    g.__gateMeta.release(); gateDex.release(); gateResolve.release(); await flush(); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    await flush();
    const s = snapshot("meta failed");
    expect(s.disabled).toBe(true);
    expect(s.ariaLabel).toBe("rpc 429");
    expect(s.priceFeed).not.toBe("Resolving…");
  });

  it("Back then Continue after the resolve lands still launches the keeper market", async () => {
    await advanceWithResolvePending();
    gateResolve.release(); await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /back/i })); });
    await flush();
    expect(onStep2()).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /continue/i })); });
    await waitFor(() => expect(onStep2()).toBe(true));
    await pressLaunch();
    const p = create.mock.calls[0]?.[0];
    expect(p?.oracleMode).toBe("keeper");
    expect(p?.dexPoolAddress).toBe(POOL);
  });

  it("no Pyth (2026-10-01): a stray feed id that lands after the advance is NOT adopted", async () => {
    g.__network = "mainnet";
    const FEED = "ab".repeat(32);
    g.__resolveReply = () => json({ ...RESOLVE_BODY, feedId: FEED, dexPoolAddress: null, oracleMode: "pyth" });
    await advanceWithResolvePending();
    gateResolve.release(); await flush();
    const s = snapshot("mainnet stray feed");
    // The wizard never takes a Pyth feed any more (the resolver no longer returns one; a stray
    // id is ignored): with no DEX pool it stays on the admin placeholder.
    expect(s.priceFeed).not.toBe(`${FEED.slice(0, 12)}...`);
    expect(s.ariaLabel).not.toBe("Resolving price feed");
  });
});

// Live report 2026-10-01: with no wallet a user could paste a CA and Continue to the final step.
describe("leaving step 1 needs a connected wallet", () => {
  const g = globalThis as { __gateMeta?: ReturnType<typeof deferred>; __noWallet?: boolean };
  beforeEach(() => {
    create.mockReset(); localStorage.clear(); sessionStorage.clear();
    fetchLog.length = 0; gateResolve = deferred(); gateDex = deferred();
    createState = IDLE;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });
  afterEach(() => { delete g.__noWallet; });

  it("no wallet: the token resolves but the wizard stays on step 1 with a connect CTA, then advances once connected", async () => {
    g.__noWallet = true;
    g.__gateMeta = deferred();
    const view = render(<CreateMarketWizard />);
    fireEvent.change(screen.getByPlaceholderText("Paste mint address..."), { target: { value: MINT } });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    g.__gateMeta.release(); await flush();
    gateResolve.release(); await flush();
    gateDex.release(); await flush();
    // Every gate that used to auto-advance has settled: still step 1, no Continue, the CTA instead.
    expect(onStep2()).toBe(false);
    expect(screen.queryByTestId("wizard-next")).toBeNull();
    expect(screen.getByTestId("wizard-connect-wallet")).toBeTruthy();

    // The user connects: the one-shot auto-advance fires now.
    g.__noWallet = false;
    view.rerender(<CreateMarketWizard />); await flush();
    await waitFor(() => expect(onStep2()).toBe(true));
    expect(screen.queryByTestId("wizard-connect-wallet")).toBeNull();
  });
});
