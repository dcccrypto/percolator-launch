// @vitest-environment node
/** sign-guard leads: a wall clock that steps back while the wallet popup is open, NaN elapsed, malformed keys. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import { __resetSignGuardForTest, accountsCreatedIn, forbiddenKeysIn, guardSign, isWalletBusyRejection, noteBlockhash, WalletBusyError, WalletRequestClosedError } from "@/lib/v22/sign-guard";

const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const payer = Keypair.generate();
function tx(): Transaction {
  const t = new Transaction();
  t.add(new TransactionInstruction({ programId: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"), keys: [], data: Buffer.from([10]) }));
  t.recentBlockhash = BH;
  t.feePayer = payer.publicKey;
  return t;
}
const cancel = () => Object.assign(new Error("Transaction cancelled"), { name: "JsonRpcError" });
const bareCancelled = () => ({ code: 4001, message: "Cancelled" });

/** blockhash noted `ageAtOpenMs` before open; the clock then moves by `delta` (negative = stepped back); the RPC is down. */
async function run(err: unknown, ageAtOpenMs: number, delta: number): Promise<unknown> {
  let clock = 1_000_000;
  const c = { getGenesisHash: async () => DEVNET_GENESIS_HASH, isBlockhashValid: async () => { throw new Error("rpc down"); } };
  noteBlockhash(BH, "sendTx attempt 1", c, clock - ageAtOpenMs);
  return guardSign({
    txs: [tx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", now: () => clock,
    sign: async () => { clock += delta; throw err; },
  }).catch((e) => e);
}

describe("sign-guard clock leads", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("lead 1: blockhash already 50 s old at open, clock steps back 60 s -> still an expiry", async () => {
    expect(await run(cancel(), 50_000, -60_000)).toBeInstanceOf(WalletRequestClosedError);
  });
  it("lead 1b: a negative elapsed time is not a 'refused unshown' wallet-busy rejection", async () => {
    expect(isWalletBusyRejection(bareCancelled(), -60_000)).toBe(false);
    expect(await run(bareCancelled(), 5_000, -60_000)).not.toBeInstanceOf(WalletBusyError);
  });
  it("lead 3: NaN elapsed is not busy", () => {
    expect(isWalletBusyRejection(bareCancelled(), NaN)).toBe(false);
  });
  it("lead 2: forbiddenKeysIn does not use curve checks; malformed keys cannot reach isOnCurve", () => {
    const k = Keypair.generate().publicKey;
    const t = new Transaction().add(new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: k, isSigner: false, isWritable: false }], data: Buffer.alloc(0) }));
    expect(forbiddenKeysIn(t, new Set([k.toBase58()]))).toEqual([k.toBase58()]);
    expect(() => PublicKey.isOnCurve(new Uint8Array(32))).not.toThrow();
  });
  it("lead 4: an undecodable System instruction creates nothing", () => {
    const t = new Transaction().add(new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.from([255, 255, 255, 255]) }));
    expect(accountsCreatedIn(t).size).toBe(0);
  });
});
