/**
 * K29 — keeper #132 @abdbb98 terminal-insurance job (stake tag-29 wind-down, F-9) against the
 * upgraded stake .so (stake#301 f9b9190, plain build sha 33ed0a6d…, the reviewed artifact).
 * Asserts on-chain (and on the keeper's own classifier / log) :
 *  (6) pre-F-9 stake loaded: `npm run pre-resolve` BLOCKS (exit 2) on a Live stake-bound market with a budget
 *  (1) upgraded stake, Live market: tag-29 probe → Custom(30), classified "supported" (pre-F-9 control: "unsupported")
 *  (2) after resolve the KEEPER's tag 29 moves the full budget into pool.vault (budget → 0)
 *  (3) the keeper's tag 29(0) then returns 31 (wind-down complete)
 *  (4) the market is not re-read afterwards ("wind-down already complete")
 *  (5) the staker redeems principal + share
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { buildIx, encodeStakeFlushToInsurance, flushToInsuranceAccounts, parseWrapperConfigV17, V17_HEADER_LEN, V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
import { sha256, readProgramBytes } from "../../lib/chain.ts";
import { putProgram } from "../../lib/offline-programs.ts";
import { check, record } from "../../lib/results.ts";
import { keeper, patchSlab, u64 } from "./forced.ts";
import { buildIx as _b, buildAccountMetas, ACCOUNTS_CLOSE_RESOLVED } from "@percolatorct/sdk";
function closeResolvedIx(owner: PublicKey, m: P.SeedMarket, port: PublicKey) { const data = Buffer.alloc(17); data[0] = 30; return _b({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED, { owner, market: P.pk(m.slab), portfolio: port, destToken: P.getAssociatedTokenAddressSync(P.USDC, owner, false, P.TOKEN_PROGRAM_ID), vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID } as any), data }); }

const KEEPER_DIR = process.env.KEEPER_DIR ?? `${process.env.HOME}/wt/e2e-keeper-0930`;
const TI = await import(path.join(KEEPER_DIR, "src/cross-cluster/terminal-insurance.ts"));
const J = "K29-keeper-terminal-insurance";
const STAKE_F9 = process.env.STAKE_F9_SO ?? path.join(P.RUN, "cache/stake-f9b9190-plain.so");

function budgetOf(d: Uint8Array): bigint { const s = TI.decodeTerminalState(d); return s && s.kind !== "closed" ? s.budget : -1n; }
async function marketData(m: P.SeedMarket) { return new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data); }
function tag29Ix(m: P.SeedMarket, caller: PublicKey, amount: bigint): TransactionInstruction {
  return TI.buildRecoverTerminalInsuranceIx({ stakeProgramId: P.STAKE, wrapperProgramId: P.WRAPPER, caller, market: P.pk(m.slab), pool: P.pk(m.stakePool), poolVault: P.pk(m.stakeVault), collateralMint: P.USDC, amount });
}
/** probe exactly as the keeper does: [CU limit, stake ix] → stake ix at index 1. */
async function probe(m: P.SeedMarket, payer: Keypair) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }), tag29Ix(m, payer.publicKey, 0n));
  tx.recentBlockhash = (await P.conn.getLatestBlockhash()).blockhash; tx.feePayer = payer.publicKey; tx.sign(payer);
  const r = await P.conn.simulateTransaction(tx);
  return { err: r.value.err, cls: TI.classifyTag29Probe(r.value.err, !r.value.err) as string };
}
async function stakeAndFlush(m: P.SeedMarket, flush: bigint) {
  const s = await P.newWallet({ usdc: 2_000_000_000n });
  const { userLpAta, ixs } = P.stakeDepositIxs(s.publicKey, m, 1_000_000_000n);
  await P.mustSend("stake deposit", ixs, [s]);
  const r = await P.send([buildIx({ programId: P.STAKE, keys: flushToInsuranceAccounts({ caller: P.admin.publicKey, pool: P.pk(m.stakePool), vault: P.pk(m.stakeVault), vaultAuth: P.pk(m.stakeVaultAuth), slab: P.pk(m.slab), wrapperVault: P.pk(m.vaultAta), percolatorProgram: P.WRAPPER }), data: encodeStakeFlushToInsurance(flush) })], [P.admin]);
  return { s, userLpAta, flushed: r.ok, err: r.err, sig: r.sig };
}
function preResolve(slab: string): { code: number; out: string } {
  const env = Object.fromEntries(fs.readFileSync(path.join(P.RUN, "keeper.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const r = spawnSync("npx", ["tsx", "src/pre-resolve-drain.ts", "--market", slab], { cwd: KEEPER_DIR, env: { ...process.env, ...env }, encoding: "utf8", timeout: 180_000 });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-6).join(" | ").slice(0, 600) };
}
function keeperLog(): string { return fs.readFileSync(path.join(P.RUN, "keeper.log"), "utf8"); }

/** owner-signed ClosePortfolio (tag 8) for every portfolio on the market whose key the harness holds */
async function closeAllPortfolios(m: P.SeedMarket, extraKeys: Keypair[]) {
  const { parsePortfolioV17, V17_PORTFOLIO_ACCOUNT_LEN } = await import("@percolatorct/sdk");
  const keys = new Map<string, Keypair>();
  for (const k of [P.admin, ...extraKeys]) keys.set(k.publicKey.toBase58(), k);
  for (const l of fs.readFileSync(path.join(P.RUN, "wallets.jsonl"), "utf8").split("\n").filter(Boolean)) { const w = JSON.parse(l); keys.set(w.pk, Keypair.fromSecretKey(Uint8Array.from(w.sk))); }
  const accs = await P.conn.getProgramAccounts(P.WRAPPER, { filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }] });
  const out: string[] = [];
  for (const a of accs) {
    const p = parsePortfolioV17(new Uint8Array(a.account.data)) as any;
    if (!p.marketGroupId.equals(P.pk(m.slab))) continue;
    const kp = keys.get(p.owner.toBase58());
    if (!kp) { out.push(`${a.pubkey.toBase58().slice(0, 6)}:no-key`); continue; }
    const b = Buffer.alloc(25); b[0] = 8; b.writeBigUInt64LE(p.portfolioId, 1); b.writeBigUInt64LE(p.matcherSequence, 9); b.writeBigUInt64LE(p.matcherPositionEpoch, 17);
    const r = await P.send([new TransactionInstruction({ programId: P.WRAPPER, data: b, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }, { pubkey: P.pk(m.slab), isSigner: false, isWritable: true }, { pubkey: a.pubkey, isSigner: false, isWritable: true }] })], [kp]);
    out.push(`${a.pubkey.toBase58().slice(0, 6)}:${r.ok ? "closed" : r.err}`);
  }
  const cnt = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data).readBigUInt64LE(V17_MARKET_GROUP_OFF + 517);
  return { out, cnt };
}

export async function k29(symA = "TRUMP", symB = "BURNIE", flush = 500_000_000n, opts: { aMarket?: P.SeedMarket; skipB?: boolean; extraKeys?: Keypair[] } = {}) {
  const [A, B] = [opts.aMarket ?? P.markets()[symA], P.markets()[symB]];
  // pre-F-9 stake must be loaded for (6) and the negative control of (1)
  const cur = await readProgramBytes(P.conn, P.STAKE);
  record({ journey: J, step: "stake before upgrade", ok: true, actual: `on-chain sha ${sha256(cur.data.subarray(0, 263_960)).slice(0, 16)} (v18.3 = 0c359714…)` });
  if (!opts.skipB) {
  const fb = await stakeAndFlush(B, flush);
  const budB = budgetOf(await marketData(B));
  check(J, symB, "setup: staker deposit + admin FlushToInsurance → Live stake-bound market with a budget", fb.flushed && budB >= flush, `budget ≥ ${flush}`, `flush ${fb.flushed ? "ok" : fb.err} budget=${budB}`, fb.sig ? [fb.sig] : []);
  const pre = preResolve(B.slab);
  check(J, symB, "(6) pre-F-9 stake: `npm run pre-resolve` BLOCKS (exit 2) on a Live bound market with a budget", pre.code === 2, "exit 2 (stranded-budget blocker)", `exit ${pre.code}: ${pre.out}`);
  }
  const p0 = await probe(A, P.admin);
  check(J, symA, "(1-control) pre-F-9 stake: probe classified unsupported (InvalidInstructionData)", p0.cls === "unsupported", "unsupported", `${JSON.stringify(p0.err)} → ${p0.cls}`);

  // upgrade stake in place to the reviewed f9b9190 artifact
  const so = fs.readFileSync(STAKE_F9);
  await putProgram(P.RPC, P.STAKE, so, new PublicKey(cur.authority!), so.length + 16_384);
  const after = await readProgramBytes(P.conn, P.STAKE);
  check(J, "-", "stake upgraded in place to f9b9190 plain", sha256(after.data.subarray(0, so.length)) === sha256(so), sha256(so).slice(0, 16), sha256(after.data.subarray(0, so.length)).slice(0, 16));
  keeper("stop"); keeper("start"); // restart keeper @abdbb98 so its probe cache starts fresh

  const fa = await stakeAndFlush(A, flush);
  const budA = budgetOf(await marketData(A));
  check(J, symA, "setup: staker deposit + flush on the upgraded stake", fa.flushed && budA >= flush, `budget ≥ ${flush}`, `flush ${fa.flushed ? "ok" : fa.err} budget=${budA}`, fa.sig ? [fa.sig] : []);
  const p1 = await probe(A, P.admin);
  check(J, symA, "(1) Live market: probe returns Custom(30) MarketNotTerminal, classified supported", JSON.stringify(p1.err)?.includes('"Custom":30') && p1.cls === "supported", "Custom(30) → supported", `${JSON.stringify(p1.err)} → ${p1.cls}`);
  if (!opts.skipB) { const preAfter = preResolve(B.slab);
  record({ journey: J, market: symB, step: "(6b) after upgrade: pre-resolve on the same market", ok: true, actual: `exit ${preAfter.code}: ${preAfter.out}` }); }

  // resolve A (stale window via RECORDED surgery; F7 proves the real-slot path)
  keeper("stop");
  const raw = Buffer.from(await marketData(A));
  const slot = BigInt(await P.conn.getSlot("confirmed"));
  const off = (field: string) => { const probeV = 0x1234_5678_9abcn; for (let o = V17_HEADER_LEN; o < V17_HEADER_LEN + 2048; o++) { const t = Buffer.from(raw); t.writeBigUInt64LE(probeV, o); try { if ((parseWrapperConfigV17(new Uint8Array(t), V17_HEADER_LEN) as any)[field] === probeV) return o; } catch { /* */ } } throw new Error(field); };
  await patchSlab(P.pk(A.slab), [[off("permissionlessResolveStaleSlots"), u64(9_000n)], [off("lastGoodOracleSlot"), u64(slot - 9_001n)]]);
  const rd = Buffer.alloc(9); rd[0] = 39; rd.writeBigUInt64LE(BigInt(await P.conn.getSlot("confirmed")), 1);
  const res = await P.send([new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: P.pk(A.slab), isSigner: false, isWritable: true }], data: rd })], [fa.s]);
  const stA = TI.decodeTerminalState(await marketData(A));
  check(J, symA, "resolve (tag 39; RECORDED stale surgery)", res.ok && stA?.kind === "resolved", "resolved", `${res.ok ? "ok" : res.err} state=${stA?.kind} budget=${stA && stA.kind !== "closed" ? stA.budget : "-"}`, res.sig ? [res.sig] : []);
  // tag 41 (inside tag 29) needs materialized_portfolio_count == 0: every portfolio must be CLOSED by its owner
  for (let i = 0; i < 3; i++) for (const kp of [P.admin, ...(opts.extraKeys ?? [])]) {
    const { parsePortfolioV17, V17_PORTFOLIO_ACCOUNT_LEN } = await import("@percolatorct/sdk");
    const accs = await P.conn.getProgramAccounts(P.WRAPPER, { filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }] });
    for (const a of accs) { const p = parsePortfolioV17(new Uint8Array(a.account.data)) as any; if (p.marketGroupId.equals(P.pk(A.slab)) && p.owner.equals(kp.publicKey)) for (let j = 0; j < 2; j++) await P.send([closeResolvedIx(kp.publicKey, A, a.pubkey)], [kp]); }
  }
  const ca = await closeAllPortfolios(A, opts.extraKeys ?? []);
  check(J, symA, "every portfolio owner-closed after resolve (materialized_portfolio_count == 0, required by wrapper tag 41)", ca.cnt === 0n, "0", `${ca.cnt}: ${ca.out.join(" ")}`);
  const v0 = await P.tokenBalance(P.pk(A.stakeVault));
  const logMark = keeperLog().length;
  keeper("start");

  // (2)(3) keeper runs the job
  let recovered = false, done = false; const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60_000 && !(recovered && done)) {
    await P.sleep(8000);
    const lg = keeperLog().slice(logMark);
    recovered ||= /tag 29 recovered \d+ atoms/.test(lg);
    done ||= /Custom\(31\)|wind-down complete/.test(lg);
  }
  const v1 = await P.tokenBalance(P.pk(A.stakeVault));
  const budAfter = budgetOf(await marketData(A));
  const lines = keeperLog().slice(logMark).split("\n").filter((l) => /tag 29|terminal|wind-down|Custom\(3[01]\)/.test(l));
  check(J, symA, "(2) keeper tag 29 moves the full budget into pool.vault", recovered && v1 - v0 >= budA && budAfter === 0n, `vault +${budA}, budget 0`, `vault +${v1 - v0}, budget ${budAfter}; ${lines.find((l) => /recovered/.test(l))?.slice(0, 200) ?? "no 'recovered' line"}`);
  check(J, symA, "(3) keeper tag 29(0) then returns 31 (wind-down complete)", done, "Custom(31)", lines.find((l) => /Custom\(31\)|wind-down complete/.test(l))?.slice(0, 200) ?? "not seen");
  // (4) not re-read
  const mark2 = keeperLog().length;
  await P.sleep(50_000);
  const later = keeperLog().slice(mark2).split("\n").filter((l) => /tag 29|terminal/.test(l) && !/already complete/.test(l) && (l.includes(A.slab.slice(0, 8)) || l.includes(symA)));
  check(J, symA, "(4) after completion the market is not re-read (no further tag-29 activity for it over ~3 fee cycles)", later.length === 0, "0 lines", `${later.length} lines ${later.slice(0, 2).join(" | ").slice(0, 200)}`);
  // (5) staker redeems
  const lp = await P.tokenBalance(fa.userLpAta);
  const w0 = await P.usdcBalance(fa.s.publicKey);
  const wd = await P.send([P.stakeWithdrawIx(fa.s.publicKey, A, lp)], [fa.s]);
  const got = (await P.usdcBalance(fa.s.publicKey)) - w0;
  check(J, symA, "(5) staker redeems principal + share after the wind-down", wd.ok && got >= 1_000_000_000n - 2_000n, "≥ 1000 USDC (principal incl. the recovered flush)", `${wd.ok ? "ok" : `${wd.err} ${wd.logs.slice(-2).join(" | ")}`} +${got}`, wd.sig ? [wd.sig] : []);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.K29_STATE) {
    const st = JSON.parse(fs.readFileSync(process.env.K29_STATE, "utf8")).markets.PENGU;
    const trader = st.proof?.traderSecretFORKONLY ? [Keypair.fromSecretKey(Uint8Array.from(st.proof.traderSecretFORKONLY))] : [];
    // register with the harness keeper (registry reload)
    const regP = path.join(P.RUN, "keeper-registry.json"); const reg = JSON.parse(fs.readFileSync(regP, "utf8"));
    if (!reg.markets.some((x: any) => x.marketAddress === st.slab)) reg.markets.push({ label: "PENGU2/USDC — meteora-dlmm", marketAddress: st.slab, poolAddress: st.pool, dexType: st.dexType, assetIndex: 0, symbol: "PENGU2", mainnetCa: st.mainnet_ca, collateral: P.USDC.toBase58(), lpPortfolio: st.lpPortfolio, registeredAt: Date.now() });
    fs.writeFileSync(regP, JSON.stringify(reg, null, 2));
    await P.sleep(20_000);
    await k29("PENGU2", "BURNIE", 500_000_000n, { aMarket: st, skipB: true, extraKeys: trader });
  } else await k29();
}
