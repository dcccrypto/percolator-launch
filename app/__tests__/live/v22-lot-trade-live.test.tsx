// @vitest-environment happy-dom
/**
 * LIVE devnet (skipped unless LIVE_RPC): v2.2 QA L-1. Opens and closes a real position on lot markets through the
 * APP's own builders (SlabProvider + useFirstTrade.fundAndTrade, then useTrade.trade for the close) with a Keypair
 * wallet. Run with the preview's flags (NEXT_PUBLIC_DEVNET_V22=1, program-id overrides, NEXT_PUBLIC_TEST_USDC_MINT).
 *
 *   LIVE_RPC=… LIVE_WALLET=kp.json LIVE_LOTS="CHILLHOUSE:ALdz…:10,JUP:GtUe…:3" LIVE_LOG=… npx vitest run __tests__/live/v22-lot-trade-live.test.tsx
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
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { firstTradeDepositAtoms } from "@/lib/first-trade";
import { parsePortfolio } from "@/lib/v22/layout";
import { lotExpOf, POS_SCALE_V22, lotPriceToTokenE6 } from "@/lib/v22/lot";
import { lotTradingRefusal } from "@/lib/v22/lot-coverage";

const LOTS = (process.env.LIVE_LOTS ?? "").split(",").filter(Boolean).map((s) => { const [name, slab, lots] = s.split(":"); return { name, slab, lots: BigInt(lots) }; });

describe.skipIf(!RPC)("LIVE L-1: open + close on lot markets through the app's builders", () => {
  for (const m of LOTS) {
    it(`${m.name}: open ${m.lots} lots (negative = short), then close`, async () => {
      const info0 = console.info.bind(console);
      console.info = (...a: unknown[]) => { LOG("  info: " + a.map(String).join(" ")); info0(...a); };
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
      const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
      const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <WalletApiContext.Provider value={w}><SlabProvider slabAddress={m.slab}>{children}</SlabProvider></WalletApiContext.Provider>
      );
      const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(m.slab), tr: useTrade(m.slab) }), { wrapper });
      await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
      const info = await conn.getAccountInfo(new PublicKey(m.slab));
      const raw = new Uint8Array(info!.data);
      const k = lotExpOf(raw);
      expect(k).toBeGreaterThan(0);
      expect(lotTradingRefusal(k)).toBeNull(); // the app no longer refuses this lot market
      const wc = parseWrapperConfigV17(raw, V17_HEADER_LEN);
      const markE6 = BigInt(wc.markEwmaE6);
      seedFromOnChain(m.slab, markE6);
      const size = m.lots * POS_SCALE_V22; // whole lots
      const notional = ((size < 0n ? -size : size) * markE6) / POS_SCALE_V22; // atoms (per-lot mark x lots)
      const deposit = firstTradeDepositAtoms(notional + 3_000_000n, (notional * 140n) / 10_000n + 1n);
      LOG(`[${m.name}] lot_exp=${k} markE6/lot=${markE6} perTokenE6=${lotPriceToTokenE6(markE6, k)} lots=${m.lots} tokens=${m.lots * 10n ** BigInt(k)} notional=${notional} deposit=${deposit}`);
      let pf: PublicKey | null = null;
      const closeOnly = process.env.LIVE_CLOSE_ONLY === "1";
      if (closeOnly) pf = await findV17Portfolio(conn, result.current.slab.programId as PublicKey, new PublicKey(m.slab), kp.publicKey);
      if (!closeOnly) await act(async () => {
        const r = await result.current.ft.fundAndTrade({ size, depositAtoms: deposit, limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "test", ...(process.env.LIVE_WAIT_MS ? { maxWaitMs: Number(process.env.LIVE_WAIT_MS) } : {}) });
        pf = r.portfolio;
        LOG(`[${m.name}] OPEN ok sig=${r.signature} portfolio=${r.portfolio.toBase58()} created=${r.created} prompts=${r.prompts}`);
      });
      await new Promise((r) => setTimeout(r, 4000));
      const read = async () => parsePortfolio(new Uint8Array((await conn.getAccountInfo(pf!, "confirmed"))!.data));
      const open = await read();
      const leg = open.legs.find((l) => l.active);
      LOG(`[${m.name}] after open legs=${open.legs.filter((l) => l.active).length} basisPosQ=${leg?.basisPosQ} capital=${open.capital}`);
      if (!closeOnly) expect(leg?.basisPosQ).toBe(size);
      const closeSize = -(leg?.basisPosQ ?? 0n);
      const info2 = await conn.getAccountInfo(new PublicKey(m.slab));
      const mark2 = BigInt(parseWrapperConfigV17(new Uint8Array(info2!.data), V17_HEADER_LEN).markEwmaE6);
      seedFromOnChain(m.slab, mark2);
      await act(async () => {
        const sig = await result.current.tr.trade({ lpIdx: 0, userIdx: 0, size: closeSize, portfolioPk: pf!, limitPriceE6: computeLimitPriceE6({ markE6: mark2, size: closeSize }) });
        LOG(`[${m.name}] CLOSE ok sig=${sig}`);
      });
      await new Promise((r) => setTimeout(r, 4000));
      const closed = await read();
      LOG(`[${m.name}] after close legs=${closed.legs.filter((l) => l.active).length} capital=${closed.capital} pnl=${closed.pnl}`);
      expect(closed.legs.filter((l) => l.active)).toHaveLength(0);
    }, 300_000);
  }
});
