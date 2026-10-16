// @vitest-environment happy-dom
/** LIVE devnet (skipped unless LIVE_RPC): v2.2 QA Q-7c. A flat account with released profit withdraws capital + pnl FACE in one tx through useWithdraw. */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useWithdraw } from "@/hooks/useWithdraw";
import { findV17Portfolio } from "@/hooks/useTrade";
import { parsePortfolio } from "@/lib/v22/layout";

const SLAB = process.env.LIVE_SLAB ?? "";

describe.skipIf(!RPC)("LIVE Q-7c: convert + withdraw all", () => {
  it("withdraws capital + the pnl face in one tx", async () => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), wd: useWithdraw(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const pf = (await findV17Portfolio(conn, result.current.slab.programId as PublicKey, new PublicKey(SLAB), kp.publicKey))!;
    const read = async () => parsePortfolio(new Uint8Array((await conn.getAccountInfo(pf, "confirmed"))!.data));
    const before = await read();
    LOG(`portfolio=${pf.toBase58()} capital=${before.capital} pnl=${before.pnl} reserved=${before.reservedPnl} legs=${before.legs.filter((l) => l.active).length}`);
    expect(before.pnl).toBeGreaterThan(0n);
    const amount = before.capital + before.pnl; // the FACE: what "withdraw all" asks for
    let sig = "";
    await act(async () => {
      sig = await result.current.wd.withdraw({ userIdx: 0, amount, portfolioPk: pf, strictPortfolio: true }).catch((e) => { LOG(`REFUSED ${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`); throw e; });
    });
    await new Promise((r) => setTimeout(r, 4000));
    const after = await read();
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const tags = tx!.transaction.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] !== "ComputeBudget111111111111111111111111111111").map((ix) => ix.data[0]);
    LOG(`WITHDRAW requested=${amount} sig=${sig} err=${JSON.stringify(tx!.meta?.err)} wrapperIxTags=${tags.join(",")} after capital=${after.capital} pnl=${after.pnl} notice=${JSON.stringify(result.current.wd.notice)}`);
    expect(after.capital).toBe(0n);
  }, 600_000);
});
