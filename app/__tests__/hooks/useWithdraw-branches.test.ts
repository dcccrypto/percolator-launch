/**
 * useWithdraw: remaining branches (guards, legacy v12 path, scan-store and GPA
 * fallbacks, convert-released-pnl plan, error mapping, notice / refresh).
 * Complements useWithdraw.test.ts, -portfolio-fastpath, -engine-stale-19 and .strict-target.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWithdraw } from "../../hooks/useWithdraw";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/errorMessages", () => ({
  UserFacingError: class UserFacingError extends Error {},
  userFacingMessage: vi.fn(() => null),
  humanizeError: vi.fn((msg: string) => `H:${msg}`),
}));
vi.mock("@/lib/config", () => ({}));
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: vi.fn(),
}));
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: vi.fn(() => undefined),
  makePortfolioScanKey: vi.fn(() => "test-key"),
  isLpPortfolio: vi.fn(() => false),
}));
vi.mock("@/lib/convert-released-pnl", async (orig) => ({
  ...(await orig<object>()),
  planConvertWithdraw: vi.fn(),
}));
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<object>()),
  parsePortfolio: (...a: Parameters<typeof parsePortfolioV17>) => parsePortfolioV17(...a),
  isWrapperAccount: vi.fn(() => false),
}));

const mockVaultAuth = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const mockOraclePda = new PublicKey("8DjWTsU1o8RHTKpRsqGFyYqFMknb8g7z2mjLfVYUyYyF");

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  return {
    ...actual,
    getAta: vi.fn(),
    deriveVaultAuthority: vi.fn(() => [mockVaultAuth, 255]),
    derivePythPushOraclePDA: vi.fn(() => [mockOraclePda, 255]),
    parsePortfolioV17: vi.fn(),
  };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta, parsePortfolioV17 } from "@percolatorct/sdk";
import { getPortfolioRawSnapshot, isLpPortfolio } from "@/lib/userAccountScan";
import { userFacingMessage } from "@/lib/errorMessages";
import { planConvertWithdraw, WithdrawRefusal } from "@/lib/convert-released-pnl";
import { isWrapperAccount } from "@/lib/v22/layout";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { WITHDRAW_OPEN_POSITIONS_MESSAGE } from "@/lib/withdraw-copy";

describe("useWithdraw branches", () => {
  const slab = "11111111111111111111111111111111";
  const walletPk = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const vault = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const ata = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
  const storePk = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  const pkA = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const pkB = new PublicKey("Vote111111111111111111111111111111111111111");

  let conn: any;
  let state: any;
  let wallet: any;

  const portfolio = (over: object = {}) => ({
    owner: walletPk,
    legs: [],
    pnl: 0n,
    capital: 10_000_000n,
    portfolioId: 42n,
    matcherSequence: 7n,
    matcherPositionEpoch: 0n,
    ...over,
  });

  const run = (p: object = {}) => {
    const h = renderHook(() => useWithdraw(slab));
    return { h, call: () => h.result.current.withdraw({ userIdx: 1, amount: 1n, ...p } as any) };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(1288) }),
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: pkA, account: { data: Buffer.alloc(1288) } }]),
    };
    wallet = { publicKey: walletPk, signTransaction: vi.fn(), connected: true };
    state = {
      config: {
        collateralMint: mint,
        vaultPubkey: vault,
        oracleAuthority: PublicKey.default,
        indexFeedId: new PublicKey(new Uint8Array(32).fill(1)),
        authorityPriceE6: 1000000n,
        lastEffectivePriceE6: 1000000n,
        invert: false,
      },
      wrapperConfigV17: { oracleMode: 0 },
      params: { initialMarginBps: 1000n },
      programId,
      refresh: vi.fn(),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: conn });
    vi.mocked(useWalletCompat).mockReturnValue(wallet);
    vi.mocked(useSlabState).mockReturnValue(state);
    vi.mocked(sendTx).mockResolvedValue({ signature: "sig" } as any);
    vi.mocked(getAta).mockResolvedValue(ata);
    vi.mocked(parsePortfolioV17).mockReturnValue(portfolio() as any);
    vi.mocked(getPortfolioRawSnapshot).mockReturnValue(undefined);
    vi.mocked(isLpPortfolio).mockReturnValue(false);
    vi.mocked(isWrapperAccount).mockReturnValue(false);
    vi.mocked(userFacingMessage).mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("guards", () => {
    it("wallet not connected: errors, never sends", async () => {
      wallet.publicKey = null;
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow("Wallet not connected");
      });
      expect(h.result.current.error).toBe("H:Wallet not connected");
      expect(h.result.current.loading).toBe(false);
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("market not loaded (no config / no program id)", async () => {
      state.config = null;
      const { call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow("Market not loaded");
      });
      state.config = { collateralMint: mint, vaultPubkey: vault, indexFeedId: new PublicKey(new Uint8Array(32).fill(1)) };
      state.programId = undefined;
      const r1 = run();
      await act(async () => {
        await expect(r1.call()).rejects.toThrow("Market not loaded");
      });
    });

    it("a second withdraw while one is in flight is refused", async () => {
      let release!: (v: any) => void;
      vi.mocked(sendTx).mockReturnValue(new Promise((r) => (release = r)) as any);
      const { h } = run();
      let first!: Promise<unknown>;
      await act(async () => {
        first = h.result.current.withdraw({ userIdx: 1, amount: 1n });
        await Promise.resolve();
      });
      await act(async () => {
        await expect(h.result.current.withdraw({ userIdx: 1, amount: 1n })).rejects.toThrow("Withdrawal already in progress");
      });
      await act(async () => {
        release({ signature: "s" });
        await first;
      });
      expect(h.result.current.loading).toBe(false);
    });

    it("an unknown program is refused by the allowlist before any RPC", async () => {
      vi.mocked(assertKnownProgram).mockImplementationOnce(() => {
        throw new Error("unknown program");
      });
      const { call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow("unknown program");
      });
      expect(conn.getAccountInfo).not.toHaveBeenCalled();
      expect(sendTx).not.toHaveBeenCalled();
    });
  });

  describe("legacy (no wrapperConfigV17) layout detection", () => {
    beforeEach(() => {
      state.wrapperConfigV17 = null;
    });

    it("market missing on this network is refused", async () => {
      conn.getAccountInfo.mockResolvedValue(null);
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow(/Market not found/);
      });
      expect(sendTx).not.toHaveBeenCalled();
      expect(h.result.current.error).toBeTruthy();
    });

    it("an RPC failure on the network check is tolerated; non-wrapper data takes the v12 path (crank + withdraw)", async () => {
      conn.getAccountInfo.mockRejectedValue(new Error("rpc down"));
      const { call } = run();
      await act(async () => {
        await call();
      });
      const { instructions, computeUnits } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions).toHaveLength(2);
      expect(instructions[1].keys).toHaveLength(8);
      expect(computeUnits).toBe(300_000);
      expect(conn.getProgramAccounts).not.toHaveBeenCalled();
    });

    it("pyth-pinned oracle mode uses the derived pyth PDA as the crank oracle account", async () => {
      const { call } = run();
      await act(async () => {
        await call();
      });
      const { instructions } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions[1].keys[7].pubkey.equals(mockOraclePda)).toBe(true);
    });

    it("fresh data that IS a wrapper account switches to the v17 path", async () => {
      vi.mocked(isWrapperAccount).mockReturnValue(true);
      const { call } = run({ portfolioPk: storePk });
      await act(async () => {
        await call();
      });
      const { instructions } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions).toHaveLength(1);
      expect(instructions[0].keys[2].pubkey.equals(storePk)).toBe(true);
    });
  });

  describe("portfolio lookup fallbacks", () => {
    it("scan-store pubkey: one targeted read replaces the GPA scan", async () => {
      vi.mocked(getPortfolioRawSnapshot).mockReturnValue({ pubkey: storePk } as any);
      const { call } = run();
      await act(async () => {
        await call();
      });
      expect(conn.getAccountInfo).toHaveBeenCalledWith(storePk, "confirmed");
      expect(conn.getProgramAccounts).not.toHaveBeenCalled();
      const { instructions } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions[0].keys[2].pubkey.equals(storePk)).toBe(true);
    });

    it("scan-store account owned by someone else falls through to the GPA scan", async () => {
      vi.mocked(getPortfolioRawSnapshot).mockReturnValue({ pubkey: storePk } as any);
      vi.mocked(parsePortfolioV17)
        .mockReturnValueOnce(portfolio({ owner: pkB }) as any)
        .mockReturnValue(portfolio() as any);
      const { call } = run();
      await act(async () => {
        await call();
      });
      expect(conn.getProgramAccounts).toHaveBeenCalledTimes(1);
      const { instructions } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions[0].keys[2].pubkey.equals(pkA)).toBe(true);
    });

    it("scan-store read throwing, or the account missing, falls through to the GPA scan", async () => {
      vi.mocked(getPortfolioRawSnapshot).mockReturnValue({ pubkey: storePk } as any);
      conn.getAccountInfo.mockRejectedValueOnce(new Error("429"));
      const r2 = run();
      await act(async () => {
        await r2.call();
      });
      expect(conn.getProgramAccounts).toHaveBeenCalledTimes(1);

      conn.getAccountInfo.mockResolvedValueOnce(null);
      const r3 = run();
      await act(async () => {
        await r3.call();
      });
      expect(conn.getProgramAccounts).toHaveBeenCalledTimes(2);
    });

    it("scan sorts by pubkey and drops the LP portfolio", async () => {
      // pkA < pkB lexicographically? compute so the test does not depend on it
      const [lo, hi] = [pkA, pkB].sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
      const lpData = Buffer.alloc(1288, 9);
      conn.getProgramAccounts.mockResolvedValue([
        { pubkey: hi, account: { data: Buffer.alloc(1288) } },
        { pubkey: lo, account: { data: lpData } },
      ]);
      // lo is the LP: it is filtered, so hi wins even though lo sorts first
      vi.mocked(isLpPortfolio).mockImplementation((d: any) => d === lpData);
      const r4 = run();
      await act(async () => {
        await r4.call();
      });
      const { instructions } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions[0].keys[2].pubkey.equals(hi)).toBe(true);
    });

    it("scan picks the lowest pubkey of several non-LP matches (Uint8Array data too)", async () => {
      const [lo, hi] = [pkA, pkB].sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
      conn.getProgramAccounts.mockResolvedValue([
        { pubkey: hi, account: { data: Buffer.alloc(1288) } },
        { pubkey: lo, account: { data: new Uint8Array(1288) } },
      ]);
      const r5 = run();
      await act(async () => {
        await r5.call();
      });
      const { instructions } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions[0].keys[2].pubkey.equals(lo)).toBe(true);
    });

    it("scan result whose owner does not match, or whose parse throws, ends in 'no account'", async () => {
      vi.mocked(parsePortfolioV17).mockReturnValue(portfolio({ owner: pkB }) as any);
      const r6 = run();
      await act(async () => {
        await expect(r6.call()).rejects.toThrow(/No account found/);
      });
      vi.mocked(parsePortfolioV17).mockImplementation(() => {
        throw new Error("bad layout");
      });
      const r7 = run();
      await act(async () => {
        await expect(r7.call()).rejects.toThrow(/No account found/);
      });
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("empty scan, only-LP scan and a throwing scan all end in 'no account'", async () => {
      conn.getProgramAccounts.mockResolvedValue([]);
      const r8 = run();
      await act(async () => {
        await expect(r8.call()).rejects.toThrow(/Deposit first/);
      });
      conn.getProgramAccounts.mockResolvedValue([{ pubkey: pkA, account: { data: Buffer.alloc(1288) } }]);
      vi.mocked(isLpPortfolio).mockReturnValue(true);
      const r9 = run();
      await act(async () => {
        await expect(r9.call()).rejects.toThrow(/Deposit first/);
      });
      conn.getProgramAccounts.mockRejectedValue(new Error("gpa failed"));
      const r10 = run();
      await act(async () => {
        await expect(r10.call()).rejects.toThrow(/Deposit first/);
      });
      expect(sendTx).not.toHaveBeenCalled();
    });
  });

  describe("pre-sign checks", () => {
    it("an open leg is refused with the close-first copy", async () => {
      vi.mocked(parsePortfolioV17).mockReturnValue(portfolio({ legs: [{ active: true, basisPosQ: 5n }] }) as any);
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow(WITHDRAW_OPEN_POSITIONS_MESSAGE);
      });
      expect(h.result.current.error).toBe(`H:${WITHDRAW_OPEN_POSITIONS_MESSAGE}`);
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("a portfolio parse failure in the pre-check is best effort: the withdraw still goes out", async () => {
      // 1st parse (scan owner check) ok; 2nd (pre-check) throws; identity read is lib/v18-wire's own parse
      vi.mocked(parsePortfolioV17)
        .mockReturnValueOnce(portfolio() as any)
        .mockImplementationOnce(() => {
          throw new Error("parse");
        })
        .mockReturnValue(portfolio() as any);
      const r11 = run();
      await act(async () => {
        await r11.call();
      });
      expect(sendTx).toHaveBeenCalledTimes(1);
    });

    it("amount above capital with no profit to convert is refused by the plan (WithdrawRefusal)", async () => {
      vi.mocked(planConvertWithdraw).mockRejectedValue(new WithdrawRefusal("not enough profit"));
      const { h, call } = run({ amount: 99_000_000n });
      await act(async () => {
        await expect(call()).rejects.toBeInstanceOf(WithdrawRefusal);
      });
      expect(h.result.current.error).toBe("not enough profit");
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("a converted-profit plan prefixes the withdraw, clamps the amount, raises CU and sets the notice", async () => {
      const prefixIx = { programId, keys: [], data: Buffer.from([28]) } as any;
      vi.mocked(planConvertWithdraw).mockResolvedValue({ prefix: [prefixIx], amount: 12_000_000n, notice: "profit left in place" } as any);
      const { h, call } = run({ amount: 15_000_000n });
      await act(async () => {
        await call();
      });
      const { instructions, computeUnits } = vi.mocked(sendTx).mock.calls[0][0] as any;
      expect(instructions).toHaveLength(2);
      expect(instructions[0]).toBe(prefixIx);
      expect(computeUnits).toBe(600_000);
      // v18 wire: [tag u8][portfolioId u64][expectedSequence u64][amount u128]
      expect(Buffer.from(instructions[1].data).readBigUInt64LE(17)).toBe(12_000_000n);
      expect(h.result.current.notice).toBe("profit left in place");
    });

    it("a plan with an empty prefix keeps the 300k budget and no notice", async () => {
      vi.mocked(planConvertWithdraw).mockResolvedValue({ prefix: [], amount: 15_000_000n, notice: null } as any);
      const { h, call } = run({ amount: 15_000_000n });
      await act(async () => {
        await call();
      });
      expect((vi.mocked(sendTx).mock.calls[0][0] as any).computeUnits).toBe(300_000);
      expect(h.result.current.notice).toBeNull();
    });
  });

  describe("errors after signing", () => {
    it("wallet rejection surfaces the humanized text and clears loading", async () => {
      vi.mocked(sendTx).mockRejectedValue(new Error("User rejected the request"));
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow("User rejected the request");
      });
      expect(h.result.current.error).toBe("H:User rejected the request");
      expect(h.result.current.loading).toBe(false);
    });

    it("simulation failure text is humanized", async () => {
      vi.mocked(sendTx).mockRejectedValue(new Error("Transaction simulation failed: custom program error: 0x1"));
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow(/simulation failed/);
      });
      expect(h.result.current.error).toMatch(/^H:Transaction simulation failed/);
    });

    it("userFacingMessage wins over every other mapping", async () => {
      vi.mocked(userFacingMessage).mockReturnValue("calm line");
      vi.mocked(sendTx).mockRejectedValue(new Error("custom program error: 0x13"));
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow();
      });
      expect(h.result.current.error).toBe("calm line");
    });

    it("EngineLockActive (21) after a convert prefix reads as the settling-profit line", async () => {
      vi.mocked(planConvertWithdraw).mockResolvedValue({ prefix: [{ programId, keys: [], data: Buffer.from([28]) } as any], amount: 1n, notice: null } as any);
      vi.mocked(sendTx).mockRejectedValue(new Error("custom program error: 0x15"));
      const { h, call } = run({ amount: 15_000_000n });
      await act(async () => {
        await expect(call()).rejects.toThrow();
      });
      expect(h.result.current.error).toMatch(/withdrawable once the other side of your trade settles/);
    });

    it("EngineLockActive (21) WITHOUT a convert prefix is not remapped", async () => {
      vi.mocked(sendTx).mockRejectedValue(new Error("custom program error: 0x15"));
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow();
      });
      expect(h.result.current.error).toBe("H:custom program error: 0x15");
    });

    it("a non-Error rejection is still reported", async () => {
      vi.mocked(sendTx).mockRejectedValue("plain string failure");
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toBe("plain string failure");
      });
      expect(h.result.current.error).toContain("plain string failure");
    });
  });

  describe("after a successful send", () => {
    it("refreshes the slab now and again after 2s; tolerates a missing refresh", async () => {
      vi.useFakeTimers();
      const { call } = run();
      await act(async () => {
        await call();
      });
      expect(state.refresh).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(state.refresh).toHaveBeenCalledTimes(2);

      state.refresh = undefined;
      const r12 = run();
      await act(async () => {
        await r12.call();
        vi.advanceTimersByTime(2000);
      });
      expect(sendTx).toHaveBeenCalledTimes(2);
    });

    it("clears a previous error and notice when a new withdraw starts", async () => {
      vi.mocked(sendTx).mockRejectedValueOnce(new Error("boom"));
      const { h, call } = run();
      await act(async () => {
        await expect(call()).rejects.toThrow("boom");
      });
      expect(h.result.current.error).toBe("H:boom");
      await act(async () => {
        await call();
      });
      expect(h.result.current.error).toBeNull();
    });
  });
});
