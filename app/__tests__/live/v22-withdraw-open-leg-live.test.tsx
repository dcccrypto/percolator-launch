// @vitest-environment happy-dom
/** LIVE devnet (skipped unless LIVE_RPC): v2.2 QA P-2. With a position open, useWithdraw's error text (named and unnamed portfolio). Closes after. */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useClosePosition } from "@/hooks/useClosePosition";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { firstTradeDepositAtoms } from "@/lib/first-trade";
import { WITHDRAW_OPEN_POSITIONS_MESSAGE } from "@/lib/withdraw-copy";

const SLAB = process.env.LIVE_SLAB ?? "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5";

describe.skipIf(!RPC)("LIVE P-2: withdraw with an open position", () => {
  it("says close first, on both paths; nothing is sent", async () => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(SLAB), wd: useWithdraw(SLAB), cp: useClosePosition(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const info = await conn.getAccountInfo(new PublicKey(SLAB));
    const markE6 = BigInt(parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN).markEwmaE6);
    seedFromOnChain(SLAB, markE6);
    const size = (5_000_000n * 1_000_000n) / markE6;
    let pf: PublicKey | null = null;
    await act(async () => {
      const r = await result.current.ft.fundAndTrade({ size, depositAtoms: firstTradeDepositAtoms(8_000_000n, 100_000n), limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "test" });
      pf = r.portfolio;
      LOG(`OPEN sig=${r.signature} portfolio=${r.portfolio.toBase58()}`);
    });
    await new Promise((r) => setTimeout(r, 5000));
    for (const mode of ["named", "unnamed"] as const) {
      await act(async () => {
        await result.current.wd.withdraw({ userIdx: 0, amount: 1_000_000n, ...(mode === "named" ? { portfolioPk: pf!, strictPortfolio: true } : {}) }).then(
          (sig) => LOG(`[${mode}] WITHDRAW UNEXPECTEDLY SENT ${sig}`),
          (e) => LOG(`[${mode}] refused: ${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`),
        );
      });
      LOG(`[${mode}] hook error shown = ${JSON.stringify(result.current.wd.error)}`);
      expect(result.current.wd.error).toBe(WITHDRAW_OPEN_POSITIONS_MESSAGE);
    }
    await act(async () => {
      const r = await result.current.cp.closePosition(100, { portfolioPk: pf! });
      LOG(`CLOSE sig=${r.signature}`);
    });
  }, 600_000);
});
