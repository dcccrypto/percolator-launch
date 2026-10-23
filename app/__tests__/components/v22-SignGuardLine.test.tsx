/** v2.2 QA RT5-2: the yellow "sign debug:" line is hidden by default; `?signdebug=1` turns it on. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Keypair, Transaction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import { __resetSignGuardForTest, guardSign, noteBlockhash } from "@/lib/v22/sign-guard";
import { SignGuardLine } from "@/components/v22/SignGuardLine";

const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const conn = { getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH), isBlockhashValid: vi.fn(async () => ({ context: { slot: 1 }, value: true })) };

async function declined() {
  const t = new Transaction(); t.recentBlockhash = BH; t.feePayer = Keypair.generate().publicKey;
  noteBlockhash(BH, "sendTx attempt 1", conn);
  await act(async () => { await guardSign({ txs: [t], via: "adapter signTransaction", connection: conn, chain: "solana:devnet", sign: async () => { throw new Error("User rejected the request."); } }).catch(() => {}); });
}

describe("SignGuardLine opt-in", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); window.localStorage.clear(); window.history.replaceState({}, "", "/"); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { cleanup(); __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("hidden by default even after a declined request (data stays in window.__v22SignLog)", async () => {
    const { queryByTestId } = render(<SignGuardLine />);
    await declined();
    expect(queryByTestId("v22-sign-guard-line")).toBeNull();
    expect((window as unknown as { __v22SignLog: unknown[] }).__v22SignLog).toHaveLength(1);
  });

  it("visible with ?signdebug=1", async () => {
    window.history.replaceState({}, "", "/?signdebug=1");
    const { queryByTestId } = render(<SignGuardLine />);
    await declined();
    expect(queryByTestId("v22-sign-guard-line")?.textContent).toContain("sign debug:");
  });
});
