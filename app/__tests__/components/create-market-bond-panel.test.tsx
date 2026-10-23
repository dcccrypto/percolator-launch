/**
 * #3634 review L-2 + I-1: the wizard's capacity-bond wiring, rendered for real (scaffold from
 * create-market-lot-launch-price.test.tsx: the real CreateMarketWizard, only I/O faked). Until now it was covered by
 * source regexes only.
 *
 * - A bond-ticked launch is ONE fresh call (no step: the single-transaction path) carrying the bond.
 * - The bond refusal panel: Try again (same launch, fresh) and Launch without the bond (fresh, no bond, form unticked);
 *   no Continue (the step-by-step path).
 * - I-1: a resume past step 0 with the bond ticked. The hook refuses it (bondResumeMessage); the panel offers only
 *   "Continue without the bond", which resumes at the SAME step with no bond and unticks the form.
 * - I-2: the same for a resume AT step 0.
 *
 * Flags pinned on for this file (v2.1 growth block, P3 wizard, v2.2, lot markets), whatever mode the suite runs in.
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
const restoreSlabKeypair = vi.fn();
const IDLE = { step: 0, loading: false, error: null as string | null, stepErrors: {}, txSigs: [], slabAddress: null as string | null };
let createState = IDLE;
vi.mock("@/hooks/useCreateMarket", async (orig) => ({
  ...(await orig<object>()),
  useCreateMarket: () => ({
    state: createState,
    create, reset: vi.fn(), restoreSlabKeypair, retryKeeperRegistration: vi.fn(),
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

// The stuck-slab banner is a resume entry point: faked to "resume at step 3" and "resume at step 0" buttons (its own
// tests cover it).
const RESUME_SLAB = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
vi.mock("@/components/create/RecoverSolBanner", () => ({
  RecoverSolBanner: (p: { onResume: (slab: string, step: number) => void }) => (
    <>
      <button type="button" data-testid="fake-resume" onClick={() => p.onResume(RESUME_SLAB, 3)}>resume</button>
      <button type="button" data-testid="fake-resume-0" onClick={() => p.onResume(RESUME_SLAB, 0)}>resume at 0</button>
    </>
  ),
}));
// The same-browser pin for a launch that bound no keeper registration: nothing to pin.
vi.mock("@/lib/launch-recovery", async (orig) => ({
  ...(await orig<object>()),
  readInitialMarginBps: vi.fn(async () => 1500),
  pinSameBrowserResume: vi.fn(() => ({ ok: true, pin: null })),
}));

import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";
import { bondNeedsSingleTxMessage, bondResumeMessage } from "@/lib/v22/launch-wire";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const onStep2 = () => !!screen.queryByText(/STEP 2 \/ 2/);
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
/** Step 2 with the growth block on and the capacity bond ticked. */
async function formWithBond() {
  await paste();
  gateDex.release(); gateResolve.release(); await flush();
  await waitFor(() => expect(onStep2()).toBe(true));
  await act(async () => { fireEvent.click(screen.getByTestId("growth-launch-toggle")); });
  await flush();
  const bond = screen.getByTestId("v22-bond-toggle") as HTMLInputElement;
  expect(bond.checked).toBe(false);
  await act(async () => { fireEvent.click(bond); });
  await flush();
  expect((screen.getByTestId("v22-bond-toggle") as HTMLInputElement).checked).toBe(true);
  expect(launchBtn().disabled, launchBtn().getAttribute("aria-label") ?? "").toBe(false);
}
const rerender = async () => { view!.rerender(<CreateMarketWizard />); await flush(); };
type Sent = { v22?: { bond?: unknown } };
const call = (i: number) => ({ bond: (create.mock.calls[i][0] as Sent).v22?.bond !== undefined, step: create.mock.calls[i][1] as number | undefined });

describe("v2.2 capacity bond: the wizard's real wiring (#3634 L-2, I-1)", () => {
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
    // jsdom has no layout: the resume banner scrolls itself into view.
    Element.prototype.scrollIntoView = vi.fn();
    create.mockReset(); restoreSlabKeypair.mockReset(); localStorage.clear(); sessionStorage.clear(); createState = IDLE;
    gateResolve = deferred(); gateDex = deferred(); dexPairs = DEXSCREENER_BODY.pairs;
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, onchange: null,
    }));
  });

  it("a bond-ticked launch is one fresh call carrying the bond (the single-transaction path)", async () => {
    await formWithBond();
    await act(async () => { fireEvent.mouseDown(launchBtn()); }); await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(call(0)).toEqual({ bond: true, step: undefined });
  });

  it("the refusal panel: Try again is the same fresh launch; Launch without the bond drops it and unticks the form; no Continue", async () => {
    await formWithBond();
    await act(async () => { fireEvent.mouseDown(launchBtn()); }); await flush();
    createState = { ...IDLE, error: bondNeedsSingleTxMessage };
    await rerender();
    expect(screen.queryByTestId("wizard-retry")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("wizard-bond-try-again")); }); await flush();
    expect(call(1)).toEqual({ bond: true, step: undefined });
    // A new refusal re-arms the one-shot guard.
    createState = { ...IDLE, error: null }; await rerender();
    createState = { ...IDLE, error: bondNeedsSingleTxMessage }; await rerender();
    expect(screen.getByTestId("wizard-bond-launch-without").textContent).toBe("Launch without the bond");
    await act(async () => { fireEvent.click(screen.getByTestId("wizard-bond-launch-without")); }); await flush();
    expect(call(2)).toEqual({ bond: false, step: undefined });
    createState = IDLE; await rerender();
    expect((screen.getByTestId("v22-bond-toggle") as HTMLInputElement).checked).toBe(false);
  });

  it("I-1: a resume at step 3 with the bond ticked offers only Continue without the bond, at the same step", async () => {
    await formWithBond();
    await act(async () => { fireEvent.click(screen.getByTestId("fake-resume")); }); await flush();
    await waitFor(() => expect(launchBtn().disabled, launchBtn().getAttribute("aria-label") ?? "").toBe(false));
    await act(async () => { fireEvent.mouseDown(launchBtn()); }); await flush();
    expect(create).toHaveBeenCalledTimes(1);
    // The wizard hands the hook what the form says; the hook refuses the bond on a resume (hook test).
    expect(call(0)).toEqual({ bond: true, step: 3 });
    createState = { ...IDLE, step: 3, error: bondResumeMessage, slabAddress: RESUME_SLAB };
    await rerender();
    expect(screen.getByTestId("wizard-error").textContent).toContain(bondResumeMessage);
    // Neither a plain Continue (it would send the bond again and be refused) nor a fresh Try again.
    expect(screen.queryByTestId("wizard-retry")).toBeNull();
    expect(screen.queryByTestId("wizard-bond-try-again")).toBeNull();
    const without = screen.getByTestId("wizard-bond-launch-without");
    expect(without.textContent).toBe("Continue without the bond");
    await act(async () => { fireEvent.click(without); fireEvent.click(without); }); await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(call(1)).toEqual({ bond: false, step: 3 });
    createState = IDLE; await rerender();
    expect((screen.getByTestId("v22-bond-toggle") as HTMLInputElement).checked).toBe(false);
  });

  it("I-2: a resume at step 0 with the bond ticked gets the same resume refusal, not a Try again that refuses again", async () => {
    await formWithBond();
    await act(async () => { fireEvent.click(screen.getByTestId("fake-resume-0")); }); await flush();
    await waitFor(() => expect(launchBtn().disabled, launchBtn().getAttribute("aria-label") ?? "").toBe(false));
    await act(async () => { fireEvent.mouseDown(launchBtn()); }); await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(call(0)).toEqual({ bond: true, step: 0 });
    // The hook refuses a bond on any resume, step 0 included (hook test).
    createState = { ...IDLE, step: 0, error: bondResumeMessage, slabAddress: RESUME_SLAB };
    await rerender();
    expect(screen.getByTestId("wizard-error").textContent).toContain(bondResumeMessage);
    expect(screen.queryByTestId("wizard-retry")).toBeNull();
    expect(screen.queryByTestId("wizard-bond-try-again")).toBeNull();
    const without = screen.getByTestId("wizard-bond-launch-without");
    expect(without.textContent).toBe("Continue without the bond");
    await act(async () => { fireEvent.click(without); }); await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(call(1)).toEqual({ bond: false, step: 0 });
  });

  it("I-1, in-session: a refusal at a failed step continues there without the bond", async () => {
    await formWithBond();
    createState = { ...IDLE, step: 2, error: bondResumeMessage, slabAddress: POOL };
    await rerender();
    await act(async () => { fireEvent.click(screen.getByTestId("wizard-bond-launch-without")); }); await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(call(0)).toEqual({ bond: false, step: 2 });
  });
});
