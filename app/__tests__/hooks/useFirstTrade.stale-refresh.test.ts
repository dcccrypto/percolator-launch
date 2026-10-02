/**
 * GH#2953: the first trade on a market whose K/F cohort is stale (the keeper could not refresh
 * every positioned portfolio) was refused Custom(21) in the A+B simulation, every time. The hook
 * now refreshes the stale portfolios at the FRONT of B (the trade's own transaction) when, and
 * only when, that clears the 19/21 in the same simulation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { encodePermissionlessCrank } from "@percolatorct/sdk";

const WRAPPER = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const owner = Keypair.generate().publicKey;
const signAll = vi.fn();
const simulateForGate = vi.fn();
const buildBatchTx = vi.fn((_p: { instructions: TransactionInstruction[]; computeUnits: number }) => ({}));
const staleMock = vi.hoisted(() => ({
  cohort: null as null | { kfEpoch: [bigint, bigint]; stale: [bigint, bigint] },
  found: [] as unknown[],
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: owner, signAllTransactions: signAll }),
  useConnectionCompat: () => ({
    connection: {
      getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8192) })),
      getMinimumBalanceForRentExemption: vi.fn(async () => 1_000_000),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 })),
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
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 1n, matcherSequence: 0n, positionEpoch: 0n })),
}));
vi.mock("@/hooks/useTrade", () => ({
  findV17Portfolio: vi.fn(async () => null),
  resolveLpTradeAccounts: vi.fn(async () => ({
    accountB: Keypair.generate().publicKey,
    matcherProg: Keypair.generate().publicKey,
    matcherCtx: Keypair.generate().publicKey,
    matcherDelegate: Keypair.generate().publicKey,
  })),
}));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/first-trade", async (orig) => {
  const real = await orig<typeof import("@/lib/first-trade")>();
  const ix = (tag: number) => new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.from([tag]) });
  return {
    ...real,
    readNextPortfolioId: () => 2n,
    buildFirstTradeInitIxs: () => [ix(1), ix(2)],
    buildFundAndTradeIxs: () => [ix(3), ix(10)],
  };
});
vi.mock("@/lib/stale-refresh", async (orig) => {
  const real = await orig<typeof import("@/lib/stale-refresh")>();
  return { ...real, decodeStaleCohort: () => staleMock.cohort, findStalePortfolios: vi.fn(async () => staleMock.found) };
});
vi.mock("@/lib/tx", async (orig) => {
  const real = await orig<typeof import("@/lib/tx")>();
  return {
    ...real,
    simulateForGate: (...a: unknown[]) => simulateForGate(...a),
    getPriorityFee: vi.fn(async () => 1),
    buildBatchTx: (p: { instructions: TransactionInstruction[]; computeUnits: number }) => buildBatchTx(p),
    broadcastSignedTx: vi.fn(async () => "sig"),
    signAllCompat: (...a: unknown[]) => signAll(...a),
    sendTx: vi.fn(),
  };
});

import { useFirstTrade } from "@/hooks/useFirstTrade";
import { SimulationRefusal } from "@/lib/tx";
import { STALE_REFRESH_CU } from "@/lib/stale-refresh";
import { tradeCuCap } from "@/lib/compute-budget";

const REFRESH_DATA = Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: [] }));
const isRefresh = (ix: TransactionInstruction) => ix.programId.equals(WRAPPER) && Buffer.from(ix.data).equals(REFRESH_DATA);
/** Stand-ins for simulateForGate's two compute-budget instructions (jsdom cannot encode the real ones). */
const PREFIX = [0, 1].map((t) => new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([t]) }));

/** The engine: the trade (last ix) is refused 21 unless every stale portfolio is refreshed before it.
 *  `refuseRefreshes` = how many healed simulations refuse the refresh itself with 22 first. */
function engine(stale: PublicKey[], refuseRefreshes = 0) {
  let refused = 0;
  return async (_c: unknown, _o: unknown, ixs: TransactionInstruction[]) => {
    const simulated = [...PREFIX, ...ixs];
    const firstRefresh = simulated.findIndex(isRefresh);
    if (firstRefresh >= 0 && refused < refuseRefreshes) {
      refused++;
      return { consumed: null, err: { InstructionError: [firstRefresh, { Custom: 22 }] }, logs: [], rpcFailed: false, simulated };
    }
    if (ixs.length === 2) return { consumed: 40_000, err: null, logs: [], rpcFailed: false, simulated };
    const refreshed = ixs.filter(isRefresh).map((ix) => ix.keys[2].pubkey.toBase58());
    if (stale.length > 0 && stale.every((p) => refreshed.includes(p.toBase58()))) {
      return { consumed: 500_000, err: null, logs: [], rpcFailed: false, simulated };
    }
    return {
      consumed: null,
      err: { InstructionError: [simulated.length - 1, { Custom: 21 }] },
      logs: [`Program ${WRAPPER.toBase58()} failed: custom program error: 0x15`],
      rpcFailed: false,
      simulated,
    };
  };
}

describe("GH#2953 useFirstTrade: stale-cohort refresh inside B", () => {
  beforeEach(() => {
    signAll.mockReset();
    simulateForGate.mockReset();
    buildBatchTx.mockClear();
    signAll.mockImplementation(async (_w: unknown, txs: unknown[]) => txs.map(() => ({ partialSign: vi.fn() })));
  });

  const run = async () => {
    const { result } = renderHook(() => useFirstTrade(Keypair.generate().publicKey.toBase58()));
    let err: unknown = null;
    await act(async () => {
      try {
        await result.current.fundAndTrade({ size: 1_000n, depositAtoms: 2_210_000n, limitPriceE6: 3_700n, amountLabel: "2.21 USDC" });
      } catch (e) {
        err = e;
      }
    });
    return err;
  };

  it("21 on a stale market: B = [refresh x2, deposit, trade], one prompt, CU raised per refresh", async () => {
    const stale = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    staleMock.cohort = { kfEpoch: [9n, 9n], stale: [2n, 0n] };
    staleMock.found = stale;
    simulateForGate.mockImplementation(engine(stale));
    const err = await run();
    expect(err).toBeNull();
    expect(signAll).toHaveBeenCalledTimes(1);
    const b = buildBatchTx.mock.calls[1][0];
    expect(b.instructions).toHaveLength(4);
    expect(b.instructions.slice(0, 2).map((ix) => ix.keys[2].pubkey.toBase58())).toEqual(stale.map((p) => p.toBase58()));
    expect(b.instructions[0].keys[0].pubkey.equals(owner)).toBe(true);
    expect(Array.from(b.instructions[2].data)).toEqual([3]); // deposit
    expect(Array.from(b.instructions[3].data)).toEqual([10]); // trade
    expect(b.computeUnits).toBe(tradeCuCap(1) + 60_000 + 2 * STALE_REFRESH_CU);
    // tx A is unchanged
    expect(buildBatchTx.mock.calls[0][0].instructions).toHaveLength(2);
  });

  it("a refresh refused 22 (newer mark pending) is retried; kept once it clears", async () => {
    const stale = [Keypair.generate().publicKey];
    staleMock.cohort = { kfEpoch: [9n, 9n], stale: [1n, 0n] };
    staleMock.found = stale;
    simulateForGate.mockImplementation(engine(stale, 1));
    const err = await run();
    expect(err).toBeNull();
    expect(simulateForGate).toHaveBeenCalledTimes(4); // A, A+B, healed (22), healed (ok)
    expect(buildBatchTx.mock.calls[1][0].instructions.filter(isRefresh)).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: refreshes refused 22 every attempt -> the user's own 21 surfaces (never the 22)", async () => {
    const stale = [Keypair.generate().publicKey];
    staleMock.cohort = { kfEpoch: [9n, 9n], stale: [1n, 0n] };
    staleMock.found = stale;
    simulateForGate.mockImplementation(engine(stale, 99));
    const err = await run();
    expect(err).toBeInstanceOf(SimulationRefusal);
    expect((err as SimulationRefusal).code).toBe(21);
    expect(signAll).not.toHaveBeenCalled();
    expect(simulateForGate).toHaveBeenCalledTimes(2 + 3);
  }, 15_000);

  it("NEGATIVE CONTROL: the same 21 on a market with NO stale cohort is refused before the wallet opens", async () => {
    staleMock.cohort = { kfEpoch: [9n, 9n], stale: [0n, 0n] };
    staleMock.found = [];
    simulateForGate.mockImplementation(engine([]));
    const err = await run();
    expect(err).toBeInstanceOf(SimulationRefusal);
    expect((err as SimulationRefusal).code).toBe(21);
    expect(signAll).not.toHaveBeenCalled();
    expect(simulateForGate).toHaveBeenCalledTimes(2); // A, A+B: no repair attempt
  });

  it("NEGATIVE CONTROL: refreshes that do not clear the 21 are not kept; still refused pre-sign", async () => {
    const stale = [Keypair.generate().publicKey];
    staleMock.cohort = { kfEpoch: [9n, 9n], stale: [1n, 0n] };
    staleMock.found = [Keypair.generate().publicKey]; // the wrong portfolio: the engine stays locked
    simulateForGate.mockImplementation(engine(stale));
    const err = await run();
    expect(err).toBeInstanceOf(SimulationRefusal);
    expect(signAll).not.toHaveBeenCalled();
    expect(simulateForGate).toHaveBeenCalledTimes(2 + 3); // every attempt re-reads and re-tries
  }, 15_000);
});
