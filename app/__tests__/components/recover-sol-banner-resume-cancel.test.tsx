/**
 * RESUME CREATION set a local "clicked" flag that never cleared, so after the wizard's CANCEL
 * (leaving resume mode) the card stayed on a disabled "RESUMING…" and could not be resumed
 * again without a reload. The card now follows the wizard's resume state (`resumingSlab`).
 */
import "@testing-library/jest-dom";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const kpA = Keypair.generate();
const kpB = Keypair.generate();
const slab = (kp: Keypair) => ({
  publicKey: kp.publicKey, isInitialized: true, exists: true, keypair: kp, lamports: 2_000_000_000,
  owner: "ProgramId111111111111111111111111111111111", lastStep: 2,
});
vi.mock("@/hooks/useStuckSlabs", () => ({
  useStuckSlabs: () => ({ stuckSlab: slab(kpA), stuckSlabs: [slab(kpA), slab(kpB)], loading: false, clearStuck: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/useCloseMarket", () => ({ useCloseMarket: () => ({ closeSlab: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useReclaimSlabRent", () => ({ useReclaimSlabRent: () => ({ status: "idle", error: null, txSig: null, reclaim: vi.fn() }) }));

import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";

/** The wizard's shape: resume state it owns, and a CANCEL that leaves resume mode. */
function Wizard() {
  const [resumeFromStep, setResumeFromStep] = useState<number | null>(null);
  const [resumeSlab, setResumeSlab] = useState<string | null>(null);
  return (
    <>
      <RecoverSolBanner
        onReset={() => {}}
        onResume={(s, step) => {
          setResumeFromStep(step);
          setResumeSlab(s);
        }}
        resumingSlab={resumeFromStep !== null ? resumeSlab : null}
      />
      {resumeFromStep !== null && <button onClick={() => setResumeFromStep(null)}>CANCEL</button>}
    </>
  );
}

const resumeButtons = () => screen.getAllByRole("button", { name: /RESUM/ });

describe("RecoverSolBanner resume state follows the wizard", () => {
  it("CANCEL in the wizard re-enables RESUME on the card", () => {
    render(<Wizard />);
    fireEvent.click(resumeButtons()[0]);
    expect(resumeButtons()[0]).toHaveTextContent("RESUMING…");
    expect(resumeButtons()[0]).toBeDisabled();
    expect(screen.getByText(/Resume mode set/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
    expect(resumeButtons()[0]).toHaveTextContent("RESUME CREATION →");
    expect(resumeButtons()[0]).toBeEnabled();
    expect(screen.queryByText(/Resume mode set/)).toBeNull();
  });

  it("resuming another market moves the RESUMING state to that card", () => {
    render(<Wizard />);
    fireEvent.click(resumeButtons()[0]);
    fireEvent.click(resumeButtons()[1]);
    expect(resumeButtons()[0]).toHaveTextContent("RESUME CREATION →");
    expect(resumeButtons()[1]).toHaveTextContent("RESUMING…");
  });

  it("the wizard passes its resume state to the banner", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/components/create/CreateMarketWizard.tsx`, "utf8");
    expect(src).toContain("resumingSlab={resumeFromStep !== null ? resumeSlab : null}");
    expect(src).toContain("setResumeSlab(slabAddress);");
  });
});
