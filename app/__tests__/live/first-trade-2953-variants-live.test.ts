// @vitest-environment happy-dom
/**
 * LIVE devnet, SIMULATION ONLY (GH#2953): the first-trade instruction list the app builds
 * (lib/first-trade.ts builders, hooks/useFirstTrade.ts resolution), simulated under variants
 * to isolate which condition raises Custom(21):
 *   AB        = [create, init, deposit, trade]               (what the app simulates today)
 *   crank+AB  = [k x LP catch-up crank, create, init, deposit, trade]  (useTrade's self-heal)
 *   AB+$10    = same at $10 margin
 * Nothing is signed or sent.
 */
import fs from "node:fs";
import { describe, it } from "vitest";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN, deriveVaultAuthority, getAta, parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { simulateForGate } from "@/lib/tx";
import { resolveLpTradeAccounts } from "@/hooks/useTrade";
import { fetchAssetMarketId, fetchPortfolioIdentity } from "@/lib/v18-wire";
import { buildFirstTradeInitIxs, buildFundAndTradeIxs, firstTradeDepositAtoms, predictPortfolioId, readNextPortfolioId } from "@/lib/first-trade";
import { buildCatchUpCrankIx, planCatchUp } from "@/lib/self-heal";
import { computeLimitPriceE6 } from "@/lib/slippage";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");
const PROGRAM = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const MARKET = new PublicKey(process.env.LIVE_MARKET ?? "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");

describe.skipIf(!RPC)("LIVE GH#2953 variants (simulation only)", () => {
  it("isolates the Custom(21)", async () => {
    const conn = new Connection(RPC, "confirmed");
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const owner = kp.publicKey;
    const info = await conn.getAccountInfoAndContext(MARKET, "confirmed");
    const data = new Uint8Array(info.value!.data);
    const wc = parseWrapperConfigV17(data, V17_HEADER_LEN);
    const markE6 = BigInt(wc.markEwmaE6);
    const mint = new PublicKey((wc.collateralMint as PublicKey).toBase58());
    const userAta = await getAta(owner, mint);
    const [vaultPda] = deriveVaultAuthority(PROGRAM, MARKET);
    const vaultTokenAta = await getAta(vaultPda, mint, true);
    const [lp, marketId] = await Promise.all([resolveLpTradeAccounts(conn, PROGRAM, MARKET), fetchAssetMarketId(conn, MARKET, 0)]);
    const lpId = await fetchPortfolioIdentity(conn, lp.accountB);
    LOG(`LP accountB=${lp.accountB.toBase58()} lpId=${JSON.stringify(lpId, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const rent = await conn.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);
    const predicted = predictPortfolioId(readNextPortfolioId(data)!);

    const build = (marginAtoms: bigint, side: 1n | -1n) => {
      const pk = Keypair.generate().publicKey;
      const size = (side * marginAtoms * 1_000_000n) / markE6;
      const fee = (marginAtoms * BigInt(wc.tradeFeeBps) + 9_999n) / 10_000n;
      const a = buildFirstTradeInitIxs({ programId: PROGRAM, owner, market: MARKET, portfolio: pk }, rent);
      const b = buildFundAndTradeIxs(
        {
          programId: PROGRAM, owner, market: MARKET, portfolio: pk, userAta, vaultTokenAta,
          depositAtoms: firstTradeDepositAtoms(marginAtoms, fee), lp, lpId, marketId, size,
          limitPriceE6: computeLimitPriceE6({ markE6, size }), marketTradeFeeBps: BigInt(wc.tradeFeeBps),
        },
        { portfolioId: predicted, sequence: 0n, positionEpoch: 0n },
      );
      return [...a, ...b];
    };
    const run = async (label: string, ixs: TransactionInstruction[]) => {
      const s = await simulateForGate(conn, owner, ixs);
      const tail = s.logs.filter((l) => /Program log|failed/.test(l)).slice(-6).join(" | ");
      LOG(`${label}: err=${JSON.stringify(s.err)} cu=${s.consumed} ${s.err ? tail : ""}`);
      return s;
    };
    const plan = planCatchUp(data, BigInt(info.context.slot), 400_000);
    LOG(`market slot=${info.context.slot} catchUp=${JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const crank = buildCatchUpCrankIx(PROGRAM, owner, MARKET, lp.accountB, []);
    for (const side of [1n, -1n] as const) {
      const tag = side === 1n ? "long" : "short";
      await run(`AB $1 ${tag}`, build(1_000_000n, side));
      await run(`crank+AB $1 ${tag}`, [crank, ...build(1_000_000n, side)]);
      await run(`crank x2+AB $1 ${tag}`, [crank, crank, ...build(1_000_000n, side)]);
      await run(`AB $10 ${tag}`, build(10_000_000n, side));
      await run(`crank+AB $10 ${tag}`, [crank, ...build(10_000_000n, side)]);
    }
    await run(`crank alone`, [crank]);
    if (process.env.LIVE_REFRESH === "1") {
      // Which positioned portfolios does a no-observation crank (RefreshAccount) accept now?
      const V17_PORTFOLIO_MAGIC = Uint8Array.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
      const V17_PF_MARKET_OFF = 16;
      const { parsePortfolioV17, encodePermissionlessCrank, ACCOUNTS_PERMISSIONLESS_CRANK_BASE, buildAccountMetas } =
        await import("@percolatorct/sdk");
      const accts = await conn.getProgramAccounts(PROGRAM, {
        filters: [
          { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
          { memcmp: { offset: 0, bytes: Buffer.from(V17_PORTFOLIO_MAGIC as Uint8Array).toString("base64"), encoding: "base64" } },
          { memcmp: { offset: V17_PF_MARKET_OFF, bytes: MARKET.toBase58() } },
        ],
      });
      const refreshIx = (pf: PublicKey): TransactionInstruction => new TransactionInstruction({
        programId: PROGRAM,
        keys: buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [owner, MARKET, pf]),
        data: Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: [] })),
      });
      const positioned: PublicKey[] = [];
      const fresh = await conn.getAccountInfo(MARKET, "confirmed");
      const md = new Uint8Array(fresh!.data);
      const mdv = new DataView(md.buffer, md.byteOffset, md.byteLength);
      const E = 592 + 758 + 1024;
      const kfEpoch = [mdv.getBigUint64(E + 145, true), mdv.getBigUint64(E + 153, true)];
      LOG(`asset kf_epoch long=${kfEpoch[0]} short=${kfEpoch[1]} stale long=${mdv.getBigUint64(E + 337, true)} short=${mdv.getBigUint64(E + 345, true)}`);
      let reducer: { pk: PublicKey; owner: PublicKey; side: number; basis: bigint } | null = null;
      for (const a of accts) {
        const p = parsePortfolioV17(new Uint8Array(a.account.data));
        const legs = p.legs.filter((l) => l.active && l.assetIndex === 0);
        if (!legs.length) continue;
        positioned.push(a.pubkey);
        for (const l of legs) {
          const isStale = l.kfEpochSnap < kfEpoch[l.side];
          LOG(`  pos ${a.pubkey.toBase58()} owner=${p.owner.toBase58().slice(0, 8)} lp=${p.matcherEnabled} side=${l.side === 0 ? "L" : "S"} basis=${l.basisPosQ} kfEpochSnap=${l.kfEpochSnap} ${isStale ? "STALE" : "current"}`);
          if (!p.matcherEnabled && !reducer && !a.pubkey.equals(lp.accountB)) {
            reducer = { pk: a.pubkey, owner: new PublicKey(p.owner.toBase58()), side: l.side, basis: l.basisPosQ };
          }
        }
      }
      if (reducer) {
        // Control: a STRICT REDUCTION (risk_increasing = false) on the same market, same moment.
        const { buildTradeCpiIx } = await import("@/lib/trade-ix");
        const rid = await fetchPortfolioIdentity(conn, reducer.pk);
        const abs = reducer.basis < 0n ? -reducer.basis : reducer.basis;
        const cut = abs / 10n > 0n ? abs / 10n : 1n;
        const size = reducer.side === 0 ? -cut : cut; // toward zero
        const ix = buildTradeCpiIx({
          programId: PROGRAM, signer: reducer.owner, market: MARKET, accountA: reducer.pk, ...lp,
          takerId: { portfolioId: rid.portfolioId, positionEpoch: rid.positionEpoch }, lpId, marketId,
          legs: [size], size, limitPriceE6: computeLimitPriceE6({ markE6, size }), marketTradeFeeBps: BigInt(wc.tradeFeeBps),
        });
        await run(`CONTROL reduce 10% of ${reducer.pk.toBase58().slice(0, 8)} (${reducer.side === 0 ? "long" : "short"})`, [ix]);
        const inc = reducer.side === 0 ? cut : -cut;
        const ix2 = buildTradeCpiIx({
          programId: PROGRAM, signer: reducer.owner, market: MARKET, accountA: reducer.pk, ...lp,
          takerId: { portfolioId: rid.portfolioId, positionEpoch: rid.positionEpoch }, lpId, marketId,
          legs: [inc], size: inc, limitPriceE6: computeLimitPriceE6({ markE6, size: inc }), marketTradeFeeBps: BigInt(wc.tradeFeeBps),
        });
        await run(`CONTROL increase 10% of ${reducer.pk.toBase58().slice(0, 8)}`, [ix2]);
        if (process.env.LIVE_SELFHEAL === "1") {
          // The useTrade path: sendTx's planSelfHeal with the same options useTrade passes.
          const { planSelfHeal, connectionSelfHealDeps } = await import("@/lib/self-heal");
          const rounds = Number(process.env.LIVE_ROUNDS ?? "6");
          let ok = 0;
          for (let r = 0; r < rounds; r++) {
            const h = await planSelfHeal(
              {
                programId: PROGRAM, market: MARKET, instructions: [ix2], computeUnits: 400_000,
                staleRefreshCranker: owner, catchUp: { cranker: owner, portfolio: lp.accountB, oracleTail: [] },
              },
              connectionSelfHealDeps(conn, MARKET, owner),
            );
            const s = await simulateForGate(conn, owner, h.instructions);
            LOG(`SELFHEAL R${r} outcome=${h.outcome} staleRefreshes=${h.staleRefreshes ?? 0} final=${JSON.stringify(s.err)}`);
            if (!s.err) ok++;
            await new Promise((res) => setTimeout(res, 2500));
          }
          LOG(`useTrade self-heal (existing trader adds 10%): ${ok}/${rounds} clean`);
        }
      }
      LOG(`portfolios=${accts.length} positioned=${positioned.length}`);
      const stale: PublicKey[] = [];
      for (const pf of positioned) {
        const s = await simulateForGate(conn, owner, [refreshIx(pf)]);
        LOG(`  refresh ${pf.toBase58()}: err=${JSON.stringify(s.err)} cu=${s.consumed}`);
        if (!s.err) stale.push(pf);
      }
      // Rounds: re-read the market, refresh ONLY the legs whose kf_epoch_snap is behind the
      // side's kf_epoch, in the user's own tx, then the first trade.
      const rounds = Number(process.env.LIVE_ROUNDS ?? "6");
      let ok = 0;
      for (let r = 0; r < rounds; r++) {
        const ctx = await conn.getAccountInfoAndContext(MARKET, "confirmed");
        const d2 = new Uint8Array(ctx.value!.data);
        const v2 = new DataView(d2.buffer, d2.byteOffset, d2.byteLength);
        const ep = [v2.getBigUint64(E + 145, true), v2.getBigUint64(E + 153, true)];
        const slotLast = v2.getBigUint64(E + 41, true);
        const pfs = await conn.getMultipleAccountsInfo(positioned, "confirmed");
        const st: PublicKey[] = [];
        pfs.forEach((ai, i) => {
          if (!ai) return;
          const p = parsePortfolioV17(new Uint8Array(ai.data));
          if (p.legs.some((l) => l.active && l.assetIndex === 0 && l.kfEpochSnap < ep[l.side])) st.push(positioned[i]);
        });
        const side = r % 2 === 0 ? 1n : -1n;
        const s = await run(
          `R${r} slot=${ctx.context.slot} lag=${BigInt(ctx.context.slot) - slotLast} stale=[${st.map((p) => p.toBase58().slice(0, 8)).join(",")}] refresh+AB $1 ${side === 1n ? "long" : "short"}`,
          [...st.map(refreshIx), ...build(1_000_000n, side)],
        );
        if (!s.err) ok++;
        await new Promise((res) => setTimeout(res, 2500));
      }
      LOG(`refresh-stale + first trade: ${ok}/${rounds} simulated clean`);
    }
    if (process.env.LIVE_INIT_REAL === "1") {
      // Land tx A ONLY (create + init) for real, then simulate B = [deposit, trade] alone.
      const pkp = Keypair.generate();
      const a = buildFirstTradeInitIxs({ programId: PROGRAM, owner, market: MARKET, portfolio: pkp.publicKey }, rent);
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...a), [kp, pkp], { commitment: "confirmed" });
      LOG(`A landed sig=${sig} portfolio=${pkp.publicKey.toBase58()}`);
      const id = await fetchPortfolioIdentity(conn, pkp.publicKey);
      LOG(`real id=${id.portfolioId} predicted=${predicted}`);
      for (const side of [1n, -1n] as const) {
        const size = (side * 1_000_000n * 1_000_000n) / markE6;
        const b = buildFundAndTradeIxs(
          {
            programId: PROGRAM, owner, market: MARKET, portfolio: pkp.publicKey, userAta, vaultTokenAta,
            depositAtoms: 1_110_000n, lp, lpId, marketId, size,
            limitPriceE6: computeLimitPriceE6({ markE6, size }), marketTradeFeeBps: BigInt(wc.tradeFeeBps),
          },
          { portfolioId: id.portfolioId, sequence: id.matcherSequence, positionEpoch: id.positionEpoch },
        );
        await run(`EXISTING-portfolio [deposit,trade] $1 ${side === 1n ? "long" : "short"}`, b);
      }
      await run(`EXISTING-portfolio deposit alone`, [buildFundAndTradeIxs(
        {
          programId: PROGRAM, owner, market: MARKET, portfolio: pkp.publicKey, userAta, vaultTokenAta,
          depositAtoms: 1_110_000n, lp, lpId, marketId, size: 1n, limitPriceE6: 1n,
        },
        { portfolioId: id.portfolioId, sequence: id.matcherSequence, positionEpoch: id.positionEpoch },
      )[0]]);
    }
  }, 300_000);
});
