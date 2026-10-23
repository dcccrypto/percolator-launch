// @vitest-environment happy-dom
/**
 * LIVE devnet (skipped unless LIVE_RPC): "Close trading account" (#3426) on the FRESH v2.2 programs only.
 * A FRESH wallet, through the app's own hooks and builders:
 *   A  InitPortfolio + Deposit -> ClosePortfolio while it holds collateral is REFUSED (hook before signing; and the
 *      same instruction forced through simulation and through a real send with skipPreflight) -> Withdraw all ->
 *      ClosePortfolio via useCloseTradingAccount -> the account is gone and the wallet got the rent back.
 *   B  a USED account: fund-and-trade, refuse with the position open (hook + forced sim + forced send), close the
 *      position, withdraw what is left, close the account.
 * The close instruction is built by lib/close-trading-account.ts (the function the app uses); the forced sends reuse it
 * on purpose, bypassing only the app's own emptiness check, to record what the PROGRAM answers.
 *   LIVE_RPC=https://api.devnet.solana.com LIVE_WALLET=kp.json LIVE_LOG=run.log LIVE_SLAB=BYFu… \
 *   NEXT_PUBLIC_DEVNET_V22=1 NEXT_PUBLIC_DEVNET_V21=1 npx vitest run __tests__/live/v22-close-account-live.test.tsx
 */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
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
import { useInitUser } from "@/hooks/useInitUser";
import { useDeposit } from "@/hooks/useDeposit";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useCloseTradingAccount } from "@/hooks/useCloseTradingAccount";
import { findV17Portfolio } from "@/hooks/useTrade";
import { buildCloseTradingAccountIx } from "@/lib/close-trading-account";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { firstTradeDepositAtoms } from "@/lib/first-trade";
import { parsePortfolio } from "@/lib/v22/layout";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";

const SLAB = process.env.LIVE_SLAB ?? "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5";
const V22_FRESH_WRAPPER = "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM";

describe.skipIf(!RPC)("LIVE #3426: close trading account", () => {
  it("refused while funded / positioned, accepted once empty, rent returned", async () => {
    // Devnet only: checked before the wallet key is even read.
    expect(await conn.getGenesisHash()).toBe(DEVNET_GENESIS_HASH);
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({
      slab: useSlabState(), init: useInitUser(SLAB), dep: useDeposit(SLAB), wd: useWithdraw(SLAB),
      ft: useFirstTrade(SLAB), cp: useClosePosition(SLAB), ca: useCloseTradingAccount(SLAB),
    }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const market = new PublicKey(SLAB);
    // The fresh v2.2 wrapper only (the cluster was checked before anything was read).
    expect(programId.toBase58()).toBe(V22_FRESH_WRAPPER);
    LOG(`wallet=${kp.publicKey.toBase58()} market=${SLAB} program=${programId.toBase58()} slot=${await conn.getSlot("confirmed")}`);

    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const readPf = async (pk: PublicKey) => parsePortfolio(new Uint8Array((await conn.getAccountInfo(pk, "confirmed"))!.data));
    const mark = async () => {
      const info = await conn.getAccountInfo(market);
      const m = BigInt(parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN).markEwmaE6);
      seedFromOnChain(SLAB, m);
      return m;
    };
    // The program's own answer to a ClosePortfolio built from the live bytes with NO app-side emptiness check.
    const forced = async (label: string, pf: PublicKey) => {
      const info = await conn.getAccountInfo(pf, "confirmed");
      const ix = buildCloseTradingAccountIx({ programId, owner: kp.publicKey, market, portfolio: pf, data: new Uint8Array(info!.data) });
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
      const sim = await conn.simulateTransaction(tx);
      LOG(`[${label}] FORCED SIMULATION err=${JSON.stringify(sim.value.err)} logs=${(sim.value.logs ?? []).filter((l) => /failed|custom/i.test(l)).join(" || ")}`);
      expect(sim.value.err).not.toBeNull();
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      const meta = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      LOG(`[${label}] FORCED SEND (skipPreflight) sig=${sig} slot=${meta?.slot} err=${JSON.stringify(meta?.meta?.err)}`);
      expect(meta?.meta?.err).toBeTruthy();
      expect((await conn.getAccountInfo(pf, "confirmed"))).not.toBeNull(); // still there
    };
    const refuseViaHook = async (label: string, pf: PublicKey) => {
      let msg = "";
      await act(async () => {
        try { await result.current.ca.closeAccount(pf); msg = "SENT?!"; } catch (e) { msg = (e as Error).message; }
      });
      LOG(`[${label}] HOOK refused before signing: ${JSON.stringify(msg)}`);
      expect(msg).not.toBe("SENT?!");
      expect(msg).not.toMatch(/Custom|0x|InstructionError/);
    };
    const closeViaHook = async (label: string, pf: PublicKey) => {
      const walletBefore = await conn.getBalance(kp.publicKey, "confirmed");
      const acctBefore = (await conn.getAccountInfo(pf, "confirmed"))!.lamports;
      let sig = "";
      await act(async () => { sig = (await result.current.ca.closeAccount(pf)).signature; });
      await pause(3000);
      const gone = await conn.getAccountInfo(pf, "confirmed");
      const walletAfter = await conn.getBalance(kp.publicKey, "confirmed");
      const meta = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const fee = meta?.meta?.fee ?? 0;
      LOG(`[${label}] CLOSE sig=${sig} slot=${meta?.slot} err=${JSON.stringify(meta?.meta?.err)} accountLamports=${acctBefore} walletBefore=${walletBefore} walletAfter=${walletAfter} fee=${fee} delta=${walletAfter - walletBefore} (rent-fee=${acctBefore - fee}) accountExists=${gone !== null}`);
      expect(gone).toBeNull();
      expect(walletAfter - walletBefore).toBe(acctBefore - fee);
    };

    // ---------------------------------------------------------------- A: deposit only
    await act(async () => {
      const r = await result.current.init.initUser(0n);
      LOG(`[A] InitPortfolio sig=${r?.sig}`);
    });
    await pause(3000);
    const pfA = (await findV17Portfolio(conn, programId, market, kp.publicKey))!;
    expect(pfA).toBeTruthy();
    LOG(`[A] portfolio=${pfA.toBase58()} lamports=${(await conn.getAccountInfo(pfA))!.lamports}`);
    await act(async () => {
      const sig = await result.current.dep.deposit({ userIdx: 0, amount: 20_000_000n, accountExists: true, portfolioPk: pfA });
      LOG(`[A] Deposit 20 USDC sig=${sig}`);
    });
    await pause(3000);
    LOG(`[A] capital=${(await readPf(pfA)).capital}`);
    await refuseViaHook("A has-collateral", pfA);
    await forced("A has-collateral", pfA);
    const capA = (await readPf(pfA)).capital;
    await act(async () => {
      const sig = await result.current.wd.withdraw({ userIdx: 0, amount: capA, portfolioPk: pfA, strictPortfolio: true });
      LOG(`[A] Withdraw all (${capA}) sig=${sig}`);
    });
    await pause(3000);
    const afterA = await readPf(pfA);
    LOG(`[A] after withdraw capital=${afterA.capital} pnl=${afterA.pnl} legs=${afterA.legs.filter((l) => l.active).length}`);
    await closeViaHook("A empty", pfA);

    // ---------------------------------------------------------------- B: a used account
    const markE6 = await mark();
    const size = (5_000_000n * 1_000_000n) / markE6; // ~$5
    let pfB: PublicKey | null = null;
    await act(async () => {
      const r = await result.current.ft.fundAndTrade({ size, depositAtoms: firstTradeDepositAtoms(8_000_000n, 100_000n), limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "test" });
      pfB = r.portfolio;
      LOG(`[B] fundAndTrade sig=${r.signature} portfolio=${r.portfolio.toBase58()} created=${r.created}`);
    });
    await pause(5000);
    const open = await readPf(pfB!);
    LOG(`[B] open legs=${open.legs.filter((l) => l.active).length} capital=${open.capital}`);
    expect(open.legs.filter((l) => l.active)).toHaveLength(1);
    await refuseViaHook("B open-position", pfB!);
    await forced("B open-position", pfB!);
    await mark();
    await act(async () => {
      const r = await result.current.cp.closePosition(100, { portfolioPk: pfB! });
      LOG(`[B] closePosition ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    });
    await pause(5000);
    const flat = await readPf(pfB!);
    LOG(`[B] after close position legs=${flat.legs.filter((l) => l.active).length} capital=${flat.capital} pnl=${flat.pnl}`);
    if (flat.capital > 0n) {
      await refuseViaHook("B flat-with-collateral", pfB!);
      await act(async () => {
        const sig = await result.current.wd.withdraw({ userIdx: 0, amount: flat.capital, portfolioPk: pfB!, strictPortfolio: true });
        LOG(`[B] Withdraw all (${flat.capital}) sig=${sig}`);
      });
      await pause(3000);
    }
    const emptyB = await readPf(pfB!);
    LOG(`[B] before close capital=${emptyB.capital} pnl=${emptyB.pnl}`);
    await closeViaHook("B used then emptied", pfB!);
  }, 600_000);
});
