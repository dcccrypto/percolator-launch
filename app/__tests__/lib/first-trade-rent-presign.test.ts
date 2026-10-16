// @vitest-environment node
/**
 * A wallet short of a first trade's portfolio rent got "You need a little SOL for network fees":
 * sendTx's simulation gate threw a SimulationRefusal before the balance check that names the rent
 * shortfall could run. The gate now runs that check first when the tx creates an account.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { sendTx, SimulationRefusal } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";

const RENT = 49_230_280; // live, for V17_PORTFOLIO_ACCOUNT_LEN = 9563

function conn(balance: number) {
  return {
    rpcEndpoint: "https://api.devnet.solana.com",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(balance),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1e7 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    // What the runtime says when the payer can't fund CreateAccount.
    simulateTransaction: vi.fn(async () => ({
      value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: [`Transfer: insufficient lamports ${balance}, need ${RENT}`], unitsConsumed: 1_000 },
    })),
  };
}
function wallet() {
  const kp = Keypair.generate();
  return { publicKey: kp.publicKey, signTransaction: vi.fn(async (tx: Transaction) => tx) };
}
const createIx = (from: Keypair["publicKey"]) =>
  SystemProgram.createAccount({ fromPubkey: from, newAccountPubkey: Keypair.generate().publicKey, lamports: RENT, space: V17_PORTFOLIO_ACCOUNT_LEN, programId: SystemProgram.programId });

describe("first trade short of the rent: the shortfall is named before the wallet opens", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a wallet short of the rent gets the shortfall, not 'a little SOL for network fees'", async () => {
    const w = wallet();
    const err = await sendTx({ connection: conn(10_000_000) as never, wallet: w, instructions: [createIx(w.publicKey)], computeUnitsFromSim: { cap: 400_000 } }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SimulationRefusal);
    expect(String(err.message)).toMatch(/Insufficient SOL for transaction fees and account rent/);
    expect(w.signTransaction).not.toHaveBeenCalled();
    const u = resolveUserMessage(err, { surface: "trade", side: "long", symbol: "SOL" });
    expect(u.title).toBe("Need SOL for account rent");
    expect(u.body).toMatch(/^This creates an on-chain account: ~0\.05 SOL of one-time rent plus network fees\. Add at least 0\.\d{3} SOL\.$/);
  });

  it("the line reads its figures from the message, so a market creation's larger rent is quoted, not 0.05", () => {
    const raw =
      "Insufficient SOL for transaction fees and account rent. Balance: 0.100000 SOL, Required: ~0.183000 SOL " +
      "(base fee: 5000 lamports + priority fee: 1000 lamports + ~0.172862 SOL account rent). Please add at least 0.083000 SOL to your wallet.";
    const u = resolveUserMessage(new Error(raw), { surface: "create" });
    expect(u.body).toBe("This creates an on-chain account: ~0.17 SOL of one-time rent plus network fees. Add at least 0.083 SOL.");
  });

  it("rounds the shortfall up, never to 0.000", () => {
    const raw = (add: string) =>
      `Insufficient SOL for transaction fees and account rent. Balance: 1 SOL, Required: ~1 SOL (base fee: 5000 lamports + priority fee: 0 lamports + ~0.049230 SOL account rent). Please add at least ${add} SOL to your wallet.`;
    expect(resolveUserMessage(new Error(raw("0.000200")), { surface: "trade" }).body).toMatch(/Add at least 0\.001 SOL\.$/);
    expect(resolveUserMessage(new Error(raw("0.059400")), { surface: "trade" }).body).toMatch(/Add at least 0\.060 SOL\.$/);
  });

  it("CONTROL: a funded wallet whose tx fails for another reason still gets the SimulationRefusal", async () => {
    const w = wallet();
    const err = await sendTx({ connection: conn(5_000_000_000) as never, wallet: w, instructions: [createIx(w.publicKey)], computeUnitsFromSim: { cap: 400_000 } }).catch((e) => e);
    expect(err).toBeInstanceOf(SimulationRefusal);
  });
});
