// @vitest-environment node
/**
 * Opt-in DEVNET run of the trader's resolved exit against a real Resolved market (AUD-FC-A2). Skipped unless TRADER_EXIT_SIM=1.
 *   TRADER_EXIT_SIM=1 TRADER_EXIT_KEY=<keypair json> TRADER_EXIT_MARKET=<slab> [TRADER_EXIT_SEND=1] vitest run <this file>
 * Reads the market and the wallet's portfolios, builds the pre-signed list exactly as the hook does, SIMULATES the first CloseResolved
 * (sigVerify off). With TRADER_EXIT_SEND=1 it also signs the list once and runs the driver (real sends: use a throwaway test key only).
 * Output lines go to TRADER_EXIT_OUT.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { deriveVaultAuthority } from "@percolatorct/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadOwnPortfolios, ownResolvedPayIxs, ownerClosePortfolioIx } from "@/lib/limits/own-portfolio-cleanup";
import { TAG_CLAIM_RESOLVED_PAYOUT_TOPUP, TAG_CLOSE_RESOLVED } from "@/lib/limits/constants";
import { TRADER_ITEM_CU, runTraderExit, traderExitItems } from "@/lib/limits/trader-resolved-exit";
import { buildBatchTx } from "@/lib/tx";
import { parseWrapperConfigV17 } from "@/lib/v22/sdk/slab";
import { marketResolvedV22 } from "@/lib/v22/stale-resolve";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const ON = process.env.TRADER_EXIT_SIM === "1" && !!process.env.TRADER_EXIT_KEY && !!process.env.TRADER_EXIT_MARKET;
const OUT = process.env.TRADER_EXIT_OUT;
const log = (o: Record<string, unknown>) => {
  if (OUT) appendFileSync(OUT, JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
};
const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");

describe.skipIf(!ON)("devnet: trader exit from a Resolved market", () => {
  it("reads the market, plans the exit, simulates the first CloseResolved; optionally sends", async () => {
    __setDevnetV22ForTest(true);
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.TRADER_EXIT_KEY!, "utf8")) as number[]));
    const market = new PublicKey(process.env.TRADER_EXIT_MARKET!);
    const conn = new Connection("https://api.devnet.solana.com", "confirmed");
    const info = await conn.getAccountInfo(market, "confirmed");
    expect(info).not.toBeNull();
    const data = new Uint8Array(info!.data);
    const resolved = marketResolvedV22(data);
    const cfg = parseWrapperConfigV17(data);
    const [vaultAuthority] = deriveVaultAuthority(WRAPPER, market);
    const c = { programId: WRAPPER, owner: kp.publicKey, market, collateralMint: cfg.collateralMint, vaultToken: getAssociatedTokenAddressSync(cfg.collateralMint, vaultAuthority, true), vaultAuthority };
    const own = await loadOwnPortfolios(conn, WRAPPER, market, kp.publicKey);
    log({ step: "read", wallet: kp.publicKey.toBase58(), market: market.toBase58(), resolved, ownPortfolios: own.map((p) => ({ key: p.key.toBase58(), capital: p.view.capital, pnl: p.view.pnl, bitmap: p.view.activeBitmap, receiptPresent: p.view.receiptPresent, receiptFinalized: p.view.receiptFinalized })) });
    expect(resolved).toBe(true);
    expect(own.length).toBeGreaterThan(0);
    const items = traderExitItems(own);
    const byKey = new Map(own.map((p) => [p.key.toBase58(), p]));
    const ixsOf = (it: (typeof items)[number]) => {
      const p = byKey.get(it.portfolio)!;
      return it.kind === "close-empty" ? [ownerClosePortfolioIx(WRAPPER, kp.publicKey, market, p)] : [...ownResolvedPayIxs(c, p.key, it.kind === "close-resolved" ? TAG_CLOSE_RESOLVED : TAG_CLAIM_RESOLVED_PAYOUT_TOPUP)];
    };
    const first = items.find((i) => i.kind === "close-resolved");
    expect(first).toBeDefined();
    const bh = await conn.getLatestBlockhash("confirmed");
    const simTx = buildBatchTx({ instructions: ixsOf(first!), computeUnits: TRADER_ITEM_CU["close-resolved"], priorityFeeMicroLamports: 1, blockhash: bh.blockhash, feePayer: kp.publicKey });
    const sim = await conn.simulateTransaction(new VersionedTransaction(simTx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    log({ step: "simulate-first-close-resolved", err: sim.value.err, unitsConsumed: sim.value.unitsConsumed, logs: (sim.value.logs ?? []).filter((l) => /Program log|failed|consumed/.test(l)).slice(-8), items: items.length });
    expect(sim.value.err).toBeNull();

    if (process.env.TRADER_EXIT_SEND !== "1") return;
    const txs: Transaction[] = items.map((it, i) =>
      buildBatchTx({ instructions: ixsOf(it), computeUnits: TRADER_ITEM_CU[it.kind], priorityFeeMicroLamports: 1000 + i + 1, blockhash: bh.blockhash, feePayer: kp.publicKey }),
    );
    for (const t of txs) t.sign(kp);
    const run = await runTraderExit(items.map((item, i) => ({ item, tx: txs[i]! })), {
      read: async () => new Map((await loadOwnPortfolios(conn, WRAPPER, market, kp.publicKey)).map((p) => [p.key.toBase58(), p.view])),
      broadcast: async (tx) => {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
        await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
        log({ step: "sent", sig });
        return sig;
      },
    });
    log({ step: "run", broadcast: run.broadcast, skipped: run.skipped, failed: run.failed, stale: run.stale, remaining: run.remaining, signatures: run.signatures });
    expect(run.remaining).toEqual([]);
  }, 300_000);
});
