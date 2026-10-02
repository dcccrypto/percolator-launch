/**
 * Two residual defects in the GH#2610 fix (287f0c7), found against playground HEAD.
 *
 * R1 — the panel's claim-outcome arms are UNREACHABLE.
 *   287f0c7 kept a two-way branch on `devnetAirdropAmount`/`devnetMintError` and
 *   fixed "defect 1" inside it (show the route's real reason, not a fixed
 *   sentence). But it also removed the only writer of those props: the hook now
 *   assigns them `null` at its two initial-state sites and nowhere else, and
 *   LaunchSuccess has no local state for them — they arrive from
 *   CreateMarketWizard as `createState.*`. So neither arm can ever render.
 *
 *   Consequences: the defect-1 fix is dead code, and the devnet panel lost its
 *   headline entirely — a creator now sees only the "Details" disclosure, with
 *   no statement of what Sim-USDC is or where to get it.
 *
 *   The commit's own test could not see this: it passed `devnetMintError=`
 *   directly as a prop, which no real caller does.
 *
 *   Real claim failures are still reported — via this component's own `mintError`
 *   state — so this is dead code plus a lost line, NOT a silent failure.
 *
 * R2 — a per-IP 429 is treated as "already claimed" and navigated past.
 *   /api/devnet-airdrop has two 429 exits: one carrying `nextClaimAt` (the daily
 *   claim — the user HAS tokens) and one from the per-IP fund limiter
 *   ("Too many requests…", a Retry-After header, no nextClaimAt) which mints
 *   NOTHING. `if (resp.ok || resp.status === 429)` treats both as success, so a
 *   rate-limited creator is navigated to the trade page with no collateral and
 *   no message.
 *
 * Both are fixed here; these assertions are the regression pins. Each one failed
 * on 5137651 before the fix.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const push = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/config", () => ({
  getNetwork: () => "devnet",
  // The real helpers on a devnet build (lib/config.ts explorerTxUrl / explorerAccountUrl).
  explorerTxUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  explorerAccountUrl: (addr: string) => `https://explorer.solana.com/account/${addr}?cluster=devnet`,
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => "WaLLet1111111111111111111111111111111111111" } }),
}));
vi.mock("@/components/create/LogoUpload", () => ({ LogoUpload: () => null }));

import { LaunchSuccess } from "@/components/create/LaunchSuccess";

const SIM_USDC = "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs";
const MARKET = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";

type Props = Parameters<typeof LaunchSuccess>[0];

/**
 * Exactly what CreateMarketWizard passes. Nothing here is hand-set to a value a
 * real launch cannot produce — that is the whole point: the defect this file
 * pins was invisible precisely because the old test supplied a prop by hand.
 */
function asTheWizardRendersIt(over: Partial<Props> = {}): Props {
  return {
    tokenSymbol: "CATE",
    tradingFeeBps: 5,
    maxLeverage: 5,
    marketAddress: MARKET,
    txSigs: [],
    onDeployAnother: () => {},
    devnetMint: SIM_USDC,
    ...over,
  } as Props;
}

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("R1 — the claim-outcome arms cannot be reached", () => {
  it("the unreachable state is deleted, not left permanently null", () => {
    // Left as props that are always null, the dead branch is one caller away
    // from returning.
    //
    // NOT `not.toContain(name + ":")`. That was the first version, and a literal
    // substring match is defeated by one space — `devnetAirdropAmount ?:` is
    // valid TS, restores the whole chain, and passes. Review demonstrated exactly
    // that. Allow whitespace before the punctuation instead.
    //
    // Comments are stripped first, so the prose explaining the removal may still
    // name the props; without that, `\s*,` also matches a comment listing them,
    // which is a spurious failure waiting to happen.
    const stripComments = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map((line) => {
          const i = line.indexOf("//");
          return i === -1 ? line : line.slice(0, i);
        })
        .join("\n");

    for (const f of [
      "hooks/useCreateMarket.ts",
      "components/create/CreateMarketWizard.tsx",
      "components/create/LaunchSuccess.tsx",
    ]) {
      const src = read(f);
      const code = stripComments(src);

      // CONTROLS, before the absences. A stripping bug, a bad path or a typo'd
      // name would otherwise turn every assertion below into a check on the
      // wrong text — which is how the two earlier versions of this test went
      // wrong. So: the file is real, stripping removed something but not
      // everything, and the same probe DOES match the prop that survives.
      expect(src.length).toBeGreaterThan(1_000);
      expect(code.length).toBeLessThan(src.length);
      expect(code.length).toBeGreaterThan(src.length / 2);
      expect(code).toMatch(/devnetMint\s*[?:=,]/);

      for (const name of ["devnetAirdropAmount", "devnetAirdropSymbol", "devnetMintError"]) {
        expect(code).not.toMatch(new RegExp(name + "\\s*[?:=,]"));
      }
    }
  });

  it("the panel states what the collateral is and where to get it", () => {
    // mainnetCA is set on EVERY real launch (CreateMarketWizard passes
    // `mainnetCA={wizard.mintAddress}`), so it must be set here too. Without it,
    // wrapping the headline in `{!mainnetCA && …}` leaves it dead in production
    // and green in the tests — review demonstrated exactly that mutant.
    render(<LaunchSuccess {...asTheWizardRendersIt({ mainnetCA: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump" })} />);

    // The headline that was missing entirely.
    expect(screen.getByText(/is your collateral/i)).toBeInTheDocument();
    expect(screen.getByText(/faucet/i).closest("a")).toHaveAttribute("href", "/faucet");

    // And no claim-outcome line, because this screen makes no claim.
    expect(screen.queryByText(/of Sim-USDC to your wallet/i)).toBeNull();
    expect(screen.queryByText(/Sending Sim-USDC/i)).toBeNull();

    // CONTROL: the panel is the real one — the mint is inside its disclosure.
    fireEvent.click(screen.getByText(/Details/i));
    expect(screen.getByText(SIM_USDC)).toBeInTheDocument();
  });
});

describe("R2 — a per-IP 429 is navigated past as though it were a claim", () => {
  it("rate-limited: stays on the screen with the reason", async () => {
    // The /api/devnet-airdrop per-IP fund limiter exit: no nextClaimAt, no mint.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests. Please slow down and try again shortly." }),
    }));

    render(<LaunchSuccess {...asTheWizardRendersIt()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(screen.getByText(/Too many requests/i)).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it("CONTROL: the 'already claimed' 429 SHOULD navigate — a claim is on record", async () => {
    // This is what the 429 pass-through is for and it must keep working. Note
    // "a claim is on record" is not the same as "holds tokens" — they may have
    // been spent, or a claim may have leaked from a failed mint (GH#2597). That
    // was true before this change too; the trade page is where you check a
    // balance anyway.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Already claimed", nextClaimAt: "2026-01-01T00:00:00Z" }),
    }));

    render(<LaunchSuccess {...asTheWizardRendersIt()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/trade/${MARKET}`));
  });

  it("a failed claim can be retried — the button does not stay disabled", async () => {
    // Nothing clicked twice, so deleting BOTH `setMintLoading(false)` calls
    // survived the whole suite. That leaves the button permanently disabled on
    // "FUNDING…" after any failure, with `handleMintAndTrade` also early-
    // returning on `mintLoading` — a dead end, which is the very defect (#2610
    // defect 3) this code was rewritten to remove.
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "Internal server error" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ amount: 500 }) });
    vi.stubGlobal("fetch", f);

    render(<LaunchSuccess {...asTheWizardRendersIt()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(screen.getByText(/Internal server error/i)).toBeInTheDocument());
    expect(screen.queryByText(/FUNDING/i)).toBeNull();

    // And the retry actually goes through.
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/trade/${MARKET}`));
  });

  it("only an ISO-string nextClaimAt is a pass", async () => {
    // Pins the route's contract rather than one mock body: `typeof === "string"`
    // is not interchangeable with `!= null`, `"nextClaimAt" in d` or truthiness.
    // A null or numeric value means the gate did not hand back a claim time, and
    // must not navigate.
    for (const nextClaimAt of [null, 0, 1767225600]) {
      push.mockReset();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "Rate limited", nextClaimAt }),
      }));

      const { unmount } = render(<LaunchSuccess {...asTheWizardRendersIt()} />);
      fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

      await waitFor(() => expect(screen.getByText(/Rate limited/i)).toBeInTheDocument());
      expect(push).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("CONTROL: a 500 already stays on the screen with the real reason", async () => {
    // Proves the mock wiring and that R2 is specific to the 429 arm.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: "Internal server error" }),
    }));

    render(<LaunchSuccess {...asTheWizardRendersIt()} />);
    fireEvent.click(screen.getByText(/GET SIM-USDC & TRADE/i));

    await waitFor(() => expect(screen.getByText(/Internal server error/i)).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });
});
