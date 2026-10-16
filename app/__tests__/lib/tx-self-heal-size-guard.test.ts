// @vitest-environment node
/**
 * S3 guard: planSelfHeal accepts a repaired list once its simulation passes, but that simulation
 * omits the CU-price ix sendTx adds afterwards (12 B). With self-heal now on the first trade (the
 * largest tx), a repaired list could pass simulation and still exceed the 1232 B packet once signed,
 * failing after the wallet approved. sendTx now keeps a repaired list only if the final tx fits.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));
const plan = vi.hoisted(() => ({ repairIxs: [] as TransactionInstruction[] }));
vi.mock("@/lib/self-heal", async (orig) => ({
  ...(await orig<object>()),
  isSelfHealEnabled: () => true,
  planSelfHeal: async (p: { instructions: TransactionInstruction[]; computeUnits: number }) => ({
    instructions: [...plan.repairIxs, ...p.instructions],
    computeUnits: p.computeUnits,
    repairs: plan.repairIxs.map(() => ({ kind: "expire-backing-bucket" })),
    outcome: "repaired",
  }),
}));

import { sendTx } from "@/lib/tx";
import { finalTxWireSize, PACKET_DATA_SIZE } from "@/lib/limits/resolved-topup";

const SIG = bs58.encode(new Uint8Array(64).fill(7));
const PROG = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
/** A repair-shaped ix with `n` data bytes (on the one market account). */
const repair = (n: number) => new TransactionInstruction({ programId: PROG, keys: [{ pubkey: market, isSigner: false, isWritable: true }], data: Buffer.alloc(n, 1) });
const userIx = () => new TransactionInstruction({ programId: PROG, keys: [{ pubkey: market, isSigner: false, isWritable: true }], data: Buffer.from([9]) });

function setup() {
  const kp = Keypair.generate();
  const signed: Transaction[] = [];
  const conn = {
    rpcEndpoint: "https://api.devnet.solana.com",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1e7 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    simulateTransaction: vi.fn(async () => ({ value: { err: null, logs: [], unitsConsumed: 1_000 } })),
    sendRawTransaction: vi.fn(async () => SIG),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] }),
  };
  const wallet = { publicKey: kp.publicKey, signTransaction: vi.fn(async (tx: Transaction) => { signed.push(tx); tx.partialSign(kp); return tx; }) };
  return { conn, wallet, signed };
}

describe("sendTx keeps a self-heal only when the final transaction fits the packet", () => {
  it("a repaired list that fits is prepended and reported", async () => {
    const { conn, wallet, signed } = setup();
    plan.repairIxs = [repair(3)];
    const onSelfHeal = vi.fn();
    await sendTx({ connection: conn as never, wallet, instructions: [userIx()], selfHeal: { programId: PROG, market }, onSelfHeal });
    expect(onSelfHeal.mock.calls[0][0].outcome).toBe("repaired");
    expect(signed[0].instructions.some((ix) => ix.data.length === 3)).toBe(true);
  });

  it("a repaired list too big for one packet once the CU price is added is dropped: the tx goes out unchanged", async () => {
    const { conn, wallet, signed } = setup();
    // Grow the repair until the final tx (with all compute-budget ixs) just exceeds the packet.
    let n = 900;
    while (finalTxWireSize([repair(n), userIx()], wallet.publicKey) <= PACKET_DATA_SIZE) n++;
    plan.repairIxs = [repair(n)];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onSelfHeal = vi.fn();
    await sendTx({ connection: conn as never, wallet, instructions: [userIx()], selfHeal: { programId: PROG, market }, onSelfHeal });
    expect(onSelfHeal.mock.calls[0][0].outcome).toBe("oversize");
    expect(signed[0].instructions.some((ix) => ix.data.length === n)).toBe(false); // repair not signed
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/do not fit one transaction/));
    warn.mockRestore();
  });

  it("a repaired list that lands exactly on the 1232 B limit is kept (no false negative)", async () => {
    const { conn, wallet, signed } = setup();
    let n = 900;
    while (finalTxWireSize([repair(n + 1), userIx()], wallet.publicKey) <= PACKET_DATA_SIZE) n++;
    expect(finalTxWireSize([repair(n), userIx()], wallet.publicKey)).toBe(PACKET_DATA_SIZE);
    plan.repairIxs = [repair(n)];
    const onSelfHeal = vi.fn();
    await sendTx({ connection: conn as never, wallet, instructions: [userIx()], selfHeal: { programId: PROG, market }, onSelfHeal });
    expect(onSelfHeal.mock.calls[0][0].outcome).toBe("repaired");
    expect(signed[0].instructions.some((ix) => ix.data.length === n)).toBe(true);
  });
});
