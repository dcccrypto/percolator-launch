import { describe, expect, it, vi } from "vitest";
import { Keypair, TransactionInstruction } from "@solana/web3.js";

vi.mock("@/lib/tx", () => ({
  simulateForGate: vi.fn(async () => ({ err: null, logs: [], simulated: undefined, consumed: 1000 })),
  SimulationRefusal: class SimulationRefusal extends Error {},
}));

import { sendMultiAssetOrder, TakerPortfolioReadError } from "@/lib/v22/trade-refresh-wire";
import * as refresh from "@/lib/v22/trade-refresh";

const k = () => Keypair.generate().publicKey;
const input = () => {
  const programId = k();
  return {
    programId,
    market: k(),
    marketData: new Uint8Array(0),
    cranker: k(),
    takerPortfolio: k(),
    lpPortfolio: k(),
    body: [new TransactionInstruction({ programId, keys: [], data: Buffer.from([1]) })],
  };
};
const send = async () => "sig";

describe("sendMultiAssetOrder: reading the taker portfolio", () => {
  it("an RPC error on an existing portfolio is retried once, not planned as a first trade", async () => {
    const spy = vi.spyOn(refresh, "executeV22MultiAssetOrder");
    const data = new Uint8Array([7, 7, 7]);
    const getAccountInfo = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce({ data });
    await sendMultiAssetOrder({ getAccountInfo } as never, input(), send);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
    expect(Array.from(spy.mock.calls[0][0].takerData ?? [])).toEqual([7, 7, 7]);
    spy.mockRestore();
  });

  it("two RPC errors throw a retryable error and plan nothing", async () => {
    const getAccountInfo = vi.fn().mockRejectedValue(new Error("429"));
    await expect(sendMultiAssetOrder({ getAccountInfo } as never, input(), send)).rejects.toBeInstanceOf(TakerPortfolioReadError);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it("a genuinely missing account (null) still plans the create: takerData null, no retry", async () => {
    const spy = vi.spyOn(refresh, "executeV22MultiAssetOrder");
    const getAccountInfo = vi.fn().mockResolvedValue(null);
    await sendMultiAssetOrder({ getAccountInfo } as never, input(), send);
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].takerData).toBeNull();
    spy.mockRestore();
  });
});
