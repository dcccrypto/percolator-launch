/**
 * B12 rerun on the final wrapper (b2b2559e) + keeper ade1e51: stakers' terminal insurance is
 * recovered even with ABANDONED portfolios (owner keys discarded) on the market.
 *   a stranger: CloseResolved (unsigned) → tag 8 ClosePortfolio with [3] = owner (rent → owner)
 *   keeper: B12 alert while blocked (portfolio count), no cranking of the resolved market (B13),
 *           tag 29 recovers the budget, tag 29(0) → 31 (B14), then the staker redeems.
 * Usage: B12_STATE=.run/seed-state-b12.json npx tsx journeys/chain/b12.ts   (a non-P3 market seeded fresh)
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { buildIx, buildAccountMetas, ACCOUNTS_CLOSE_RESOLVED_UNSIGNED, deriveNftRegistry, encodeStakeFlushToInsurance, flushToInsuranceAccounts, parsePortfolioV17, parseWrapperConfigV17, V17_HEADER_LEN, V17_MARKET_GROUP_OFF, V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
import { rpc } from "../../lib/chain.ts";
import { check, record } from "../../lib/results.ts";
import { keeper, patchSlab, u64 } from "./forced.ts";

const J = "B12-rerun-abandoned-portfolios";
const KEEPER_DIR = process.env.KEEPER_DIR ?? `${process.env.HOME}/wt/e2e-keeper-0930`;
const TI = await import(path.join(KEEPER_DIR, "src/cross-cluster/terminal-insurance.ts"));
const log = () => fs.readFileSync(path.join(P.RUN, "keeper.log"), "utf8");
const count = async (m: P.SeedMarket) => Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data).readBigUInt64LE(V17_MARKET_GROUP_OFF + 517);
const budget = async (m: P.SeedMarket) => { const s = TI.decodeTerminalState(new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data)); return s && s.kind !== "closed" ? s.budget as bigint : -1n; };

async function abandonedTrader(m: P.SeedMarket, leaveOpen: boolean) {
  const kp = Keypair.generate(); // NOT persisted: its owner is gone
  await rpc(P.RPC, "surfnet_setAccount", [kp.publicKey.toBase58(), { lamports: 2 * LAMPORTS_PER_SOL }]);
  await P.mintUsdc(kp.publicKey, 600_000_000n);
  const port = await P.createPortfolio(kp, m);
  await P.mustSend("abandoned deposit", [await P.depositIx(kp.publicKey, m, port, 500_000_000n)], [kp]);
  await P.mustSend("abandoned open", [await P.tradeIx(kp.publicKey, m, port, await P.qForUsd(m, 300))], [kp]);
  if (!leaveOpen) { const l = (await P.readPortfolio(port)).legs[0]; await P.mustSend("abandoned close", [await P.tradeIx(kp.publicKey, m, port, -l.basisPosQ)], [kp]); }
  return { owner: kp.publicKey, port };
}

export async function b12(m: P.SeedMarket, label = process.env.B12_LABEL ?? "B12MKT") {
  const ab = [await abandonedTrader(m, true), await abandonedTrader(m, false), await abandonedTrader(m, false)];
  const s = await P.newWallet({ usdc: 2_000_000_000n });
  const { userLpAta, ixs } = P.stakeDepositIxs(s.publicKey, m, 1_000_000_000n);
  await P.mustSend("stake deposit", ixs, [s]);
  const fl = await P.send([buildIx({ programId: P.STAKE, keys: flushToInsuranceAccounts({ caller: P.admin.publicKey, pool: P.pk(m.stakePool), vault: P.pk(m.stakeVault), vaultAuth: P.pk(m.stakeVaultAuth), slab: P.pk(m.slab), wrapperVault: P.pk(m.vaultAta), percolatorProgram: P.WRAPPER }), data: encodeStakeFlushToInsurance(500_000_000n) })], [P.admin]);
  const bud = await budget(m);
  check(J, label, "setup: 3 abandoned traders (keys discarded, one left open) + staker 1000 + admin flush 500", fl.ok && bud >= 500_000_000n, "budget ≥ 500e6", `flush ${fl.ok ? "ok" : fl.err} budget=${bud} materialized=${await count(m)}`);
  // register with the keeper
  const regP = path.join(P.RUN, "keeper-registry.json"); const reg = JSON.parse(fs.readFileSync(regP, "utf8"));
  if (!reg.markets.some((x: any) => x.marketAddress === m.slab)) reg.markets.push({ label: `${label}/USDC — ${m.dexType}`, marketAddress: m.slab, poolAddress: m.pool, dexType: m.dexType, assetIndex: 0, symbol: label, mainnetCa: (m as any).mainnet_ca, collateral: P.USDC.toBase58(), lpPortfolio: m.lpPortfolio, registeredAt: Date.now() });
  fs.writeFileSync(regP, JSON.stringify(reg, null, 2));
  await P.sleep(25_000);
  // resolve: oracle-dead window by RECORDED surgery (the seed set permissionless_resolve_stale_slots; F7 proves the real path)
  keeper("stop");
  const raw = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
  const stale = (parseWrapperConfigV17(new Uint8Array(raw), V17_HEADER_LEN) as any).permissionlessResolveStaleSlots as bigint;
  const probeV = 0x1234_5678_9abcn; let off = -1;
  for (let o = V17_HEADER_LEN; o < V17_HEADER_LEN + 2048 && off < 0; o++) { const t = Buffer.from(raw); t.writeBigUInt64LE(probeV, o); try { if ((parseWrapperConfigV17(new Uint8Array(t), V17_HEADER_LEN) as any).lastGoodOracleSlot === probeV) off = o; } catch { /* */ } }
  while (BigInt(await P.conn.getSlot("confirmed")) < stale + 100n) await P.sleep(5000);
  await patchSlab(P.pk(m.slab), [[off, u64(BigInt(await P.conn.getSlot("confirmed")) - stale - 1n)]]);
  const rd = Buffer.alloc(9); rd[0] = 39; rd.writeBigUInt64LE(BigInt(await P.conn.getSlot("confirmed")), 1);
  const res = await P.send([new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: P.pk(m.slab), isSigner: false, isWritable: true }], data: rd })], [s]);
  check(J, label, `resolve (tag 39; seed stale_slots=${stale}; dead window by RECORDED surgery)`, res.ok, "ok", res.ok ? "ok" : `${res.err}`, res.sig ? [res.sig] : []);
  const mark = log().length;
  keeper("start");
  // keeper: B12 alert while portfolios block; B13 no cranking of the resolved market
  await P.sleep(75_000);
  const L1 = log().slice(mark);
  const alert = L1.split("\n").find((l) => l.includes("[ALERT]") && l.includes(m.slab) && /portfolio/i.test(l)) ?? L1.split("\n").find((l) => l.includes("[ALERT]") && l.includes(label) && /portfolio/i.test(l));
  check(J, label, "keeper ade1e51: critical B12 alert with the blocking portfolio count", !!alert, "ALERT … portfolio(s) …", alert?.slice(0, 300) ?? "none");
  const cranks = L1.split("\n").filter((l) => l.includes(label) && /\[cranker\]|crank revert|crank-reverts|slot-lag/.test(l) && !/no longer cranked/.test(l));
  check(J, label, "keeper ade1e51 (B13): the resolved market is not cranked / no crank alerts", cranks.length === 0, "0 crank lines", `${cranks.length}: ${cranks.slice(0, 2).join(" | ").slice(0, 250)}`);
  // stranger sweep — only after the owners' window: force_close_delay_slots after resolve
  const fcd = (parseWrapperConfigV17(new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data), V17_HEADER_LEN) as any).forceCloseDelaySlots as bigint;
  const tRes = BigInt(await P.conn.getSlot("confirmed"));
  record({ journey: J, market: label, step: "owners' window before a stranger may close (force_close_delay_slots)", ok: true, actual: `${fcd} slots (seed default 432,000 ≈ 2 days: stakers' tag-29 recovery cannot start earlier when owners are absent)` });
  while (BigInt(await P.conn.getSlot("confirmed")) < tRes + fcd + 10n) await P.sleep(5000);
  const stranger = await P.newWallet({ sol: 2 });
  const accs = await P.conn.getProgramAccounts(P.WRAPPER, { filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }] });
  const ports = accs.map((a) => ({ pk: a.pubkey, p: parsePortfolioV17(new Uint8Array(a.account.data)) as any })).filter((x) => x.p.marketGroupId.equals(P.pk(m.slab)));
  const rent0 = await Promise.all(ab.map((a) => P.conn.getBalance(a.owner)));
  const notes: string[] = [];
  // phase 1: CloseResolved rounds across ALL portfolios (payout order matters — B9: winners settle after the LP)
  for (let round = 0; round < 4; round++) for (const x of ports) {
    const owner: PublicKey = x.p.owner; const dest = P.getAssociatedTokenAddressSync(P.USDC, owner, true, P.TOKEN_PROGRAM_ID);
    const cr = Buffer.alloc(17); cr[0] = 30;
    await P.send([createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, dest, owner, P.USDC, P.TOKEN_PROGRAM_ID), buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED_UNSIGNED, { owner, market: P.pk(m.slab), portfolio: x.pk, destToken: dest, vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID, nftRegistry: deriveNftRegistry(P.WRAPPER, P.pk(m.slab))[0] } as any), data: cr })], [stranger]);
  }
  const left = await Promise.all(ports.map(async (x) => { const p = await P.readPortfolio(x.pk); return `${x.pk.toBase58().slice(0, 6)}:cap=${p.capital},pnl=${p.pnl},legs=${p.legs.length}`; }));
  record({ journey: J, market: label, step: "after 4 rounds of stranger CloseResolved (all portfolios)", ok: true, actual: left.join(" ") });
  // phase 2: tag 8 with [3] = owner
  for (const x of ports) {
    const owner: PublicKey = x.p.owner;
    const p = await P.readPortfolio(x.pk);
    const b = Buffer.alloc(25); b[0] = 8; b.writeBigUInt64LE(p.portfolioId, 1); b.writeBigUInt64LE(p.matcherSequence, 9); b.writeBigUInt64LE(p.positionEpoch, 17);
    const r8 = await P.send([new TransactionInstruction({ programId: P.WRAPPER, data: b, keys: [{ pubkey: stranger.publicKey, isSigner: true, isWritable: true }, { pubkey: P.pk(m.slab), isSigner: false, isWritable: true }, { pubkey: x.pk, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: true }] })], [stranger]);
    notes.push(`${x.pk.toBase58().slice(0, 6)}:${r8.ok ? "closed" : r8.err}`);
  }
  const cnt = await count(m);
  const rent1 = await Promise.all(ab.map((a) => P.conn.getBalance(a.owner)));
  check(J, label, "stranger: CloseResolved(unsigned) + tag 8 with [3]=owner dematerialises EVERY portfolio (abandoned included)", cnt === 0n, "materialized 0", `${cnt}: ${notes.join(" ")}`);
  check(J, label, "abandoned owners got their portfolio rent back (not the stranger)", rent1.every((r, i) => r > rent0[i]), "each owner +rent", rent1.map((r, i) => `+${r - rent0[i]}`).join(" "));
  // keeper recovers
  const v0 = await P.tokenBalance(P.pk(m.stakeVault)); const mark2 = log().length;
  let rec = false, done31 = false; const t0 = Date.now();
  while (Date.now() - t0 < 5 * 60_000 && !(rec && done31)) { await P.sleep(8000); const L = log().slice(mark2); rec ||= /tag 29 recovered \d+ atoms/.test(L) && L.includes(label); done31 ||= /Custom\(31\)/.test(L) && L.includes(label); }
  const v1 = await P.tokenBalance(P.pk(m.stakeVault));
  check(J, label, "keeper tag 29 recovers the stakers' budget with abandoned portfolios present", rec && v1 - v0 >= bud && (await budget(m)) === 0n, `pool.vault +${bud}, budget 0`, `+${v1 - v0}, budget ${await budget(m)}`);
  check(J, label, "keeper ade1e51 (B14): tag 29(0) runs after recovery and returns 31 (then done)", done31, "Custom(31) in keeper log", log().slice(mark2).split("\n").find((l) => /Custom\(31\)/.test(l))?.slice(0, 200) ?? "not seen");
  const lp = await P.tokenBalance(userLpAta); const w0 = await P.usdcBalance(s.publicKey);
  const wd = await P.send([P.stakeWithdrawIx(s.publicKey, m, lp)], [s]);
  check(J, label, "staker redeems principal incl. the recovered insurance", wd.ok && (await P.usdcBalance(s.publicKey)) - w0 >= 1_000_000_000n - 2_000n, "≥ 1000 USDC", `${wd.ok ? "ok" : wd.err} +${(await P.usdcBalance(s.publicKey)) - w0}`, wd.sig ? [wd.sig] : []);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const st = JSON.parse(fs.readFileSync(process.env.B12_STATE!, "utf8")).markets;
  const m = Object.values(st)[0] as P.SeedMarket;
  await b12(m);
}
