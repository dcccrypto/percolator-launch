// @vitest-environment happy-dom
/**
 * LIVE devnet, READ-ONLY (skipped unless LIVE_RPC): simulate the app's close of ANOTHER wallet's position exactly as the
 * hook builds it (LIVE_OWNER = that wallet's pubkey; the wallet here cannot sign, so nothing is ever sent). Logs the
 * pre-sign verdict and the program logs.  LIVE_OWNER=… LIVE_SLAB=… [LIVE_PCT=100]
 */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Connection, PublicKey, type Transaction } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);
if (RPC) {
  const real = conn.simulateTransaction.bind(conn) as (...a: unknown[]) => Promise<{ value: { err: unknown } }>;
  (conn as unknown as { simulateTransaction: unknown }).simulateTransaction = async (...a: unknown[]) => {
    const r = await real(...a);
    try {
      const tx = a[0] as { message: { compiledInstructions: { programIdIndex: number; data: Uint8Array }[]; staticAccountKeys: { toBase58(): string }[] } };
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      LOG(`SIM err=${JSON.stringify(r.value.err)} ixs=${tx.message.compiledInstructions.map((ix) => `${keys[ix.programIdIndex].slice(0, 6)}:${Buffer.from(ix.data).toString("hex")}`).join(" | ")}`);
    } catch { /* not a versioned tx */ }
    return r;
  };
}
vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { findV17Portfolio } from "@/hooks/useTrade";
import { useClosePosition } from "@/hooks/useClosePosition";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { parsePortfolio } from "@/lib/v22/layout";

const SLAB = process.env.LIVE_SLAB ?? "";
class WouldSign extends Error {}

describe.skipIf(!RPC || !process.env.LIVE_OWNER)("LIVE dry close of another wallet's position", () => {
  it("simulates", async () => {
    const owner = new PublicKey(process.env.LIVE_OWNER!);
    const sign = async (_tx: Transaction): Promise<Transaction> => { throw new WouldSign("simulation passed: the wallet would open now"); };
    const w: WalletApi = { publicKey: owner, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async () => { throw new WouldSign("simulation passed"); }, disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), cp: useClosePosition(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const pf = process.env.LIVE_PORTFOLIO ? new PublicKey(process.env.LIVE_PORTFOLIO) : await findV17Portfolio(conn, programId, new PublicKey(SLAB), owner);
    const info = await conn.getAccountInfo(new PublicKey(SLAB));
    const cfg = parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN);
    seedFromOnChain(SLAB, BigInt(cfg.markEwmaE6));
    const p = parsePortfolio(new Uint8Array((await conn.getAccountInfo(pf!, "confirmed"))!.data));
    LOG(`portfolio=${pf!.toBase58()} capital=${p.capital} pnl=${p.pnl} legs=${p.legs.filter((l) => l.active).map((l) => `${l.assetIndex}:${l.basisPosQ}`).join(" ")} markE6=${cfg.markEwmaE6}`);
    let verdict = "";
    await act(async () => {
      try {
        await result.current.cp.closePosition(Number(process.env.LIVE_PCT ?? "100"), { portfolioPk: pf!, skipSweep: true });
        verdict = "SENT?!";
      } catch (e) {
        const x = e as Error & { code?: number | null; instructionIndex?: number | null; logs?: string[] };
        verdict = e instanceof WouldSign || /would open now|simulation passed/.test(x.message) ? "SIM PASS (would prompt the wallet)" : `REFUSED ${x.name} code=${x.code} ix=${x.instructionIndex} :: ${x.message.slice(0, 160).replace(/\s+/g, " ")}\n${(x.logs ?? []).slice(-14).join("\n")}`;
      }
    });
    LOG(`VERDICT: ${verdict}`);
    LOG(`hook error text: ${JSON.stringify(result.current.cp.error)}`);
    expect(verdict).not.toBe("SENT?!");
  }, 300_000);
});
