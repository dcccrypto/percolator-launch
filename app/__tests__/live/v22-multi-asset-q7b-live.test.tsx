// @vitest-environment happy-dom
/**
 * LIVE devnet (skipped unless LIVE_RPC): v2.2 QA Q-7b, through the app's hooks on the multi-asset market.
 *   LIVE_STEP=open   fundAndTrade: deposit LIVE_DEPOSIT_USDC and open ~$5 on asset 0 (leaves it open)
 *   LIVE_STEP=add    useTrade.trade: add ~$5 on asset 0 (the taker / LP at >= 3 legs -> the multi-asset shape)
 *   LIVE_STEP=close  useClosePosition: close the asset-0 leg (no sweep)
 * Legs on the other assets are opened with percolator-ops relaunch/v22/fresh/q7-multi-asset-trade.ts (the app trades asset 0).
 * Every landed tx is read back and its wrapper instruction tags are logged (5 = refresh crank, 10 = TradeCpi).
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
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { useTrade, findV17Portfolio } from "@/hooks/useTrade";
import { useClosePosition } from "@/hooks/useClosePosition";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { parsePortfolio } from "@/lib/v22/layout";

const SLAB = process.env.LIVE_SLAB ?? "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw";
const STEP = process.env.LIVE_STEP ?? "";

describe.skipIf(!RPC || !STEP)("LIVE Q-7b: the app's hooks on a multi-asset market", () => {
  it(STEP, async () => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(SLAB), tr: useTrade(SLAB), cp: useClosePosition(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const info = await conn.getAccountInfo(new PublicKey(SLAB));
    const markE6 = BigInt(parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN).markEwmaE6);
    seedFromOnChain(SLAB, markE6);
    const size = (5_000_000n * 1_000_000n) / markE6;
    const pf = await findV17Portfolio(conn, programId, new PublicKey(SLAB), kp.publicKey);
    const legs = async (p: PublicKey) => parsePortfolio(new Uint8Array((await conn.getAccountInfo(p, "confirmed"))!.data)).legs.filter((l) => l.active).map((l) => `${l.assetIndex}:${l.basisPosQ}`).join(" ");
    const describeTx = async (sig: string) => {
      const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      const ixs = tx!.transaction.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === programId.toBase58());
      return `err=${JSON.stringify(tx!.meta?.err)} cu=${tx!.meta?.computeUnitsConsumed} wrapperIx=${ixs.map((ix) => (ix.data[0] === 5 ? `5(${keys[ix.accountKeyIndexes[2]].slice(0, 6)})` : String(ix.data[0]))).join(",")}`;
    };
    LOG(`[${STEP}] portfolio=${pf?.toBase58() ?? "(none)"} legs before: ${pf ? await legs(pf) : "-"}`);
    let sig = "";
    await act(async () => {
      if (STEP === "open") {
        const r = await result.current.ft.fundAndTrade({ size, depositAtoms: BigInt(process.env.LIVE_DEPOSIT_USDC ?? "300") * 1_000_000n, limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "test" });
        sig = r.signature;
      } else if (STEP === "add") {
        sig = await result.current.tr.trade({ lpIdx: 0, userIdx: 0, size, portfolioPk: pf!, limitPriceE6: computeLimitPriceE6({ markE6, size }) });
      } else {
        const r = await result.current.cp.closePosition(100, { portfolioPk: pf!, skipSweep: true });
        sig = r.signature ?? "";
      }
    });
    await new Promise((r) => setTimeout(r, 5000));
    const p2 = pf ?? (await findV17Portfolio(conn, programId, new PublicKey(SLAB), kp.publicKey));
    LOG(`[${STEP}] sig=${sig} ${await describeTx(sig)} legs after: ${await legs(p2!)}`);
  }, 600_000);
});
