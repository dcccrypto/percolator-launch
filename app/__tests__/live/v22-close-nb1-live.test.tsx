// @vitest-environment happy-dom
/**
 * LIVE devnet (skipped unless LIVE_RPC): v2.2 QA NB-1. A FRESH wallet opens on a market through the app's builders
 * (useFirstTrade), then closes with the REAL useClosePosition: round 1 with the row's named portfolio (the ticket's
 * Close tab, the positions dock, /portfolio rows), round 2 with no named portfolio (the legacy panel path).
 *   LIVE_RPC=… LIVE_WALLET=kp.json LIVE_SLAB=BYFu… LIVE_LOG=… npx vitest run __tests__/live/v22-close-nb1-live.test.tsx
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
import { firstTradeDepositAtoms } from "@/lib/first-trade";
import { parsePortfolio } from "@/lib/v22/layout";

const SLAB = process.env.LIVE_SLAB ?? "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5";

describe.skipIf(!RPC)("LIVE NB-1: open then close through useClosePosition", () => {
  it("named portfolio (ticket / row), then unnamed (panel)", async () => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const sign = async (tx: Transaction) => { tx.partialSign(kp); return tx; };
    const w: WalletApi = { publicKey: kp.publicKey, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)), disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(SLAB), tr: useTrade(SLAB), cp: useClosePosition(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const mark = async () => {
      const info = await conn.getAccountInfo(new PublicKey(SLAB));
      const m = BigInt(parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN).markEwmaE6);
      seedFromOnChain(SLAB, m);
      return m;
    };
    const read = async (pf: PublicKey) => parsePortfolio(new Uint8Array((await conn.getAccountInfo(pf, "confirmed"))!.data));
    for (const round of ["named", "unnamed"] as const) {
      const markE6 = await mark();
      const size = (5_000_000n * 1_000_000n) / markE6; // ~$5
      let pf = await findV17Portfolio(conn, programId, new PublicKey(SLAB), kp.publicKey);
      await act(async () => {
        // The close sweeps the account back to the wallet, so every round funds and trades in one prompt (the ticket's flow).
        const r = await result.current.ft.fundAndTrade({ size, depositAtoms: firstTradeDepositAtoms(8_000_000n, 100_000n), limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "test" });
        pf = r.portfolio;
        LOG(`[${round}] OPEN sig=${r.signature} portfolio=${r.portfolio.toBase58()} created=${r.created}`);
      });
      await new Promise((r) => setTimeout(r, 5000));
      const open = await read(pf!);
      LOG(`[${round}] open legs=${open.legs.filter((l) => l.active).length} q=${open.legs.find((l) => l.active)?.basisPosQ}`);
      expect(open.legs.filter((l) => l.active)).toHaveLength(1);
      await mark();
      await act(async () => {
        try {
          const r = round === "named" ? await result.current.cp.closePosition(100, { portfolioPk: pf! }) : await result.current.cp.closePosition(100);
          LOG(`[${round}] CLOSE via useClosePosition ok ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        } catch (e) {
          LOG(`[${round}] CLOSE FAILED ${(e as Error).name}: ${(e as Error).message}`);
          throw e;
        }
      });
      await new Promise((r) => setTimeout(r, 5000));
      const closed = await read(pf!);
      LOG(`[${round}] after close legs=${closed.legs.filter((l) => l.active).length} capital=${closed.capital}`);
      expect(closed.legs.filter((l) => l.active)).toHaveLength(0);
    }
  }, 600_000);
});
