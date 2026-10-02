// @vitest-environment happy-dom
/**
 * LIVE devnet (skipped unless LIVE_RPC), GH#2959: the first trade from a FRESH wallet (no
 * portfolio on the market) through the REAL SlabProvider + useFirstTrade, signed by a wallet that
 * behaves like Solflare: it simulates EACH transaction on its own before signing and refuses
 * ("Simulation failed", Approve disabled) when that simulation fails. Then close 100% and
 * withdraw everything (real useTrade / useWithdraw).
 *
 *   LIVE_RPC=... LIVE_WALLET=/path/kp.json LIVE_SLAB=<market> LIVE_MARGIN_USD=2.5 LIVE_LEV=2 \
 *     LIVE_SEND=1 npx vitest run __tests__/live/first-trade-single-tx-live.test.tsx
 * LIVE_SEND unset: the wallet refuses after its own simulation (nothing is ever sent).
 * LIVE_WALLET_MODE=plain: a wallet that signs without its own preview (Phantom-like batch signing).
 * LIVE_FLOOR=1: the deposit covers the market's min_nonzero_im_req like the OrderTicket (GH#2953).
 */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, Keypair, PublicKey, VersionedTransaction, type Transaction } from "@solana/web3.js";
import { parsePortfolioV17, parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

const RPC = process.env.LIVE_RPC ?? "";
const SEND = process.env.LIVE_SEND === "1";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", `${new Date().toISOString()} ${m}\n`);
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);

vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});

import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { useTrade, findV17Portfolio } from "@/hooks/useTrade";
import { useWithdraw } from "@/hooks/useWithdraw";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { firstTradeDepositAtoms } from "@/lib/first-trade";

const SLAB = process.env.LIVE_SLAB ?? "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";

class WalletSimulationFailed extends Error {}
class DryRunStop extends Error {}

/** Solflare-like: simulate THIS transaction alone (as the wallet's own preview does) before signing. */
function perTxSimulatingWallet(kp: Keypair): WalletApi {
  const sign = async (tx: Transaction) => {
    if (process.env.LIVE_WALLET_MODE === "plain") {
      if (!SEND) throw new DryRunStop("dry run");
      tx.partialSign(kp);
      return tx;
    }
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    LOG(`[wallet] own simulation of a ${tx.instructions.length}-ix tx: ${sim.value.err ? JSON.stringify(sim.value.err) : "ok"} cu=${sim.value.unitsConsumed}`);
    if (sim.value.err) throw new WalletSimulationFailed(`Simulation failed: ${JSON.stringify(sim.value.err)} (Approve disabled)`);
    if (!SEND) throw new DryRunStop("dry run: wallet simulation passed; would prompt now");
    tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey, connected: true, connecting: false, wallet: null,
    signTransaction: sign,
    signAndSendTransaction: undefined,
    signMessage: undefined,
    // A batch wallet previews every tx on its own too: any failing one blocks the whole approval.
    signAllTransactions: async (txs: Transaction[]) => { const out: Transaction[] = []; for (const t of txs) out.push(await sign(t)); return out; },
    disconnect: async () => {},
  };
}

describe.skipIf(!RPC)("LIVE GH#2959: first trade with a per-tx-simulating wallet", () => {
  it("first trade lands (one tx), then close + withdraw", async () => {
    const info = console.info.bind(console);
    console.info = (...a: unknown[]) => { LOG(a.map(String).join(" ")); info(...a); };
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const w = perTxSimulatingWallet(kp);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(SLAB), tr: useTrade(SLAB), wd: useWithdraw(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const market = new PublicKey(SLAB);
    expect(await findV17Portfolio(conn, programId, market, kp.publicKey)).toBeNull(); // a FRESH wallet

    const mkt = await conn.getAccountInfo(market, "confirmed");
    const wc = parseWrapperConfigV17(new Uint8Array(mkt!.data), V17_HEADER_LEN);
    const markE6 = BigInt(wc.markEwmaE6);
    seedFromOnChain(SLAB, markE6);
    const margin = BigInt(Math.round(Number(process.env.LIVE_MARGIN_USD ?? "2.5") * 1e6));
    const lev = BigInt(process.env.LIVE_LEV ?? "2");
    const notional = margin * lev;
    const size = (notional * 1_000_000n) / markE6 * (process.env.LIVE_SIDE === "short" ? -1n : 1n);
    const fee = (notional * BigInt(wc.tradeFeeBps) + 9_999n) / 10_000n;
    // OrderTicket (GH#2953): a new position's deposit covers min_nonzero_im_req (wrapper config +22, u128 lo).
    const md = new Uint8Array(mkt!.data);
    const imFloor = new DataView(md.buffer, md.byteOffset, md.byteLength).getBigUint64(592 + 32 + 22, true);
    const depositAtoms = firstTradeDepositAtoms(process.env.LIVE_FLOOR === "1" && margin < imFloor ? imFloor : margin, fee);
    LOG(`[${SLAB.slice(0, 8)}] first trade notional=${notional} margin=${margin} imFloor=${imFloor} deposit=${depositAtoms} size=${size} send=${SEND}`);
    let firstSig = "";
    let portfolio: PublicKey | null = null;
    try {
      await act(async () => {
        const r = await result.current.ft.fundAndTrade({ size, depositAtoms, limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: `${depositAtoms} atoms` });
        firstSig = r.signature; portfolio = r.portfolio;
        LOG(`FIRST TRADE ok sig=${r.signature} portfolio=${r.portfolio.toBase58()} prompts=${r.prompts} created=${r.created}`);
      });
    } catch (e) {
      LOG(`FIRST TRADE refused: ${(e as Error).name}: ${(e as Error).message.split("\n")[0]}`);
      if (e instanceof DryRunStop) return;
      throw e;
    }
    expect(firstSig).not.toBe("");
    const tx = await conn.getTransaction(firstSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    LOG(`first-trade tx: ixs=${tx?.transaction.message.compiledInstructions.length} sigs=${tx?.transaction.signatures.length} cu=${tx?.meta?.computeUnitsConsumed} err=${JSON.stringify(tx?.meta?.err)}`);
    const read = async () => parsePortfolioV17(new Uint8Array((await conn.getAccountInfo(portfolio!, "confirmed"))!.data));
    const opened = await read();
    const leg = opened.legs.find((l) => l.active && l.assetIndex === 0);
    LOG(`after first trade: leg basis=${leg?.basisPosQ} capital=${opened.capital}`);
    expect(leg).toBeTruthy();

    await new Promise((r) => setTimeout(r, 3000));
    const closeSize = -leg!.basisPosQ;
    const mk2 = BigInt(parseWrapperConfigV17(new Uint8Array((await conn.getAccountInfo(market, "confirmed"))!.data), V17_HEADER_LEN).markEwmaE6);
    seedFromOnChain(SLAB, mk2);
    await act(async () => {
      const sig = await result.current.tr.trade({ lpIdx: 0, userIdx: 0, size: closeSize, limitPriceE6: computeLimitPriceE6({ markE6: mk2, size: closeSize }) });
      LOG(`CLOSE ok sig=${sig} size=${closeSize}`);
    });
    await new Promise((r) => setTimeout(r, 4000));
    const flat = await read();
    LOG(`after close: active legs=${flat.legs.filter((l) => l.active).length} capital=${flat.capital}`);
    await act(async () => {
      const sig = await result.current.wd.withdraw({ userIdx: 0, amount: flat.capital, portfolioPk: portfolio! });
      LOG(`WITHDRAW ok sig=${sig} amount=${flat.capital}`);
    });
    const after = await read();
    LOG(`after withdraw: capital=${after.capital}`);
  }, 600_000);
});
