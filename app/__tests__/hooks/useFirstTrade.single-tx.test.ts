/**
 * GH#2959: the first trade on a market is ONE transaction [create, init, deposit, trade].
 * It used to be two (A = create+init, B = deposit+trade) signed together with
 * signAllTransactions; a wallet that simulates each transaction on its own (Solflare) saw B fail
 * {"InstructionError":[3,"IncorrectProgramId"]} (the portfolio does not exist until A lands),
 * showed "Simulation failed" and disabled Approve.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Keypair, PublicKey, TransactionInstruction, type Signer } from "@solana/web3.js";

const WRAPPER = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const owner = Keypair.generate().publicKey;
const signAll = vi.fn();
const signOne = vi.fn();
const sendTx = vi.fn();
const findV17Portfolio = vi.fn();

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: owner, signAllTransactions: signAll, signTransaction: signOne }),
  useConnectionCompat: () => ({
    connection: {
      getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8192) })),
      getMinimumBalanceForRentExemption: vi.fn(async () => 1_000_000),
    },
  }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: { collateralMint: Keypair.generate().publicKey },
    programId: WRAPPER,
    wrapperConfigV17: { tradeFeeBps: 5n },
    refresh: vi.fn(),
  }),
}));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  getAta: vi.fn(async () => Keypair.generate().publicKey),
  deriveVaultAuthority: vi.fn(() => [Keypair.generate().publicKey, 255]),
}));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: vi.fn() }));
vi.mock("@/lib/deposit-guard", () => ({ assertDepositWithinBalance: vi.fn() }));
vi.mock("@/lib/v18-wire", () => ({
  fetchAssetMarketId: vi.fn(async () => 1n),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 7n, matcherSequence: 3n, positionEpoch: 1n })),
}));
vi.mock("@/hooks/useTrade", () => ({
  findV17Portfolio: (...a: unknown[]) => findV17Portfolio(...a),
  resolveLpTradeAccounts: vi.fn(async () => ({
    accountB: Keypair.generate().publicKey,
    matcherProg: Keypair.generate().publicKey,
    matcherCtx: Keypair.generate().publicKey,
    matcherDelegate: Keypair.generate().publicKey,
  })),
}));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
const nextIds: bigint[] = [];
vi.mock("@/lib/first-trade", async (orig) => {
  const real = await orig<typeof import("@/lib/first-trade")>();
  const ix = (tag: number, k: PublicKey) => new TransactionInstruction({ programId: WRAPPER, keys: [{ pubkey: k, isSigner: false, isWritable: true }], data: Buffer.from([tag]) });
  return {
    ...real,
    readNextPortfolioId: () => nextIds.shift() ?? 2n,
    buildFirstTradeInitIxs: (p: { portfolio: PublicKey }) => [ix(1, p.portfolio), ix(2, p.portfolio)],
    buildFundAndTradeIxs: (p: { portfolio: PublicKey }, id: { portfolioId: bigint }) => [ix(3, p.portfolio), ix(10 + Number(id.portfolioId), p.portfolio)],
  };
});
vi.mock("@/lib/tx", async (orig) => {
  const real = await orig<typeof import("@/lib/tx")>();
  return {
    ...real,
    sendTx: (...a: unknown[]) => sendTx(...a),
    signAllCompat: (...a: unknown[]) => signAll(...a),
  };
});

import { useFirstTrade, FIRST_TRADE_CU_CAP, PRESIGN_WAIT_ATTEMPTS, isPresignWaitable } from "@/hooks/useFirstTrade";
import { SimulationRefusal } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";

type SendArgs = { instructions: TransactionInstruction[]; signers?: Signer[]; computeUnitsFromSim?: { cap: number } };
const call = (i: number) => sendTx.mock.calls[i][0] as SendArgs;
const refusal = (code: number) =>
  new SimulationRefusal({ InstructionError: [5, { Custom: code }] }, [`Program ${WRAPPER.toBase58()} failed: custom program error: 0x${code.toString(16)}`], [
    ...Array.from({ length: 5 }, () => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })),
    new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.alloc(0) }),
  ]);

async function run(onRace?: () => void) {
  const { result } = renderHook(() => useFirstTrade(Keypair.generate().publicKey.toBase58()));
  let err: unknown = null;
  let out: Awaited<ReturnType<typeof result.current.fundAndTrade>> | null = null;
  await act(async () => {
    try {
      out = await result.current.fundAndTrade({ size: 1_000n, depositAtoms: 5_520_000n, limitPriceE6: 3_700n, amountLabel: "5.52 USDC", onRace });
    } catch (e) {
      err = e;
    }
  });
  return { err, out: out as Awaited<ReturnType<typeof result.current.fundAndTrade>> | null };
}

describe("GH#2959 useFirstTrade: the first trade is ONE transaction", () => {
  beforeEach(() => {
    sendTx.mockReset();
    signAll.mockReset();
    signOne.mockReset();
    findV17Portfolio.mockReset();
    findV17Portfolio.mockResolvedValue(null);
    nextIds.length = 0;
  });

  it("no account: one sendTx of [create, init, deposit, trade], the portfolio keypair as co-signer; never signAllTransactions", async () => {
    sendTx.mockResolvedValue("sigOne");
    const { err, out } = await run();
    expect(err).toBeNull();
    expect(sendTx).toHaveBeenCalledTimes(1);
    const a = call(0);
    expect(a.instructions.map((ix) => ix.data[0])).toEqual([1, 2, 3, 12]);
    expect(a.signers).toHaveLength(1);
    // every leg targets the keypair's portfolio, and that is what the hook returns
    const pf = a.signers![0].publicKey;
    expect(a.instructions.every((ix) => ix.keys[0].pubkey.equals(pf))).toBe(true);
    expect(out).toMatchObject({ signature: "sigOne", prompts: 1, created: true });
    expect(out!.portfolio.equals(pf)).toBe(true);
    expect(a.computeUnitsFromSim).toEqual({ cap: FIRST_TRADE_CU_CAP });
    expect(signAll).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: an existing account sends [deposit, trade] with no co-signer", async () => {
    findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey);
    sendTx.mockResolvedValue("sigFund");
    const { err, out } = await run();
    expect(err).toBeNull();
    expect(call(0).instructions.map((ix) => ix.data[0])).toEqual([3, 17]);
    expect(call(0).signers).toBeUndefined();
    expect(out).toMatchObject({ created: false, prompts: 1 });
  });

  it("a pre-sign 21 (keeper mid-cycle) is re-checked before the wallet opens, then goes through", async () => {
    sendTx.mockRejectedValueOnce(refusal(21)).mockResolvedValueOnce("sigAfterWait");
    const { err, out } = await run();
    expect(err).toBeNull();
    expect(sendTx).toHaveBeenCalledTimes(2);
    expect(out?.signature).toBe("sigAfterWait");
  }, 10_000);

  it("NEGATIVE CONTROL: a 21 that persists surfaces after the bounded re-checks (never loops)", async () => {
    sendTx.mockRejectedValue(refusal(21));
    const { err } = await run();
    expect(err).toBeInstanceOf(SimulationRefusal);
    expect((err as SimulationRefusal).code).toBe(21);
    expect(sendTx).toHaveBeenCalledTimes(1 + PRESIGN_WAIT_ATTEMPTS);
  }, 15_000);

  it("NEGATIVE CONTROL: a refusal the keeper does not clear (67) is not waited on", async () => {
    sendTx.mockRejectedValue(refusal(67));
    const { err } = await run();
    expect((err as SimulationRefusal).code).toBe(67);
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("NEGATIVE CONTROL: a 21 from an on-chain failure (after signing) is never re-sent", async () => {
    sendTx.mockRejectedValue(new Error(`{"InstructionError":[6,{"Custom":21}]}`));
    const { err } = await run();
    expect(err).toBeInstanceOf(Error);
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("id race after signing (tx reverted, nothing landed): rebuilt at the new next id, one more prompt, labelled", async () => {
    nextIds.push(2n, 3n);
    const onRace = vi.fn();
    sendTx.mockRejectedValueOnce(new Error(`{"InstructionError":[5,{"Custom":16}]}`)).mockResolvedValueOnce("sigRace");
    const { err, out } = await run(onRace);
    expect(err).toBeNull();
    expect(onRace).toHaveBeenCalledTimes(1);
    expect(call(0).instructions[3].data[0]).toBe(12);
    expect(call(1).instructions[3].data[0]).toBe(13);
    expect(call(1).signers![0].publicKey.equals(call(0).signers![0].publicKey)).toBe(false);
    expect(out).toMatchObject({ signature: "sigRace", prompts: 2 });
  });

  it("id race caught BEFORE the wallet opened: rebuilt silently, still one prompt", async () => {
    nextIds.push(2n, 3n);
    const onRace = vi.fn();
    sendTx.mockRejectedValueOnce(refusal(16)).mockResolvedValueOnce("sigQuiet");
    const { out } = await run(onRace);
    expect(onRace).not.toHaveBeenCalled();
    expect(out).toMatchObject({ signature: "sigQuiet", prompts: 1 });
  });

  it("isPresignWaitable: only a pre-sign 19/21 raised by THIS wrapper", () => {
    expect(isPresignWaitable(refusal(19), WRAPPER)).toBe(true);
    expect(isPresignWaitable(refusal(21), WRAPPER)).toBe(true);
    expect(isPresignWaitable(refusal(49), WRAPPER)).toBe(false);
    expect(isPresignWaitable(refusal(21), Keypair.generate().publicKey)).toBe(false);
    expect(isPresignWaitable(new Error(`{"InstructionError":[5,{"Custom":21}]}`), WRAPPER)).toBe(false);
  });

  it("'No portfolio account found' maps to a plain line, not 'Something went wrong'", () => {
    const u = resolveUserMessage(new Error("No portfolio account found for your wallet on this market. Please deposit collateral first to create a portfolio."), { surface: "trade" });
    expect(u.kind).toBe("no-account");
  });
});
