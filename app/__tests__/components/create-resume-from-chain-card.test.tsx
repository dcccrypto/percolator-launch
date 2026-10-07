/**
 * #3267: /create?resume=<slab> reads the slab from chain and only hands a launch to the wizard once
 * the token address the creator typed is proven against the creation tx's registration memo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  recover: vi.fn(), adopt: vi.fn(), account: vi.fn(), conn: null as unknown as { connection: unknown }, wallet: null as unknown,
  isV17: true, marketauth: null as unknown as PublicKey, complete: false, header: { mode: 0, cTot: 0n, materializedPortfolioCount: 0n },
}));
const WALLET = new PublicKey("EXC8LS3YzsbyadhaQPqaeGjb2ttfGgDLno9jeCFWqqyi");
const OTHER = new PublicKey("DrrDGxiojUPHnLZaNw7DN6JYoEKKqu3bG4PmNjv8P1yG");
const SLAB = new PublicKey("GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL");
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<object>()), isV17Account: () => h.isV17, parseWrapperConfigV17: () => ({ marketauth: h.marketauth }), V17_HEADER_LEN: 0 }));
vi.mock("@/lib/v18-wire", () => ({ readMarketGroupHeader: () => h.header }));
vi.mock("@/lib/market-completeness", () => ({ isMarketauthComplete: () => h.complete }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => h.wallet, useConnectionCompat: () => h.conn }));
vi.mock("@/hooks/useDexPoolSearch", () => ({ searchVerifiedPools: vi.fn() }));
vi.mock("@/lib/tokenMeta", () => ({ fetchTokenMeta: vi.fn() }));
vi.mock("@/lib/launch-recovery", async (orig) => ({ ...(await orig<object>()), recoverLaunchFromChain: h.recover, adoptRecoveredLaunch: h.adopt }));

import { ResumeFromChainCard, classifyResumeSlab } from "@/components/create/ResumeFromChainCard";

const launch = { symbol: "AUTON", name: "auton", poolAddress: "POOL1111", initialMarginBps: 1000, tradingFeeBps: 5, lpCollateralAtoms: 1_000_000_000n, request: { mainnetCA: "CA1" } };
const bytes = new Uint8Array(8);

beforeEach(() => {
  h.conn = { connection: { getAccountInfo: h.account } };
  h.wallet = { publicKey: WALLET };
  Object.assign(h, { isV17: true, marketauth: WALLET, complete: false, header: { mode: 0, cTot: 0n, materializedPortfolioCount: 0n } });
  h.recover.mockReset(); h.adopt.mockReset();
  h.account.mockReset().mockResolvedValue({ data: Buffer.from(bytes) });
});

describe("classifying the slab for a resume", () => {
  it("not an initialised market: nothing on chain to continue (step 0 needs the slab key)", () => {
    expect(classifyResumeSlab(null, SLAB, WALLET).kind).toBe("not-a-market");
    h.isV17 = false;
    expect(classifyResumeSlab(bytes, SLAB, WALLET).kind).toBe("not-a-market");
  });
  it("finished, or someone else's, is refused", () => {
    h.complete = true;
    expect(classifyResumeSlab(bytes, SLAB, WALLET).kind).toBe("finished");
    h.complete = false;
    h.marketauth = OTHER;
    expect(classifyResumeSlab(bytes, SLAB, WALLET).kind).toBe("not-yours");
  });
  it("the creator's unfinished launch resumes at the step the chain implies", () => {
    expect(classifyResumeSlab(bytes, SLAB, WALLET)).toEqual({ kind: "ready", step: 1, funded: false });
    h.header = { mode: 0, cTot: 0n, materializedPortfolioCount: 1n };
    expect(classifyResumeSlab(bytes, SLAB, WALLET)).toEqual({ kind: "ready", step: 2, funded: false });
    h.header = { mode: 0, cTot: 5n, materializedPortfolioCount: 2n };
    expect(classifyResumeSlab(bytes, SLAB, WALLET)).toEqual({ kind: "ready", step: 3, funded: true });
  });
  it("a bad read is 'unreadable', never a guess", () => {
    h.header = null as never;
    expect(classifyResumeSlab(bytes, SLAB, WALLET).kind).toBe("unreadable");
  });
});

describe("the card", () => {
  it("a proven launch is adopted and handed to the wizard with the inferred step", async () => {
    h.recover.mockResolvedValue({ ok: true, launch });
    const onVerified = vi.fn();
    render(<ResumeFromChainCard slab={SLAB.toBase58()} onVerified={onVerified} />);
    fireEvent.change(await screen.findByTestId("resume-chain-ca"), { target: { value: "CA1" } });
    fireEvent.click(screen.getByTestId("resume-chain-verify"));
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(launch, 1));
    expect(h.adopt).toHaveBeenCalledWith(launch);
    expect(screen.getByTestId("resume-chain-summary").textContent).toMatch(/AUTON.*10x.*5 bps fee.*1000 liquidity seed/);
  });

  it("asks for the liquidity amount only when nothing is deposited, and passes it as a candidate to prove", async () => {
    h.recover.mockResolvedValue({ ok: false, reason: "no-match" });
    render(<ResumeFromChainCard slab={SLAB.toBase58()} onVerified={vi.fn()} />);
    fireEvent.change(await screen.findByTestId("resume-chain-ca"), { target: { value: "CA1" } });
    fireEvent.change(screen.getByTestId("resume-chain-lp"), { target: { value: "1000" } });
    fireEvent.click(screen.getByTestId("resume-chain-verify"));
    await waitFor(() => expect(h.recover).toHaveBeenCalled());
    expect(h.recover.mock.calls[0][1]).toEqual({ slab: SLAB.toBase58(), wallet: WALLET.toBase58(), mainnetCA: "CA1", lpCandidates: [1_000_000_000n] });
  });

  it("a proof that does not match hands nothing to the wizard and saves nothing", async () => {
    h.recover.mockResolvedValue({ ok: false, reason: "no-match" });
    const onVerified = vi.fn();
    render(<ResumeFromChainCard slab={SLAB.toBase58()} onVerified={onVerified} />);
    fireEvent.change(await screen.findByTestId("resume-chain-ca"), { target: { value: "WRONG" } });
    fireEvent.click(screen.getByTestId("resume-chain-verify"));
    await waitFor(() => expect(screen.getByTestId("resume-chain-note").textContent).toMatch(/doesn't match/));
    expect(onVerified).not.toHaveBeenCalled();
    expect(h.adopt).not.toHaveBeenCalled();
  });

  it("another wallet's launch offers no form at all", async () => {
    h.marketauth = OTHER;
    render(<ResumeFromChainCard slab={SLAB.toBase58()} onVerified={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("resume-chain-card").dataset.state).toBe("not-yours"));
    expect(screen.queryByTestId("resume-chain-ca")).toBeNull();
  });
});
