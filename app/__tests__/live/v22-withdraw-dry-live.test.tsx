// @vitest-environment happy-dom
/**
 * LIVE devnet, READ-ONLY (skipped unless LIVE_RPC): build the app's WITHDRAW (the post-close funds-back step) of ANOTHER wallet's portfolio exactly as
 * useWithdraw builds it, capture the transaction at the wallet, and list every account key with where it exists (LIVE_OWNER = that wallet's pubkey; the wallet here cannot sign, so nothing is ever sent). Logs the
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
import { useWithdraw } from "@/hooks/useWithdraw";
import { seedFromOnChain } from "@/lib/priceStore/priceStore";
import { parsePortfolio } from "@/lib/v22/layout";

const SLAB = process.env.LIVE_SLAB ?? "";
class WouldSign extends Error {}

describe.skipIf(!RPC || !process.env.LIVE_OWNER)("LIVE dry withdraw of another wallet's portfolio", () => {
  it("simulates", async () => {
    const owner = new PublicKey(process.env.LIVE_OWNER!);
    let captured: Transaction | null = null;
    const sign = async (tx: Transaction): Promise<Transaction> => { captured = tx; throw new WouldSign("simulation passed: the wallet would open now"); };
    const w: WalletApi = { publicKey: owner, connected: true, connecting: false, wallet: null, signTransaction: sign, signAndSendTransaction: undefined, signMessage: undefined, signAllTransactions: async () => { throw new WouldSign("simulation passed"); }, disconnect: async () => {} };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}><SlabProvider slabAddress={SLAB}>{children}</SlabProvider></WalletApiContext.Provider>
    );
    const { result } = renderHook(() => ({ slab: useSlabState(), wd: useWithdraw(SLAB) }), { wrapper });
    await waitFor(() => expect(result.current.slab.config).toBeTruthy(), { timeout: 30_000 });
    const programId = result.current.slab.programId as PublicKey;
    const pf = process.env.LIVE_PORTFOLIO ? new PublicKey(process.env.LIVE_PORTFOLIO) : await findV17Portfolio(conn, programId, new PublicKey(SLAB), owner);
    const info = await conn.getAccountInfo(new PublicKey(SLAB));
    const cfg = parseWrapperConfigV17(new Uint8Array(info!.data), V17_HEADER_LEN);
    seedFromOnChain(SLAB, BigInt(cfg.markEwmaE6));
    const p = parsePortfolio(new Uint8Array((await conn.getAccountInfo(pf!, "confirmed"))!.data));
    LOG(`portfolio=${pf!.toBase58()} capital=${p.capital} pnl=${p.pnl} legs=${p.legs.filter((l) => l.active).map((l) => `${l.assetIndex}:${l.basisPosQ}`).join(" ")} markE6=${cfg.markEwmaE6}`);
    let verdict = "";
    const amount = process.env.LIVE_AMOUNT ? BigInt(process.env.LIVE_AMOUNT) : p.capital;
    LOG(`withdraw amount=${amount}`);
    await act(async () => {
      try {
        await result.current.wd.withdraw({ userIdx: 0, amount, portfolioPk: pf!, strictPortfolio: true });
        verdict = "SENT?!";
      } catch (e) {
        const x = e as Error & { code?: number | null; instructionIndex?: number | null };
        verdict = captured ? "SIM PASS (would prompt the wallet)" : `REFUSED ${x.name} code=${x.code} ix=${x.instructionIndex} :: ${x.message.slice(0, 200).replace(/\n/g, " ")}`;
      }
    });
    LOG(`VERDICT: ${verdict}`);
    LOG(`hook error text: ${JSON.stringify(result.current.wd.error)}`);
    const tx = captured as Transaction | null;
    if (tx) {
      LOG(`blockhash=${tx.recentBlockhash} feePayer=${tx.feePayer?.toBase58()}`);
      const main = new Connection(process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
      tx.instructions.forEach((ix, n) => LOG(`ix${n} program=${ix.programId.toBase58()} data=${Buffer.from(ix.data).toString("hex").slice(0, 80)} keys=${ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isWritable ? "(w)" : ""}${k.isSigner ? "(s)" : ""}`).join(",")}`));
      const keys = [...new Map(tx.instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => [k.toBase58(), k])).values()];
      const [dev, mn] = await Promise.all([conn.getMultipleAccountsInfo(keys), main.getMultipleAccountsInfo(keys).catch(() => keys.map(() => undefined))]);
      keys.forEach((k, n) => LOG(`KEY ${k.toBase58()} devnet=${dev[n] ? `yes owner=${dev[n]!.owner.toBase58().slice(0, 8)} len=${dev[n]!.data.length}` : "NO"} mainnet=${mn[n] === undefined ? "?" : mn[n] ? `yes owner=${mn[n]!.owner.toBase58().slice(0, 8)}` : "no"}`));
      LOG(`blockhash valid on devnet=${(await conn.isBlockhashValid(tx.recentBlockhash!)).value} on mainnet=${await main.isBlockhashValid(tx.recentBlockhash!).then((r) => r.value, () => "?")}`);
    }
    expect(verdict).not.toBe("SENT?!");
  }, 300_000);
});
