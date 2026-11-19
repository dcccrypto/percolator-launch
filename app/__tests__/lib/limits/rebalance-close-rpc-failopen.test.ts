// @vitest-environment node
/**
 * Fail-open bug: a transient RPC error on the market read used to make `view` null => sides []
 * => the plain tag-44 route was sent blind, even when the real market is ResetPending (the B10
 * trap, Custom 18/22). The read is now retried; if it stays unreadable nothing is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { COPY } from "@/lib/limits/copy";

const sendTxMock = vi.fn();
vi.mock("@/lib/tx", () => ({ sendTx: (a: unknown) => sendTxMock(a) }));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 5n, matcherSequence: 0n, positionEpoch: 2n })),
}));
vi.mock("@/lib/limits/fill-check", () => ({ measureFill: vi.fn(async () => ({ kind: "full", filledQ: -1n })) }));
import { closeViaRebalanceReduce } from "@/lib/limits/rebalance-close";
import { blankPortfolio } from "../../helpers/v22-fixtures";

const FX = join(__dirname, "..", "..", "fixtures");
const MARKET = new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(FX, "5bVTTMRc.ansem.market.json"), "utf8")).dataBase64, "base64"));
function market(modeLong: number): Buffer {
  const d = MARKET.slice();
  d[marketOffsets(d).engineOff(0) + C.A_MODE_LONG] = modeLong;
  return Buffer.from(d);
}
const rpcErr = () => new Error("429 Too Many Requests");
const flat = () => ({ data: blankPortfolio() });

function params(getAccountInfo: (pk: unknown) => Promise<unknown>) {
  return {
    connection: { getAccountInfo: vi.fn(getAccountInfo), simulateTransaction: vi.fn(async () => ({ value: { err: null, accounts: [] } })) } as never,
    wallet: {} as never,
    programId: Keypair.generate().publicKey,
    market: Keypair.generate().publicKey,
    owner: Keypair.generate().publicKey,
    portfolio: Keypair.generate().publicKey,
    beforeQ: 5n,
    reduceQ: 5n,
    marketId: 1n,
    pythCrankAccount: null,
  };
}

beforeEach(() => {
  sendTxMock.mockReset();
  sendTxMock.mockResolvedValue("SIG");
});

describe("closeViaRebalanceReduce — market read RPC error", () => {
  it("market read keeps failing => nothing is sent (never the blind tag-44)", async () => {
    const p = params(async () => {
      throw rpcErr();
    });
    await expect(closeViaRebalanceReduce(p)).rejects.toThrow(COPY.closeStateUnknown);
    expect(sendTxMock).not.toHaveBeenCalled();
  });

  it("one transient error then ResetPending bytes => the ADL-aware plan is used, not the plain route", async () => {
    let n = 0;
    const p = params(async () => {
      if (n++ === 0) throw rpcErr();
      return { data: market(2) };
    });
    const simulate = vi.fn(async () => ({ err: null, failingIx: null, portfolioAfter: null }));
    const r = await closeViaRebalanceReduce(p, { simulate, isFlat: () => true });
    expect(simulate).toHaveBeenCalled(); // resetPendingSides found => chooseAdlExit ran
    expect(r.route).toBe("tag44");
    expect(sendTxMock).toHaveBeenCalledTimes(1);
  });

  it("healthy market read after one error => plain close still goes out", async () => {
    let n = 0;
    const p = params(async () => {
      if (n++ === 0) throw rpcErr();
      return { data: market(0) };
    });
    await closeViaRebalanceReduce(p);
    expect(sendTxMock).toHaveBeenCalledTimes(1);
  });

  it("Custom(18) + the portfolio re-read fails once => retried, reports closed", async () => {
    let portfolioReads = 0;
    const p = params(async (pk) => {
      if (pk === p.portfolio) {
        if (portfolioReads++ === 0) throw rpcErr();
        return flat();
      }
      return { data: market(0) };
    });
    sendTxMock.mockRejectedValueOnce(new Error("Program X failed: custom program error: 0x12"));
    await expect(closeViaRebalanceReduce(p)).resolves.toMatchObject({ signature: null, fill: { kind: "full", filledQ: -5n } });
  });

  it("Custom(18) + the portfolio re-read keeps failing => the original error surfaces", async () => {
    const p = params(async (pk) => {
      if (pk === p.portfolio) throw rpcErr();
      return { data: market(0) };
    });
    sendTxMock.mockRejectedValueOnce(new Error("Program X failed: custom program error: 0x12"));
    await expect(closeViaRebalanceReduce(p)).rejects.toThrow(/0x12/);
  });
});
