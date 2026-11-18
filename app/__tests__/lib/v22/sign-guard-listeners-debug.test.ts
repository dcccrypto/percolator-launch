// @vitest-environment node
/**
 * Coverage for the remaining sign-guard branches: the problem-line subscription (subscribeSignGuard /
 * dismissSignProblem), the `?signdebug` switch when localStorage throws, and the account-presence probe failing
 * (its failure must never stop the guard from asking the wallet, nor mark a refusal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import {
  __resetSignGuardForTest, dismissSignProblem, guardSign, isSignDebugEnabled, lastSignProblem, noteBlockhash, SignGuardError, signLog, subscribeSignGuard,
} from "@/lib/v22/sign-guard";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const payer = Keypair.generate();
const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function tradeTx(): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
  tx.add(new TransactionInstruction({
    programId: WRAPPER,
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: Buffer.from([10, 1, 2]),
  }));
  tx.recentBlockhash = BH;
  tx.feePayer = payer.publicKey;
  return tx;
}

describe("sign-guard listeners, debug switch, probe failure", () => {
  beforeEach(() => {
    __setDevnetV22ForTest(true);
    __resetSignGuardForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("a refused signature notifies subscribers; dismissSignProblem clears it and notifies again; unsubscribe stops it", async () => {
    const c = { getGenesisHash: vi.fn(async () => MAINNET_GENESIS), isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })) };
    noteBlockhash(BH, "sendTx attempt 1", c, 1_000);
    const fn = vi.fn();
    const off = subscribeSignGuard(fn);
    try {
      const sign = vi.fn(async () => "signed");
      await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign, now: () => 2_000 })).rejects.toBeInstanceOf(SignGuardError);
      expect(sign).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(lastSignProblem()).not.toBeNull();

      dismissSignProblem();
      expect(lastSignProblem()).toBeNull();
      expect(fn).toHaveBeenCalledTimes(2);

    } finally { off(); }
    dismissSignProblem();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  const stubWindow = (search: string, store: Record<string, string>, throws = false) => vi.stubGlobal("window", {
    location: { search },
    localStorage: {
      getItem: (k: string) => { if (throws) throw new Error("denied"); return store[k] ?? null; },
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
  });

  it("?signdebug=1 is stored, =0 clears it", () => {
    const store: Record<string, string> = {};
    stubWindow("?signdebug=1", store);
    expect(isSignDebugEnabled()).toBe(true);
    stubWindow("?signdebug=0", store);
    expect(isSignDebugEnabled()).toBe(false);
    expect(store).toEqual({});
  });

  it("localStorage that throws reads as debug off", () => {
    stubWindow("", {}, true);
    expect(isSignDebugEnabled()).toBe(false);
  });

  it("an account probe that rejects proves nothing: the wallet is still asked and nothing is flagged absent", async () => {
    const c = {
      getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH),
      isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })),
      getMultipleAccountsInfo: vi.fn(async () => { throw new Error("429 rate limited"); }),
    };
    noteBlockhash(BH, "sendTx attempt 1", c, 1_000);
    const sign = vi.fn(async () => "signed");
    await expect(guardSign({ txs: [tradeTx()], via: "adapter signTransaction", connection: c, chain: "solana:devnet", sign, now: () => 2_000 })).resolves.toBe("signed");
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(signLog()[0]).toMatchObject({ verdict: "ok", wallet: "signed", absentOnDevnet: null });
  });
});
