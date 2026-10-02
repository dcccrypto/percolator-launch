// @vitest-environment happy-dom
/**
 * LIVE devnet diagnostic for GH#2953 (skipped unless LIVE_RPC is set): renders the REAL
 * SlabProvider + useFirstTrade with a Keypair-backed wallet and runs the first-trade path
 * ($1 at 1x, the OrderTicket numbers) from a FRESH wallet (no portfolio on the market).
 *
 *   LIVE_DRY=1 (default): the wallet refuses to sign, so nothing is ever sent; the pre-sign
 *   simulation's verdict (and logs) is what is measured.
 *   LIVE_DRY=0: signs and sends (real first trade).
 *
 *   LIVE_RPC=... LIVE_WALLET=/path/kp.json LIVE_MARKETS=Percolator LIVE_SIDES=long,short \
 *     npx vitest run __tests__/live/first-trade-2953-live.test.tsx
 */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

const RPC = process.env.LIVE_RPC ?? "";
const DRY = process.env.LIVE_DRY !== "0";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);

vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});

import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { firstTradeDepositAtoms } from "@/lib/first-trade";

const MARKETS: Record<string, string> = {
  Percolator: "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn",
  SI: "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx",
  TRENDS: "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh",
  CATE: "Gprscv7AxE8jedSNbLqdfYX7ZgoE8dXpiJuwKEQ8ubCd",
};
const only = process.env.LIVE_MARKETS?.split(",");
const sides = (process.env.LIVE_SIDES ?? "long").split(",") as Array<"long" | "short">;
const ROUNDS = Number(process.env.LIVE_ROUNDS ?? "1");

class DryRunStop extends Error {}

function walletFor(kp: Keypair): WalletApi {
  const sign = async (tx: Transaction) => {
    if (DRY) throw new DryRunStop("dry run: simulation passed, wallet would prompt now");
    tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey, connected: true, connecting: false, wallet: null,
    signTransaction: sign,
    signAndSendTransaction: undefined,
    signMessage: undefined,
    signAllTransactions: async (txs: Transaction[]) => Promise.all(txs.map(sign)),
    disconnect: async () => {},
  };
}

describe.skipIf(!RPC)("LIVE GH#2953: first trade from a fresh wallet", () => {
  const info = console.info.bind(console);
  console.info = (...a: unknown[]) => { LOG(a.map(String).join(" ")); info(...a); };
  for (const [name, slab] of Object.entries(MARKETS)) {
    if (only && !only.includes(name)) continue;
    for (const side of sides) {
      it(`${name} ${side}: $1 1x first trade`, async () => {
        const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
        const w = walletFor(kp);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <WalletApiContext.Provider value={w}>
            <SlabProvider slabAddress={slab}>{children}</SlabProvider>
          </WalletApiContext.Provider>
        );
        const { result } = renderHook(() => ({ slab: useSlabState(), ft: useFirstTrade(slab) }), { wrapper });
        await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
        let passes = 0;
        for (let round = 0; round < ROUNDS; round++) {
          const info = await conn.getAccountInfo(new PublicKey(slab));
          const wc = parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN);
          const markE6 = BigInt(wc.markEwmaE6);
          seedFromOnChain(slab, markE6);
          const fee = BigInt(wc.tradeFeeBps);
          const margin = 1_000_000n; // $1 at 1x
          const abs = (margin * 1_000_000n) / markE6;
          const size = side === "long" ? abs : -abs;
          const feeAtoms = (margin * fee + 9_999n) / 10_000n;
          // OrderTicket (GH#2953): the bundled deposit covers min_nonzero_im_req (config +22, u128 lo).
          const d = new Uint8Array(info!.data);
          const imFloor = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(592 + 32 + 22, true);
          const marginNeed = process.env.LIVE_NO_FLOOR === "1" || margin >= imFloor ? margin : imFloor;
          try {
            await act(async () => {
              const r = await result.current.ft.fundAndTrade({
                size, depositAtoms: firstTradeDepositAtoms(marginNeed, feeAtoms),
                limitPriceE6: computeLimitPriceE6({ markE6, size }), amountLabel: "1.11 USDC",
              });
              LOG(`[${name} ${side} r${round}] SENT sig=${r.signature} portfolio=${r.portfolio.toBase58()} deposit=${firstTradeDepositAtoms(marginNeed, feeAtoms)}`);
            });
            passes++;
          } catch (e) {
            if (e instanceof DryRunStop) { passes++; LOG(`[${name} ${side} r${round}] SIM PASS (dry)`); continue; }
            const err = e as Error & { logs?: string[]; code?: number | null; instructionIndex?: number | null };
            LOG(`[${name} ${side} r${round}] REFUSED ${err.name} code=${err.code} ix=${err.instructionIndex} mark=${markE6}\n${(err.logs ?? []).join("\n")}`);
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        LOG(`[${name} ${side}] passes ${passes}/${ROUNDS}`);
      }, 600_000);
    }
  }
});
