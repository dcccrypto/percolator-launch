/** QA 12:38: an unreadable quote ("unknown" / a thrown read) is asked again; the dust profit must not stay stuck until a reload. */
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fx from "../fixtures/v22-swordcat-dust-portfolio-510974481.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const OWNER = new PublicKey("6Rz2i9cRAQ2JRZ9pZAuPidYQAYhrJSWbbWaJAVvknAVq");
const PF = new PublicKey("FnY2i6UFCwHQYbS8rcA6QzjcgUxwZzYXjHhjDeLM1b68");
const mocks = vi.hoisted(() => {
  const getAccountInfo = vi.fn();
  return { quote: vi.fn(), getAccountInfo, conn: { connection: { getAccountInfo } }, wallet: { publicKey: null as unknown }, prog: { programId: null as unknown } };
});
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => mocks.conn,
  useWalletCompat: () => mocks.wallet,
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => mocks.prog }));
vi.mock("@/lib/convert-released-pnl", async (orig) => ({ ...(await orig<object>()), quoteConvertible: mocks.quote, connectionQuoteDeps: () => ({}) }));

import { QUOTE_RETRY_DELAYS_MS, useConvertibleProfit } from "@/hooks/useConvertibleProfit";

const READY = { status: "ready", postCapital: 196_157n, convertible: 196_157n, prefix: [] };
beforeEach(() => {
  mocks.wallet.publicKey = OWNER;
  mocks.prog.programId = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
  (QUOTE_RETRY_DELAYS_MS as number[]).splice(0, 4, 20, 20, 20, 20);
  __setDevnetV22ForTest(true);
  mocks.quote.mockReset();
  mocks.getAccountInfo.mockResolvedValue({ data: Buffer.from(fx.portfolio, "base64") });
});
afterEach(() => { (QUOTE_RETRY_DELAYS_MS as number[]).splice(0, 4, 2_000, 4_000, 8_000, 16_000); __setDevnetV22ForTest(null); });

const run = () => renderHook(() => useConvertibleProfit("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF", PF, 0n, 196_157n, false));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("useConvertibleProfit retries an unreadable quote", () => {
  it("unknown first, ready on the retry: the profit becomes claimable without a reload", async () => {
    mocks.quote.mockResolvedValueOnce({ status: "settling", released: 196_157n, code: null, reason: "unknown" }).mockResolvedValue(READY);
    const { result } = run();
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", postCapital: 196_157n }));
  });
  it("a thrown read is retried too", async () => {
    mocks.quote.mockRejectedValueOnce(new Error("429")).mockResolvedValue(READY);
    const { result } = run();
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready" }));
    expect(mocks.quote).toHaveBeenCalledTimes(2);
  });
  it("it gives up after four retries (no endless polling)", async () => {
    mocks.quote.mockResolvedValue({ status: "settling", released: 196_157n, code: null, reason: "unknown" });
    run();
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledTimes(5));
    await sleep(200);
    expect(mocks.quote).toHaveBeenCalledTimes(5);
  });
  it("a definite answer (backing) is NOT retried", async () => {
    mocks.quote.mockResolvedValue({ status: "settling", released: 196_157n, code: 21, reason: "backing" });
    run();
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledTimes(1));
    await sleep(200);
    expect(mocks.quote).toHaveBeenCalledTimes(1);
  });
});
