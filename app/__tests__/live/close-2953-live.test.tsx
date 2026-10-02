// @vitest-environment happy-dom
/** LIVE devnet (skipped unless LIVE_RPC): close 100% of the LIVE_WALLET's position via the real useClosePosition. */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, Keypair, type Transaction } from "@solana/web3.js";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useTrade, findV17Portfolio } from "@/hooks/useTrade";
import { useWithdraw } from "@/hooks/useWithdraw";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17, parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

const SLAB = process.env.LIVE_SLAB ?? "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
describe.skipIf(!RPC)("LIVE close", () => {
  it("closes 100%", async () => {
    const info = console.info.bind(console);
    console.info = (...a: unknown[]) => { LOG(a.map(String).join(" ")); info(...a); };
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), tr: useTrade(SLAB), wd: useWithdraw(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const pf = await findV17Portfolio(conn, programId, new PublicKey(SLAB), kp.publicKey);
    expect(pf).toBeTruthy();
    const read = async () => parsePortfolioV17(new Uint8Array((await conn.getAccountInfo(pf!, "confirmed"))!.data));
    const before = await read();
    const leg = before.legs.find((l) => l.active && l.assetIndex === 0);
    expect(leg).toBeTruthy();
    const mkt = await conn.getAccountInfo(new PublicKey(SLAB));
    const markE6 = BigInt(parseWrapperConfigV17(new Uint8Array(mkt!.data), V17_HEADER_LEN).markEwmaE6);
    seedFromOnChain(SLAB, markE6);
    const size = -leg!.basisPosQ; // flat (risk-reducing: passes the stale-cohort gate)
    await act(async () => {
      const sig = await result.current.tr.trade({ lpIdx: 0, userIdx: 0, size, limitPriceE6: computeLimitPriceE6({ markE6, size }) });
      LOG(`CLOSE ok sig=${sig} size=${size}`);
    });
    await new Promise((r) => setTimeout(r, 4000));
    const mid = await read();
    LOG(`after close legs=${mid.legs.filter((l) => l.active).length} capital=${mid.capital} pnl=${mid.pnl}`);
    const amount = mid.capital; // everything left
    await act(async () => {
      const sig = await result.current.wd.withdraw({ userIdx: 0, amount, portfolioPk: pf! });
      LOG(`WITHDRAW ok sig=${sig} amount=${amount}`);
    });
    const after = await read();
    LOG(`after withdraw capital=${after.capital}`);
  }, 300_000);
});
