// @vitest-environment node
/**
 * #2743 input contract: the REAL simulateForGate reports a simulation that could not run as
 * `rpcFailed: true` with `err: null` — i.e. `err` alone cannot tell "would land" from "never
 * checked". The claim gate (useClaimCreatorFees -> runOneApproval) must read `rpcFailed`.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, TransactionInstruction, type Connection } from "@solana/web3.js";
import { simulateForGate } from "@/lib/tx";

const ix = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([90]) });
const payer = Keypair.generate().publicKey;

describe("simulateForGate verdict shape", () => {
  it("RPC throws: no verdict -> err null, rpcFailed true, no CU measurement", async () => {
    const connection = { simulateTransaction: vi.fn(async () => { throw new Error("503 Service Unavailable"); }) } as unknown as Connection;
    const g = await simulateForGate(connection, payer, [ix]);
    expect(g).toMatchObject({ err: null, rpcFailed: true, consumed: null });
  });
  it("simulation ran and would land: err null, rpcFailed false", async () => {
    const connection = { simulateTransaction: vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 9_000 } })) } as unknown as Connection;
    const g = await simulateForGate(connection, payer, [ix]);
    expect(g).toMatchObject({ err: null, rpcFailed: false, consumed: 9_000 });
  });
});
