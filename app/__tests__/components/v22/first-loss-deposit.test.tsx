import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { ConsentChangedError, consentViewOf } from "@/lib/v22/stake-v5";
import { STAKE_CONSENT_TEXT_V2, V22_COPY } from "@/lib/v22/copy";
import type { StakePoolV5 } from "@/lib/v22/sdk";

const hook = vi.hoisted(() => ({ state: { pool: null as unknown, deposit: vi.fn(), loading: false, error: null as string | null } }));
vi.mock("@/hooks/useStakeFirstLoss", () => ({ useStakeFirstLoss: () => hook.state }));

import { FirstLossDeposit } from "@/components/stake/FirstLossDeposit";

const k = () => Keypair.generate().publicKey;
const pool = (o: Partial<StakePoolV5> = {}): StakePoolV5 =>
  ({ slab: k(), admin: k(), collateralMint: k(), lpMint: k(), vault: k(), percolatorProgram: k(), riskMode: 1, consentVersion: 2, deployTargetBps: 5000, liquidBufferBps: 3000, hysteresisBps: 500,
    lastSyncSlot: 0n, pendingTargetBps: 0n, pendingTargetSlot: 0n, syncCooldownSlots: 150n, creatorForwardedAtoms: 0n, pendingTargetByProtocol: false,
    totalDeposited: 0n, totalLpSupply: 0n, cooldownSlots: 0n, depositCap: 0n, totalFlushed: 0n, totalReturned: 0n, totalWithdrawn: 0n, poolMode: 0, ...o }) as StakePoolV5;

const props = { slabAddress: "S", collateralMint: "M", decimals: 6 };

beforeEach(() => { hook.state = { pool: pool(), deposit: vi.fn().mockResolvedValue("sig"), loading: false, error: null }; });
afterEach(cleanup);

describe("FirstLossDeposit", () => {
  it("renders nothing for a pool that is not v5 first-loss", () => {
    hook.state = { ...hook.state, pool: null };
    const { container } = render(<FirstLossDeposit {...props} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the target, buffer and hysteresis and the consent text v2 verbatim, paragraph by paragraph", () => {
    render(<FirstLossDeposit {...props} />);
    expect(screen.getByTestId("fl-target").textContent).toBe("50%");
    expect(screen.getByTestId("fl-buffer").textContent).toBe("30%");
    expect(screen.getByTestId("fl-hysteresis").textContent).toBe("5%");
    const paras = screen.getAllByTestId("consent-para").map((p) => p.textContent);
    expect(paras).toEqual([...STAKE_CONSENT_TEXT_V2]);
    expect(screen.getByTestId("first-loss-withdraw-note").textContent).toBe(V22_COPY.stake.withdraw);
  });

  it("Deposit stays disabled until the checkbox is ticked (and an amount entered)", () => {
    render(<FirstLossDeposit {...props} />);
    const btn = screen.getByTestId("first-loss-submit") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("stake-deposit-input"), { target: { value: "5" } });
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("consent-check"));
    expect(btn.disabled).toBe(false);
  });

  it("sends exactly the consent the user accepted", async () => {
    render(<FirstLossDeposit {...props} />);
    fireEvent.change(screen.getByTestId("stake-deposit-input"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("consent-check"));
    fireEvent.click(screen.getByTestId("first-loss-submit"));
    await waitFor(() => expect(hook.state.deposit).toHaveBeenCalledTimes(1));
    const [amount, accepted] = (hook.state.deposit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(amount).toBe(5_000_000n);
    expect(accepted).toEqual(consentViewOf(pool()));
    expect(accepted.version).toBe(2);
  });

  it("re-consent: when the pool's numbers change under the user, the checkbox resets and Deposit disables", () => {
    const { rerender } = render(<FirstLossDeposit {...props} />);
    fireEvent.change(screen.getByTestId("stake-deposit-input"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("consent-check"));
    expect((screen.getByTestId("first-loss-submit") as HTMLButtonElement).disabled).toBe(false);
    hook.state = { ...hook.state, pool: pool({ deployTargetBps: 6500 }) };
    rerender(<FirstLossDeposit {...props} />);
    expect((screen.getByTestId("consent-check") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("first-loss-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("fl-target").textContent).toBe("65%");
  });

  it("a consent given before a change is not silently revived when the numbers change back", () => {
    const { rerender } = render(<FirstLossDeposit {...props} />);
    fireEvent.click(screen.getByTestId("consent-check"));
    hook.state = { ...hook.state, pool: pool({ deployTargetBps: 6500 }) };
    rerender(<FirstLossDeposit {...props} />);
    hook.state = { ...hook.state, pool: pool({ deployTargetBps: 5000 }) };
    rerender(<FirstLossDeposit {...props} />);
    expect((screen.getByTestId("consent-check") as HTMLInputElement).checked).toBe(false);
  });

  it("a ConsentChangedError from the pre-send re-read asks for consent again", async () => {
    hook.state.deposit = vi.fn().mockRejectedValue(new ConsentChangedError(consentViewOf(pool({ deployTargetBps: 7000 }))));
    render(<FirstLossDeposit {...props} />);
    fireEvent.change(screen.getByTestId("stake-deposit-input"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("consent-check"));
    fireEvent.click(screen.getByTestId("first-loss-submit"));
    await waitFor(() => expect((screen.getByTestId("consent-check") as HTMLInputElement).checked).toBe(false));
    expect(screen.getByText(/review and accept again/i)).toBeTruthy();
  });
});
