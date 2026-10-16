/**
 * #3426: useCloseTradingAccount acts on the ONE account the row names, after a fresh read, and refuses
 * everything the wrapper would refuse BEFORE the wallet opens. The tx is exactly one instruction:
 * ClosePortfolio, wire = percolator-prog devnet/v22-fresh-ids 81ed7fdf v16_program.rs:9193 (tag 8 then
 * portfolio_id, expected_sequence, position_epoch as u64 LE) and accounts per :19711
 * [closer signer+writable, market writable, portfolio writable].
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useCloseTradingAccount } from "../../hooks/useCloseTradingAccount";

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => {} }));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { TARGET_COPY } from "@/lib/portfolio-target";
import { CLOSE_ACCOUNT_COPY } from "@/lib/close-trading-account";
import { readPortfolioIdentity } from "@/lib/v18-wire";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { OFF, emptied, layoutFor, marketOf, setU128, walletOf, type Fx } from "../helpers/close-account-fixtures";

const PROGRAM = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const TARGET = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const SIBLING = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

describe.each<{ name: string; fx: Fx; flag: boolean }>([
  { name: "v2.1 layout, flag off", fx: "v21", flag: false },
  { name: "v2.2 layout, flag on", fx: "v22", flag: true },
])("useCloseTradingAccount: $name", ({ fx, flag }) => {
  let wallet: PublicKey;
  let market: PublicKey;
  let accounts: Map<string, { data: Buffer; owner: PublicKey; lamports: number }>;
  let connection: { getAccountInfo: ReturnType<typeof vi.fn>; getProgramAccounts: ReturnType<typeof vi.fn> };
  const refresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __setDevnetV22ForTest(flag);
    const d = emptied(fx);
    wallet = walletOf(d);
    market = marketOf(d);
    accounts = new Map([[TARGET.toBase58(), { data: d, owner: PROGRAM, lamports: 49_230_280 }]]);
    connection = {
      getAccountInfo: vi.fn(async (pk: PublicKey) => accounts.get(pk.toBase58()) ?? null),
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection } as never);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet, signTransaction: vi.fn(), connected: true } as never);
    vi.mocked(useSlabState).mockReturnValue({ programId: PROGRAM, refresh } as never);
    vi.mocked(sendTx).mockResolvedValue("sig1" as never);
  });
  afterEach(() => __setDevnetV22ForTest(null));

  const run = async (pk: PublicKey = TARGET) => {
    const { result } = renderHook(() => useCloseTradingAccount(market.toBase58()));
    let thrown: unknown = null;
    let value: unknown = null;
    await act(async () => {
      try {
        value = await result.current.closeAccount(pk);
      } catch (e) {
        thrown = e;
      }
    });
    return { thrown: thrown as Error | null, value, error: result.current.error };
  };
  const put = (data: Buffer, owner = PROGRAM, pk = TARGET) => accounts.set(pk.toBase58(), { data, owner, lamports: 1 });

  it("sends ONE ClosePortfolio with the exact accounts, order, flags and wire bytes", async () => {
    const { thrown, value } = await run();
    expect(thrown).toBeNull();
    expect(value).toEqual({ signature: "sig1", lamports: 49_230_280 });
    expect(sendTx).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendTx).mock.calls[0][0];
    expect(args.instructions).toHaveLength(1);
    expect(args.simulateBeforeSign).toBe(true);
    expect(args.signers ?? []).toHaveLength(0);
    const ix = args.instructions[0];
    expect(ix.programId.equals(PROGRAM)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [wallet.toBase58(), true, true],
      [market.toBase58(), false, true],
      [TARGET.toBase58(), false, true],
    ]);
    const id = readPortfolioIdentity(accounts.get(TARGET.toBase58())!.data);
    const want = Buffer.alloc(25);
    want[0] = 8;
    want.writeBigUInt64LE(id.portfolioId, 1);
    want.writeBigUInt64LE(id.matcherSequence, 9);
    want.writeBigUInt64LE(id.positionEpoch, 17);
    expect(Buffer.from(ix.data).equals(want)).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it("reads the named account fresh at confirmed and never scans for another", async () => {
    await run();
    expect(connection.getAccountInfo).toHaveBeenCalledWith(TARGET, "confirmed");
    expect(connection.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("row binding: with two portfolios on one market only the named one is closed", async () => {
    const other = emptied(fx);
    other.writeBigUInt64LE(999n, layoutFor(fx).matcherConfigOff + 104); // different portfolio_id
    put(other, PROGRAM, SIBLING);
    await run(TARGET);
    const ix = vi.mocked(sendTx).mock.calls[0][0].instructions[0];
    expect(ix.keys[2].pubkey.equals(TARGET)).toBe(true);
    expect(connection.getAccountInfo).not.toHaveBeenCalledWith(SIBLING, expect.anything());
    // and the identity in the data is TARGET's, not the sibling's
    expect(Buffer.from(ix.data).readBigUInt64LE(1)).not.toBe(999n);
  });

  it("an account owned by another wallet is refused before signing", async () => {
    const d = emptied(fx);
    Keypair.generate().publicKey.toBuffer().copy(d, 116);
    put(d);
    const { thrown, error } = await run();
    expect(thrown?.message).toBe(TARGET_COPY.unmatched);
    expect(error).toBe(TARGET_COPY.unmatched);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("an account on another market is refused before signing", async () => {
    const d = emptied(fx);
    Keypair.generate().publicKey.toBuffer().copy(d, 16);
    put(d);
    expect((await run()).thrown?.message).toBe(TARGET_COPY.unmatched);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("an account not owned by the program, or missing, is refused before signing", async () => {
    put(emptied(fx), SIBLING);
    expect((await run()).thrown?.message).toBe(TARGET_COPY.unmatched);
    accounts.delete(TARGET.toBase58());
    expect((await run()).thrown?.message).toBe(TARGET_COPY.unmatched);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("the market's LP is refused before signing", async () => {
    const d = emptied(fx);
    d[layoutFor(fx).matcherConfigOff + 96] |= 1;
    put(d);
    expect((await run()).thrown?.message).toBe(TARGET_COPY.unmatched);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("non-empty accounts are refused before signing, each with its own calm line", async () => {
    const cases: Array<[string, Buffer, string]> = [
      ["capital", setU128(emptied(fx), OFF.capital, 5n), CLOSE_ACCOUNT_COPY.refusals["has-balance"]],
      ["pnl", setU128(emptied(fx), OFF.pnl, 5n), CLOSE_ACCOUNT_COPY.refusals.unsettled],
      [
        "open leg",
        (() => {
          const d = emptied(fx);
          d[layoutFor(fx).legsOff + layoutFor(fx).leg.active] = 1;
          return d;
        })(),
        CLOSE_ACCOUNT_COPY.refusals["open-position"],
      ],
    ];
    for (const [, data, copy] of cases) {
      put(data);
      const { thrown, error } = await run();
      expect(thrown?.message).toBe(copy);
      expect(error).toBe(copy);
    }
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("a chain refusal after a green read is worded for this action, with no raw code", async () => {
    vi.mocked(sendTx).mockRejectedValueOnce(Object.assign(new Error("Transaction simulation failed: custom program error: 0x15"), { name: "SimulationRefusal", code: 21 }));
    const r1 = await run();
    expect(r1.error).toBe(CLOSE_ACCOUNT_COPY.notEmpty);
    vi.mocked(sendTx).mockRejectedValueOnce(Object.assign(new Error("Transaction simulation failed: custom program error: 0x13"), { name: "SimulationRefusal", code: 19 }));
    expect((await run()).error).toBe(CLOSE_ACCOUNT_COPY.changed);
    vi.mocked(sendTx).mockRejectedValueOnce(new Error('{"InstructionError":[0,{"Custom":9999}]} Program 6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM failed'));
    expect((await run()).error).not.toMatch(/Custom|InstructionError|0x/);
  });
});
