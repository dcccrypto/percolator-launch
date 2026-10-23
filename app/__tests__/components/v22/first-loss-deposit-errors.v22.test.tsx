/**
 * #3608: a refused first-loss deposit showed the raw simulation text (`Transaction simulation failed:
 * {"InstructionError":[1,{"Custom":33}]}` plus program log lines): FirstLossDeposit and useStakeFirstLoss passed the
 * error through `errorText`, which returns an Error's message unchanged. They now use the same mapping as the other
 * /stake surfaces (resolveUserMessage, which reaches v22StakeMessage for stake-program codes), so 33 / 28 / 44 read
 * as plain copy and no raw chain or RPC text reaches the user.
 *
 * Codes checked against percolator-stake `fix/v22-stake-310-313-combined` (0cc18d2) src/error.rs:
 * DepositBelowMinimumLiquidity = 28, ConsentRequired = 33, InsuranceReadingsDiverged = 44.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { ConsentChangedError, consentViewOf } from "@/lib/v22/stake-v5";
import { STAKE_ERRORS_V5, type StakePoolV5 } from "@/lib/v22/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { SimulationRefusal } from "@/lib/tx";

const hook = vi.hoisted(() => ({ state: { pool: null as unknown, deposit: vi.fn(), loading: false, error: null as string | null, status: "ready", retry: () => undefined } }));
vi.mock("@/hooks/useStakeFirstLoss", () => ({ useStakeFirstLoss: () => hook.state }));

import { FirstLossDeposit } from "@/components/stake/FirstLossDeposit";

const k = () => Keypair.generate().publicKey;
const pool = (o: Partial<StakePoolV5> = {}): StakePoolV5 =>
  ({ slab: k(), admin: k(), collateralMint: k(), lpMint: k(), vault: k(), percolatorProgram: k(), riskMode: 1, consentVersion: 2, deployTargetBps: 5000, liquidBufferBps: 3000, hysteresisBps: 500,
    lastSyncSlot: 0n, pendingTargetBps: 0n, pendingTargetSlot: 0n, syncCooldownSlots: 150n, creatorForwardedAtoms: 0n, pendingTargetByProtocol: false,
    totalDeposited: 0n, totalLpSupply: 0n, cooldownSlots: 0n, depositCap: 0n, totalFlushed: 0n, totalReturned: 0n, totalWithdrawn: 0n, poolMode: 0, ...o }) as StakePoolV5;

/** What lib/tx throws when the pre-sign simulation refuses the deposit: the stake program raised `code`. */
function stakeRefusal(code: number): SimulationRefusal {
  const stake = resolveDevnetProgramIds().stake;
  return new SimulationRefusal({ InstructionError: [1, { Custom: code }] }, [
    `Program ${stake} invoke [1]`,
    "Program log: Error: refused",
    `Program ${stake} consumed 4210 of 200000 compute units`,
    `Program ${stake} failed: custom program error: 0x${code.toString(16)}`,
  ]);
}

const RAW = /simulation|InstructionError|Custom|Program|0x[0-9a-f]|\{|\}|\[|https?:|api-key|Logs/i;

async function submitAndReadNote(): Promise<string> {
  render(<FirstLossDeposit slabAddress="S" collateralMint="M" decimals={6} />);
  fireEvent.change(screen.getByTestId("stake-deposit-input"), { target: { value: "5" } });
  fireEvent.click(screen.getByTestId("consent-check"));
  fireEvent.click(screen.getByTestId("first-loss-submit"));
  return (await screen.findByRole("status")).textContent ?? "";
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  hook.state = { pool: pool(), deposit: vi.fn(), loading: false, error: null, status: "ready", retry: () => undefined };
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

describe("#3608 FirstLossDeposit: refused deposits read as plain v2.2 stake copy", () => {
  it.each([
    [33, "ConsentRequired"],
    [28, "DepositBelowMinimumLiquidity"],
    [44, "InsuranceReadingsDiverged"],
  ])("stake error %i (%s): the plain line, never the simulation JSON or logs", async (code, name) => {
    expect(STAKE_ERRORS_V5[code].name).toBe(name);
    hook.state.deposit = vi.fn().mockRejectedValue(stakeRefusal(code));
    const note = await submitAndReadNote();
    expect(note).toBe(STAKE_ERRORS_V5[code].hint);
    expect(note).not.toMatch(RAW);
  });

  it("an RPC failure whose text carries the RPC URL (and its API key) never shows that text", async () => {
    hook.state.deposit = vi.fn().mockRejectedValue(new Error("fetch error at https://devnet.helius-rpc.com/?api-key=0123-secret: socket hang up"));
    const note = await submitAndReadNote();
    expect(note).toBeTruthy();
    expect(note).not.toMatch(RAW);
    expect(note).not.toContain("secret");
  });

  it("a JSON-RPC error object never shows as JSON", async () => {
    hook.state.deposit = vi.fn().mockRejectedValue({ InstructionError: [0, "InvalidAccountData"] });
    const note = await submitAndReadNote();
    expect(note).not.toMatch(RAW);
  });

  it("the app's own plain lines are kept (ConsentChangedError asks for consent again)", async () => {
    hook.state.deposit = vi.fn().mockRejectedValue(new ConsentChangedError(consentViewOf(pool({ deployTargetBps: 7000 }))));
    const note = await submitAndReadNote();
    expect(note).toMatch(/review and accept again/i);
  });
});
