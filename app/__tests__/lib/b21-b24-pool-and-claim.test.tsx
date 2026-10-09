/**
 * E2E B21 (2026-09-30): the wizard offered a Meteora DAMM v1 pool (DexScreener "meteora")
 * labelled meteora-dlmm; keeper-register 400'd it; the wizard still said MARKET LAUNCHED.
 * E2E B24: a P3 senior claim refused with 21 was explained as "securing open unrealized PnL".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<typeof import("@/lib/config")>()), getNetwork: () => "devnet" }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => "WaLLet1111111111111111111111111111111111111" } }),
  // v2.2 only (LaunchSuccess reads the share token through it); never called with the flag off.
  useConnectionCompat: () => ({ connection: {} }),
}));
vi.mock("@/components/create/LogoUpload", () => ({ LogoUpload: () => null }));

import {
  applyPoolClasses,
  isVerifiedPool,
  POOL_VERIFY_FAILED,
  UNSUPPORTED_POOL_TYPES,
  useDexPoolSearch,
  type DexPoolResult,
} from "@/hooks/useDexPoolSearch";
import {
  classifyOwner,
  classifyPoolsByOwner,
  isOfferable,
  METEORA_DAMM_V1_PROGRAM,
  OFFERABLE_DEX_TYPES,
} from "@/lib/dex-pool-owner";
import { normalizeDexType } from "@/lib/dex-type";
import { launchPriceFeedStatus } from "@/lib/launch-outcome";
import { LaunchSuccess, LAUNCH_PRICE_COPY } from "@/components/create/LaunchSuccess";
import { UNSUPPORTED_POOL_COPY as POOL_UNSUPPORTED_LINE } from "@/lib/wizard-copy";
import { earnErrorMessage } from "@/lib/earnErrors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const PUMP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const key = (i: number) => {
  const b = new Uint8Array(32);
  b[0] = 7;
  b[31] = i;
  return new PublicKey(b).toBase58();
};
const DAMM_POOL = key(1); // stands in for WIF's 5rxahS44… (owner Eo7W…)
const DLMM_POOL = key(2);
const PUMP_POOL = key(3);
/** Pool bytes long enough for every parser, quote (token Y / quote mint) = WSOL at the DLMM offset. */
const wsolQuotedPool = () => {
  const d = new Uint8Array(904);
  d.set(new PublicKey("So11111111111111111111111111111111111111112").toBytes(), 120);
  return d;
};
const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("B21: pools are classified by mainnet OWNER, never by DexScreener's dexId", () => {
  it("DAMM v1 is unsupported; only DLMM and PumpSwap are offerable (Raydium CLMM withheld)", () => {
    expect(classifyOwner(METEORA_DAMM_V1_PROGRAM)).toBe("unsupported");
    expect(classifyOwner(DLMM)).toBe("meteora-dlmm");
    expect(classifyOwner(PUMP)).toBe("pumpswap");
    expect(classifyOwner(CLMM)).toBe("raydium-clmm");
    expect(OFFERABLE_DEX_TYPES).toEqual(["meteora-dlmm", "pumpswap"]);
    expect(isOfferable("raydium-clmm")).toBe(false);
    expect(isOfferable("unsupported")).toBe(false);
    expect(normalizeDexType("meteora-damm")).toBeNull();
  });

  it("classifyPoolsByOwner: one getMultipleAccountsInfo; missing accounts; RPC failure is null (never a guess)", async () => {
    const owners: Record<string, string> = { [DAMM_POOL]: METEORA_DAMM_V1_PROGRAM, [DLMM_POOL]: DLMM };
    const conn = {
      getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) =>
        ks.map((k) => (owners[k.toBase58()] ? { owner: new PublicKey(owners[k.toBase58()]), data: wsolQuotedPool() } : null)),
      ),
    };
    const r = await classifyPoolsByOwner([DAMM_POOL, DLMM_POOL, PUMP_POOL, "not-a-key"], conn as never);
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ [DAMM_POOL]: "unsupported", [DLMM_POOL]: "meteora-dlmm", [PUMP_POOL]: "missing", "not-a-key": "missing" });
    const down = { getMultipleAccountsInfo: vi.fn(async () => { throw new Error("rpc down"); }) };
    expect(await classifyPoolsByOwner([DLMM_POOL], down as never)).toBeNull();
  });

  const pool = (poolAddress: string, liq: number): DexPoolResult => ({
    poolAddress, dexId: "meteora", pairLabel: "WIF / SOL", baseSymbol: "WIF", quoteSymbol: "SOL", liquidityUsd: liq, priceUsd: 1,
  });

  it("applyPoolClasses drops the DAMM pool even when it is the most liquid, and labels the rest", () => {
    const out = applyPoolClasses([pool(DAMM_POOL, 9e6), pool(DLMM_POOL, 1e6)], { [DAMM_POOL]: "unsupported", [DLMM_POOL]: "meteora-dlmm" });
    expect(out.map((p) => p.poolAddress)).toEqual([DLMM_POOL]);
    expect(out[0].dexType).toBe("meteora-dlmm");
    expect(out[0].dexLabel).toBe("Meteora DLMM");
    expect(isVerifiedPool(out[0])).toBe(true);
    // A pool persisted by an older build (no dexType) is not launchable.
    expect(isVerifiedPool(pool(DLMM_POOL, 1))).toBe(false);
  });

  describe("useDexPoolSearch (DexScreener + /api/dex/classify-pools)", () => {
    const MINT = "So11111111111111111111111111111111111111112";
    const dexscreener = {
      pairs: [
        { chainId: "solana", dexId: "meteora", pairAddress: DAMM_POOL, baseToken: { symbol: "WIF" }, quoteToken: { symbol: "SOL" }, liquidity: { usd: 9e6 }, priceUsd: "1" },
        { chainId: "solana", dexId: "meteora", pairAddress: DLMM_POOL, baseToken: { symbol: "WIF" }, quoteToken: { symbol: "SOL" }, liquidity: { usd: 1e6 }, priceUsd: "1" },
      ],
    };
    let classify: (body: { addresses: string[] }) => Response;
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("dexscreener")) return new Response(JSON.stringify(dexscreener), { status: 200 });
        if (url === "/api/dex/classify-pools") return classify(JSON.parse(String(init?.body)));
        throw new Error(`unexpected ${url}`);
      }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it("offers only the DLMM pool, labelled Meteora DLMM (the DAMM default pick is gone)", async () => {
      classify = ({ addresses }) => {
        expect(addresses).toEqual([DAMM_POOL, DLMM_POOL]);
        return new Response(JSON.stringify({ classes: { [DAMM_POOL]: "unsupported", [DLMM_POOL]: "meteora-dlmm" } }), { status: 200 });
      };
      const { result } = renderHook(() => useDexPoolSearch(MINT));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.pools.map((p) => p.poolAddress)).toEqual([DLMM_POOL]);
      expect(result.current.pools[0].dexLabel).toBe("Meteora DLMM");
      expect(result.current.error).toBeNull();
    });

    it("only unsupported pools: nothing offered, with a reason", async () => {
      classify = () => new Response(JSON.stringify({ classes: { [DAMM_POOL]: "unsupported", [DLMM_POOL]: "unsupported" } }), { status: 200 });
      const { result } = renderHook(() => useDexPoolSearch(MINT));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.pools).toEqual([]);
      expect(result.current.blockedReason).toBe(UNSUPPORTED_POOL_TYPES);
    });

    it("classifier unavailable: offers nothing and says so (never the unverified list)", async () => {
      classify = () => new Response("{}", { status: 503 });
      const { result } = renderHook(() => useDexPoolSearch(MINT));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.pools).toEqual([]);
      expect(result.current.error).toBe(POOL_VERIFY_FAILED);
    });
  });

  it("server surfaces: keeper-register and /api/oracle/resolve classify by owner and refuse when unverifiable", () => {
    const kr = read("app/api/playground/keeper-register/route.ts");
    expect(kr).toContain('from "@/lib/dex-pool-owner"');
    expect(kr).not.toMatch(/normalizeDexType\(/);
    expect(kr).toMatch(/classified === "rpc-failed"[\s\S]{0,400}status: 503/);
    const rs = read("app/api/oracle/resolve/[ca]/route.ts");
    expect(rs).toContain("classifyPoolsByOwner(candidates)");
    expect(rs).toContain("isOfferable(classes[c])");
    const wiz = read("components/create/CreateMarketWizard.tsx");
    expect(wiz).not.toContain('?? "raydium-clmm"');
    expect(wiz).toContain("isVerifiedPool(parsed.dexPool)");
  });
});

describe("B21: never 'launched' without a registered price feed", () => {
  it("launchPriceFeedStatus", () => {
    expect(launchPriceFeedStatus({ priceFeedRequired: false, keeperDelegated: false })).toBe("not-needed");
    expect(launchPriceFeedStatus({ priceFeedRequired: true, keeperDelegated: true })).toBe("registered");
    expect(launchPriceFeedStatus({ priceFeedRequired: true, keeperDelegated: false })).toBe("missing");
  });

  const props = (over: Partial<Parameters<typeof LaunchSuccess>[0]>) =>
    ({ tokenSymbol: "WIF", tradingFeeBps: 5, maxLeverage: 5, marketAddress: DLMM_POOL, txSigs: [], onDeployAnother: () => {}, ...over }) as Parameters<typeof LaunchSuccess>[0];

  // Registration runs in the background with no signature. The success actions show at once; the
  // title is "Market created" (never "Ready to trade") until the live price is connected, and the
  // price is a one-line status with Retry once it failed or the wait bound passed.
  it("connecting: 'Market created' with the calm connecting line and no Retry yet", () => {
    render(<LaunchSuccess {...props({ priceFeedRequired: true, keeperDelegated: false, keeperPhase: "connecting", keeperMessage: "Connecting the live price… usually under a minute." })} />);
    expect(screen.queryByText("Ready to trade")).toBeNull();
    expect(screen.getByText(LAUNCH_PRICE_COPY.pendingTitle)).toBeTruthy();
    expect(screen.getByTestId("launch-price-status-line").textContent).toMatch(/Live price connecting/);
    expect(screen.queryByTestId("launch-price-retry")).toBeNull();
  });

  it("failed: the reason and a working Retry, and still not 'Ready to trade'", () => {
    const retry = vi.fn();
    render(
      <LaunchSuccess
        {...props({
          priceFeedRequired: true,
          keeperDelegated: false,
          keeperPhase: "failed",
          keeperMessage: POOL_UNSUPPORTED_LINE,
          onRetryKeeperRegistration: retry,
        })}
      />,
    );
    expect(screen.queryByText("Ready to trade")).toBeNull();
    expect(screen.getByTestId("launch-price-status-line").textContent).toBe(POOL_UNSUPPORTED_LINE);
    fireEvent.click(screen.getByTestId("launch-price-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("no message still explains it", () => {
    render(<LaunchSuccess {...props({ priceFeedRequired: true, keeperDelegated: false, keeperMessage: "" })} />);
    expect(screen.getByTestId("launch-price-status-line").textContent).toMatch(/Live price connecting/);
  });

  it("registered (or no feed needed): 'Ready to trade'", () => {
    const { unmount } = render(<LaunchSuccess {...props({ priceFeedRequired: true, keeperDelegated: true })} />);
    expect(screen.getByText("Ready to trade")).toBeTruthy();
    unmount();
    render(<LaunchSuccess {...props({ priceFeedRequired: false, keeperDelegated: false })} />);
    expect(screen.getByText("Ready to trade")).toBeTruthy();
  });

  it("both create flows set priceFeedRequired, and the wizard passes it", () => {
    const hook = read("hooks/useCreateMarket.ts");
    // Three create flows: the batched launch, the sequential/resume path, and the single-transaction
    // (Solana v1) launch's success branch inside attemptFreshBatchedLaunch.
    expect((hook.match(/priceFeedRequired: !!\(isKeeperOracle && params\.dexPoolAddress\)/g) ?? []).length).toBe(3);
    expect(hook).not.toMatch(/is live on-chain but won't/);
    expect(read("components/create/CreateMarketWizard.tsx")).toContain("priceFeedRequired={createState.priceFeedRequired}");
  });
});

describe("B24: a P3 senior claim refused with 21 is not blamed on open PnL", () => {
  const e21 = new Error(`Transaction failed: {"InstructionError":[2,{"Custom":21}]}\nProgram ${resolveDevnetProgramIds().wrapper} failed: custom program error: 0x15`);
  it("P3 bound vault: neutral copy, no unrealized-PnL claim", () => {
    const m = earnErrorMessage(e21, "claim", { p3Bound: true });
    // UX WP-1 §3.6 item 7 (supersedes COPY.earnClaimRefusedP3): calm. Nothing resends the payout,
    // so it says to try again rather than promising an automatic retry.
    expect(m).toBe("This withdrawal can't be paid out this moment. Nothing moved; your withdrawal stays ready to collect. Try again in a moment.");
    expect(m).not.toMatch(/unrealized PnL|open positions|escrow/i);
  });
  it("legacy vault: in use by open trades; deposit: nothing deposited, retried", () => {
    expect(earnErrorMessage(e21, "claim")).toMatch(/in use by open trades/);
    expect(earnErrorMessage(e21, "deposit", { p3Bound: true })).toMatch(/Nothing was deposited/);
  });
  it("both Earn panels pass the bound flag", () => {
    expect(read("components/earn/VaultDepositRail.tsx")).toContain("p3Bound={marketLimits.vaultLp?.bound === true}");
    expect(read("app/earn/[slab]/page.tsx")).toContain("p3Bound={earnLimits.vaultLp?.bound === true}");
    expect(read("components/earn/DepositWithdrawPanel.tsx")).toContain("earnErrorMessage(e, 'claim', { p3Bound })");
  });
});
