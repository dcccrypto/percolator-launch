// @vitest-environment happy-dom
/**
 * LIVE devnet (skipped unless LIVE_RPC): v2.2 QA U-1 / R-1. Waits until an OPEN on the market is refused 121
 * (EngineLossStale: another positioned portfolio is behind), then lets the app's own first-trade builder send. The
 * wallet only signs an attempt whose pre-sign simulations included a 121, so the landed transaction is the proof that
 * the app added the stale peers' refresh cranks in the same transaction. Closes the position afterwards.
 *   LIVE_RPC=… LIVE_WALLET=kp.json LIVE_SLAB=… LIVE_LOTS=5 LIVE_LOG=… npx vitest run __tests__/live/v22-121-peer-refresh-live.test.tsx
 */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);
let saw121 = false;
if (RPC) {
  const real = conn.simulateTransaction.bind(conn) as (...a: unknown[]) => Promise<{ value: { err: unknown } }>;
  (conn as unknown as { simulateTransaction: unknown }).simulateTransaction = async (...a: unknown[]) => {
    const r = await real(...a);
    if (JSON.stringify(r.value.err ?? "").includes('"Custom":121')) saw121 = true;
    return r;
  };
}
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { useClosePosition } from "@/hooks/useClosePosition";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { firstTradeDepositAtoms } from "@/lib/first-trade";
import { POS_SCALE_V22 } from "@/lib/v22/lot";

const SLAB = process.env.LIVE_SLAB ?? "";
const LOTS = BigInt(process.env.LIVE_LOTS ?? "5");
class NotYet extends Error {}

describe.skipIf(!RPC)("LIVE U-1: an open refused 121 lands with the stale peers refreshed in the same tx", () => {
  it("waits for a 121, then sends", async () => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    let allowAny = false;
    const sign = async (tx: Transaction) => { if (!saw121 && !allowAny) throw new NotYet("no 121 in this attempt"); tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(SLAB), cp: useClosePosition(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    let opened: { sig: string; pf: PublicKey } | null = null;
    const tries = Number(process.env.LIVE_TRIES ?? "40");
    for (let n = 0; n < tries && !opened; n++) {
      saw121 = false;
      const info = await conn.getAccountInfo(new PublicKey(SLAB));
      const markE6 = BigInt(parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN).markEwmaE6);
      seedFromOnChain(SLAB, markE6);
      const size = LOTS * POS_SCALE_V22;
      const notional = (size * markE6) / POS_SCALE_V22;
      try {
        await act(async () => {
          const r = await result.current.ft.fundAndTrade({ size, depositAtoms: firstTradeDepositAtoms(notional + 3_000_000n, (notional * 140n) / 10_000n + 1n), limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "test" });
          opened = { sig: r.signature, pf: r.portfolio };
        });
      } catch (e) {
        const msg = (e as Error).message.slice(0, 120).replace(/\s+/g, " ");
        LOG(`[try ${n}] ${e instanceof NotYet ? "simulated clean without a 121 (not signed)" : `refused: ${msg}`} saw121=${saw121}`);
        await new Promise((r) => setTimeout(r, Number(process.env.LIVE_GAP_MS ?? "20000")));
      }
    }
    expect(opened).toBeTruthy();
    const tx = await conn.getTransaction(opened!.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const ixs = tx!.transaction.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], tag: ix.data[0], third: keys[ix.accountKeyIndexes[2]] }));
    const cranks = ixs.filter((x) => x.program !== "ComputeBudget111111111111111111111111111111" && x.tag === 5);
    LOG(`OPEN after a 121 sig=${opened!.sig} err=${JSON.stringify(tx!.meta?.err)} cu=${tx!.meta?.computeUnitsConsumed} wrapperIxTags=${ixs.filter((x) => x.program !== "ComputeBudget111111111111111111111111111111").map((x) => x.tag).join(",")} peerCranks=${cranks.map((c) => c.third).join(",")}`);
    expect(cranks.length).toBeGreaterThan(0);
    allowAny = true;
    await new Promise((r) => setTimeout(r, 4000));
    await act(async () => {
      const r = await result.current.cp.closePosition(100, { portfolioPk: opened!.pf });
      LOG(`CLOSE sig=${r.signature}`);
    });
  }, 1_500_000);
});
