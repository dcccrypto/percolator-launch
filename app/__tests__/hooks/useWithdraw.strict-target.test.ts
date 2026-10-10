/**
 * #3301: the withdraw that sweeps a closed account's capital must act on THAT account or fail
 * (`strictPortfolio`). The lenient fast path falls back to a scan of the wallet's portfolios, which
 * could withdraw another account's capital. Real v18 portfolio bytes (DAC2a44p), no parse mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useWithdraw } from "../../hooks/useWithdraw";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(),
}));

vi.mock("@/lib/errorMessages", () => ({
  UserFacingError: class UserFacingError extends Error {},
  userFacingMessage: () => null,
  humanizeError: vi.fn((msg) => msg),
}));

vi.mock("@/lib/config", () => ({
}));

vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
}));

// The scan-store snapshot must miss so the only paths in play are the
// caller-supplied fast path and the GPA scan fallback.
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: vi.fn(() => undefined),
  makePortfolioScanKey: vi.fn(() => "test-key"),
  isLpPortfolio: vi.fn(() => false),
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
  };
});

import { Keypair } from "@solana/web3.js";
import { TARGET_COPY } from "@/lib/portfolio-target";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta } from "@percolatorct/sdk";


const BASE = Buffer.from(
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "DAC2a44p.portfolio.json"), "utf8")).dataBase64,
  "base64",
);
const WALLET = new PublicKey(BASE.subarray(116, 148));
const SLAB = new PublicKey(BASE.subarray(16, 48));
const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const TARGET = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const OTHER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const flat = () => {
  const d = Buffer.from(BASE);
  d[356] = 0; // leg inactive: a closed account holding its capital
  return d;
};

describe("useWithdraw strictPortfolio (#3301)", () => {
  let connection: { getAccountInfo: ReturnType<typeof vi.fn>; getProgramAccounts: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    connection = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: flat(), owner: PROGRAM }),
      // What a lenient fallback would find: another account of the same wallet.
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: OTHER, account: { data: flat() } }]),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection } as never);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: WALLET, signTransaction: vi.fn(), connected: true } as never);
    vi.mocked(useSlabState).mockReturnValue({
      config: {
        collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
        vaultPubkey: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
        oracleAuthority: PublicKey.default,
        indexFeedId: new PublicKey(new Uint8Array(32).fill(1)),
        authorityPriceE6: 1000000n,
        lastEffectivePriceE6: 1000000n,
        invert: false,
      },
      wrapperConfigV17: { oracleMode: 0 },
      params: { initialMarginBps: 1000n },
      programId: PROGRAM,
      refresh: vi.fn(),
    } as never);
    vi.mocked(sendTx).mockResolvedValue({ signature: "sig" } as never);
    vi.mocked(getAta).mockResolvedValue(new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1"));
  });

  const run = async (over: Record<string, unknown> = {}) => {
    const { result } = renderHook(() => useWithdraw(SLAB.toBase58()));
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.withdraw({ userIdx: 0, amount: 1n, portfolioPk: TARGET, strictPortfolio: true, ...over });
      } catch (e) {
        thrown = e;
      }
    });
    return thrown as Error | null;
  };

  it("withdraws from exactly the named account, with no scan", async () => {
    expect(await run()).toBeNull();
    expect(connection.getProgramAccounts).not.toHaveBeenCalled();
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    expect(instructions[instructions.length - 1].keys[2].pubkey.equals(TARGET)).toBe(true);
  });

  it("an account owned by another wallet is refused: no scan fallback, nothing sent", async () => {
    const d = flat();
    Keypair.generate().publicKey.toBuffer().copy(d, 116);
    connection.getAccountInfo.mockResolvedValue({ data: d, owner: PROGRAM });
    const e = await run();
    expect(e?.message).toBe(TARGET_COPY.unmatched);
    expect(connection.getProgramAccounts).not.toHaveBeenCalled();
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("an account on another market, or not owned by the program, or missing, is refused", async () => {
    const wrongMarket = flat();
    Keypair.generate().publicKey.toBuffer().copy(wrongMarket, 16);
    for (const info of [
      { data: wrongMarket, owner: PROGRAM },
      { data: flat(), owner: Keypair.generate().publicKey },
      null,
    ]) {
      connection.getAccountInfo.mockResolvedValue(info);
      expect((await run())?.message).toBe(TARGET_COPY.unmatched);
    }
    expect(connection.getProgramAccounts).not.toHaveBeenCalled();
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("CONTROL: without strictPortfolio the old lenient fallback to a scan is unchanged", async () => {
    connection.getAccountInfo.mockResolvedValueOnce(null);
    expect(await run({ strictPortfolio: false })).toBeNull();
    expect(connection.getProgramAccounts).toHaveBeenCalledTimes(1);
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    expect(instructions[instructions.length - 1].keys[2].pubkey.equals(OTHER)).toBe(true);
  });
});
