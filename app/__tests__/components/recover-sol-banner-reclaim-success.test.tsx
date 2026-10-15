/**
 * S14: RECLAIM on an initialised, still-empty market set its result and cleared the stuck
 * record in the same click. The card is keyed off useStuckSlabs' list, so clearing the record
 * unmounted it before the "Reclaimed" line could render, and onReclaimSuccess (which resets
 * the wizard's saved form) never ran on this path. The hook mock below filters its own state
 * like the real one (useStuckSlabs.ts clearStuck), so clearing really does unmount the card.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const kp = Keypair.generate();
const slab = {
  publicKey: kp.publicKey, isInitialized: true, exists: true, keypair: kp,
  lamports: 2_000_000_000, owner: "ProgramId111111111111111111111111111111111", lastStep: 2,
};
const h = vi.hoisted(() => ({ closeSlab: vi.fn() }));

vi.mock("@/hooks/useStuckSlabs", () => ({
  useStuckSlabs: () => {
    const [list, setList] = useState([slab]);
    return {
      stuckSlab: list[0] ?? null,
      stuckSlabs: list,
      loading: false,
      clearStuck: (key: string) => setList((l) => l.filter((s) => s.publicKey.toBase58() !== key)),
      refresh: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/useCloseMarket", () => ({ useCloseMarket: () => ({ closeSlab: h.closeSlab, loading: false, error: null }) }));
vi.mock("@/hooks/useReclaimSlabRent", () => ({
  useReclaimSlabRent: () => ({ status: "idle", error: null, txSig: null, reclaim: vi.fn() }),
}));

import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";

beforeEach(() => {
  h.closeSlab.mockReset().mockResolvedValue({ signature: "SIG111", reclaimedLamports: 2_000_000_000 });
});

async function reclaim() {
  await act(async () => {
    fireEvent.click(screen.getByText(/^RECLAIM ~2\.0000 SOL$/));
  });
}

describe("RecoverSolBanner: reclaiming an initialised market (S14)", () => {
  it("shows the confirmation with the tx link after the reclaim lands", async () => {
    render(<RecoverSolBanner onReset={vi.fn()} onReclaimSuccess={vi.fn()} />);
    await reclaim();
    expect(screen.getByText("SOL Reclaimed ✓")).toBeTruthy();
    expect(screen.getByText(/2\.0000 SOL has been returned/)).toBeTruthy();
    expect(screen.getByText("View tx ↗").getAttribute("href")).toContain("SIG111");
  });

  it("START NEW MARKET clears the record and runs onReclaimSuccess, as the uninitialised path does", async () => {
    const onReset = vi.fn();
    const onReclaimSuccess = vi.fn();
    const { container } = render(<RecoverSolBanner onReset={onReset} onReclaimSuccess={onReclaimSuccess} />);
    await reclaim();
    expect(onReclaimSuccess).not.toHaveBeenCalled(); // not before the user moves on
    fireEvent.click(screen.getByText("START NEW MARKET →"));
    expect(onReclaimSuccess).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe(""); // record cleared
  });

  it("CONTROL: a failed reclaim keeps the card and its buttons", async () => {
    h.closeSlab.mockResolvedValue(null);
    render(<RecoverSolBanner onReset={vi.fn()} />);
    await reclaim();
    expect(screen.queryByText("SOL Reclaimed ✓")).toBeNull();
    expect(screen.getByText("Incomplete Market Found")).toBeTruthy();
  });
});
