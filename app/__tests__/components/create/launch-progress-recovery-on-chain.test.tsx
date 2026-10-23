/**
 * QA 2026-10-15: after step 1 ("Create slab & initialize market") was refused by the wallet, the Recovery panel said
 * "The market account is on chain… download JSON". Nothing was signed: the in-flight entry is saved BEFORE step 0 is
 * sent, so its presence is not "on chain". The panel now shows only once the exported market account exists on chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";

const getAccountInfo = vi.fn();
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: { getAccountInfo } }) }));

import { LaunchProgress } from "@/components/create/LaunchProgress";
import { saveInFlightMarket, loadAllInFlightMarkets } from "@/lib/inFlightMarket";
import { inFlightSlabOnChain } from "@/hooks/useInFlightSlabOnChain";

const slab = Keypair.generate();
const failedStep1 = {
  step: 0, loading: false, error: "Step 1 (Create slab & initialize market) failed: cancelled", slabAddress: null, txSigs: [], stepLabel: "", phase: "idle" as const,
};

describe("Recovery panel: only when the market account is really on chain", () => {
  beforeEach(() => {
    window.localStorage.clear();
    getAccountInfo.mockReset();
    saveInFlightMarket({
      slabAddress: slab.publicKey.toBase58(), slabSecretKey: Array.from(slab.secretKey), adminAddress: Keypair.generate().publicKey.toBase58(),
      collateralAta: Keypair.generate().publicKey.toBase58(), collateralMint: Keypair.generate().publicKey.toBase58(),
      programId: Keypair.generate().publicKey.toBase58(), network: "devnet", createdAt: Date.now(), lastStep: 0,
    });
  });
  afterEach(() => window.localStorage.clear());

  it("step 1 never signed (entry saved, no account): no Recovery panel, no 'on chain' claim", async () => {
    getAccountInfo.mockResolvedValue(null);
    render(<LaunchProgress state={failedStep1} onReset={() => {}} />);
    await waitFor(() => expect(getAccountInfo).toHaveBeenCalled());
    expect(getAccountInfo.mock.calls[0][0].toBase58()).toBe(slab.publicKey.toBase58());
    // NEGATIVE CONTROL for the old gate: an in-flight entry IS present, which alone used to show the panel.
    expect(loadAllInFlightMarkets().length).toBe(1);
    expect(screen.queryByText(/The market account is on chain/)).toBeNull();
    expect(screen.queryByText(/DOWNLOAD RECOVERY JSON/)).toBeNull();
  });

  it("the account exists (e.g. step 0 landed but its confirmation timed out): the panel shows", async () => {
    getAccountInfo.mockResolvedValue({ data: Buffer.alloc(4059), owner: Keypair.generate().publicKey, lamports: 1, executable: false });
    render(<LaunchProgress state={failedStep1} onReset={() => {}} />);
    expect(await screen.findByText(/The market account is on chain/)).toBeTruthy();
    expect(screen.getByText(/DOWNLOAD RECOVERY JSON/)).toBeTruthy();
  });

  it("an RPC failure proves nothing: the panel stays hidden (re-checked later)", async () => {
    getAccountInfo.mockRejectedValue(new Error("429"));
    render(<LaunchProgress state={failedStep1} onReset={() => {}} />);
    await waitFor(() => expect(getAccountInfo).toHaveBeenCalled());
    expect(screen.queryByText(/The market account is on chain/)).toBeNull();
  });

  it("inFlightSlabOnChain: no entry = false, no connection = null (unknown)", async () => {
    expect(await inFlightSlabOnChain({ getAccountInfo } as never, null)).toBe(false);
    expect(await inFlightSlabOnChain(undefined, { slabAddress: slab.publicKey.toBase58() })).toBeNull();
  });
});
