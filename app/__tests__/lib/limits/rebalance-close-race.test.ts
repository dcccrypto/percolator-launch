// @vitest-environment node
/**
 * F-3 race (seen in the #519 LiteSVM run, u2/u4 -> Custom(18)): another holder's unilateral
 * close ADLs the matching opposite OI and flattens THIS position before our tag-44 tx lands.
 * A wrapper Custom(18) EngineInvalidLeg + a fresh read showing no leg => "closed", not an error.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";

const sendTxMock = vi.fn();
vi.mock("@/lib/tx", () => ({ sendTx: (a: unknown) => sendTxMock(a) }));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 5n, matcherSequence: 0n, positionEpoch: 2n })),
}));
import { closeViaRebalanceReduce } from "@/lib/limits/rebalance-close";
import { blankPortfolio } from "../../helpers/v22-fixtures";


function portfolio(q: bigint): Buffer {
  const d = blankPortfolio();
  if (q !== 0n) {
    const l = C.PF_LEGS;
    d[l] = 1;
    d.writeBigUInt64LE(1n, l + C.LEG_MARKET_ID);
    d[l + C.LEG_SIDE] = q > 0n ? 0 : 1;
    d.writeBigUInt64LE(q < 0n ? -q : q, l + C.LEG_BASIS_POS_Q);
  }
  return d;
}
const base = (after: bigint) => ({
  connection: { getAccountInfo: vi.fn(async () => ({ data: portfolio(after) })) } as never,
  wallet: {} as never,
  programId: Keypair.generate().publicKey,
  market: Keypair.generate().publicKey,
  owner: Keypair.generate().publicKey,
  portfolio: Keypair.generate().publicKey,
  beforeQ: 21_400_000n,
  reduceQ: 21_400_000n,
  marketId: 1n,
  pythCrankAccount: null,
});

describe("closeViaRebalanceReduce — already flattened by another holder's exit", () => {
  it("Custom(18) + no leg on a fresh read => full close, no error", async () => {
    sendTxMock.mockRejectedValueOnce(new Error("Program X failed: custom program error: 0x12"));
    await expect(closeViaRebalanceReduce(base(0n))).resolves.toEqual({ signature: null, fill: { kind: "full", filledQ: -21_400_000n }, route: "tag44" });
  });
  it("control: Custom(18) but the leg is still there => the error surfaces", async () => {
    sendTxMock.mockRejectedValueOnce(new Error("Program X failed: custom program error: 0x12"));
    await expect(closeViaRebalanceReduce(base(21_400_000n))).rejects.toThrow(/0x12/);
  });
  it("control: another error code is never swallowed", async () => {
    sendTxMock.mockRejectedValueOnce(new Error("Program X failed: custom program error: 0x15"));
    await expect(closeViaRebalanceReduce(base(0n))).rejects.toThrow(/0x15/);
  });
});
