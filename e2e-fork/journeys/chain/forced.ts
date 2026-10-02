/**
 * Forced conditions (chain level). State that the seed cannot produce (lapsed
 * backing, ResetPending side) is created by RECORDED state surgery on the local
 * validator (surfnet_setAccount on the slab bytes — never possible on devnet), with a
 * negative control proving the condition is real before the repair is exercised.
 *
 * F1 lapsed bucket      → user trade alone fails 19/21; [Expire(89) + trade] in ONE tx lands
 * F2 reset-pending side → user trade alone fails 21;    [Finalize(45) + trade] in ONE tx lands
 * F5 bankrupt account   → keeper liquidates (price moved on the mainnet-fork DEX pool)
 * F6 keeper stopped     → engine clock lags; after restart markets recover (lag, crank ok/rev, trade)
 * (F3 LP near floor / F4 out-of-band band message are UI-level: journeys/ui)
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as P from "../../lib/perc.ts";
import { rpc } from "../../lib/chain.ts";
import { check, record } from "../../lib/results.ts";
import {
  V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN, V17_ASSET_SLOT_WRAPPER_LEN, V17_ENGINE_BACKING_LONG_REL, V17_ENGINE_BACKING_SHORT_REL,
  parseDexPool,
} from "@percolatorct/sdk";

export const ENGINE0 = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_ASSET_SLOT_WRAPPER_LEN;
export const BB_EXPIRY = 88; // BackingBucketV16.expiry_slot (u64), matches the SDK parser's BB_EXPIRY_SLOT
export const SIDE_MODE_LONG = 513, SIDE_MODE_SHORT = 514; // engine-rel (p0b-frontend §3, dump_layout @6377376a)

export async function patchSlab(slab: PublicKey, edits: [number, Buffer][]): Promise<void> {
  const ai = (await P.conn.getAccountInfo(slab, "confirmed"))!;
  const d = Buffer.from(ai.data);
  for (const [off, b] of edits) b.copy(d, off);
  await rpc(P.RPC, "surfnet_setAccount", [slab.toBase58(), { data: d.toString("hex"), owner: ai.owner.toBase58(), lamports: ai.lamports }]);
}
export function u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }
export function keeper(cmd: "start" | "stop" | "status"): string {
  return execFileSync("bash", [path.join(P.HARNESS, "lib/keeper-ctl.sh"), cmd], { encoding: "utf8" }).trim();
}
function finalizeResetSideIx(slab: PublicKey, side: 0 | 1): TransactionInstruction {
  // tag 45 FinalizeResetSide { asset_index: u16, side: u8 } — account 0 = market (w), no signer (v16_program.rs:6782/:19296)
  const data = Buffer.alloc(4); data[0] = 45; data.writeUInt16LE(0, 1); data[3] = side;
  return new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: slab, isSigner: false, isWritable: true }], data });
}

/**
 * F1: lapse a backing bucket (domain `d`) by surgery; probe which user/keeper flows it blocks
 * (negative controls), then prove [ExpireBackingBucket(d) + that flow] lands in ONE tx.
 */
export async function lapsedBucket(sym: string, d: 0 | 1 = 1) {
  const J = "F1-lapsed-bucket";
  const m = P.markets()[sym];
  keeper("stop");
  try {
    const t = await P.newWallet({ usdc: 3_000_000_000n });
    const port = await P.createPortfolio(t, m);
    await P.mustSend("deposit", [await P.depositIx(t.publicKey, m, port, 1_000_000_000n)], [t]);
    const st0 = await P.readMarket(m);
    const off = ENGINE0 + (d === 0 ? V17_ENGINE_BACKING_LONG_REL : V17_ENGINE_BACKING_SHORT_REL) + BB_EXPIRY;
    await patchSlab(P.pk(m.slab), [[off, u64(st0.engineSlot - 1n)]]);
    await P.sleep(1500);
    const st1 = await P.readMarket(m);
    const b1 = st1.buckets.find((b) => b.domain === d)!;
    check(J, sym, `surgery: domain-${d} bucket lapsed (Fresh, expiry < now)`, b1.lapsed, "lapsed=true", `status=${b1.status} expiry=${b1.expiry} engineSlot=${st1.engineSlot}`);
    const q = await P.qForUsd(m, 100);
    const reg = await P.readLpVault(m);
    const flows: [string, () => Promise<import("@solana/web3.js").TransactionInstruction[]>][] = [
      ["open long", async () => [await P.tradeIx(t.publicKey, m, port, q)]],
      ["open short", async () => [await P.tradeIx(t.publicKey, m, port, -q)]],
      ["Earn deposit", async () => (await P.lpVaultDepositIxs(t.publicKey, m, 100_000_000n, reg.domain)).ixs],
      ["permissionless crank", async () => [P.crankIx(t.publicKey, m)]],
      ["withdraw 1 USDC", async () => [await P.withdrawIx(t.publicKey, m, port, 1_000_000n)]],
    ];
    const blocked: string[] = [];
    for (const [name, build] of flows) {
      const r = await P.send(await build(), [t], { simulateOnly: true });
      record({ journey: J, market: sym, step: `probe with lapsed d${d}: ${name}`, ok: true, actual: r.ok ? "not blocked" : `blocked ${r.err}` });
      if (!r.ok) blocked.push(name);
    }
    if (d === 0) check(J, sym, "negative control: the lapsed d0 bucket blocks at least one flow", blocked.length > 0, "≥1 blocked (Earn deposit 21)", blocked.join(", ") || "nothing blocked");
    else check(J, sym, "observation: a lapsed d1 bucket blocks no user flow (opens/earn/crank/withdraw)", blocked.length === 0, "nothing blocked", blocked.join(", ") || "nothing blocked");
    for (const name of blocked) {
      const build = flows.find((f) => f[0] === name)![1];
      const r = await P.send([P.expireBucketIx(m, d), ...(await build())], [t], { simulateOnly: true });
      check(J, sym, `self-heal (sim): [ExpireBackingBucket(d${d}) + ${name}] in ONE tx`, r.ok, "ok", r.ok ? "ok" : `${r.err}`);
    }
    const target = blocked.find((n) => n.startsWith("open")) ?? blocked[0];
    if (target) {
      const build = flows.find((f) => f[0] === target)![1];
      const healed = await P.send([P.expireBucketIx(m, d), ...(await build())], [t]);
      const st2 = await P.readMarket(m);
      const bb = st2.buckets.find((b) => b.domain === d)!;
      check(J, sym, `self-heal (landed): [Expire(d${d}) + ${target}] one tx`, healed.ok && !bb.lapsed && bb.expiry > st2.chainSlot,
        `ok, d${d} no longer lapsed (re-funded or Expired)`, `${healed.ok ? "ok" : healed.err} d${d}=${bb.status} expiry=${bb.expiry}`, healed.sig ? [healed.sig] : []);
    }
    const p = await P.readPortfolio(port);
    if (p.legs[0]) await P.send([await P.tradeIx(t.publicKey, m, port, -p.legs[0].basisPosQ)], [t]);
  } finally { keeper("start"); }
}

/** F2: put the SHORT side into ResetPending with no OI; prove short open blocked; Finalize+open in one tx lands. */
export async function resetPendingSide(sym: string) {
  const J = "F2-reset-pending";
  const m = P.markets()[sym];
  keeper("stop");
  try {
    const t = await P.newWallet({ usdc: 2_000_000_000n });
    const port = await P.createPortfolio(t, m);
    await P.mustSend("deposit", [await P.depositIx(t.publicKey, m, port, 1_000_000_000n)], [t]);
    await patchSlab(P.pk(m.slab), [[ENGINE0 + SIDE_MODE_SHORT, Buffer.from([2])]]);
    const st1 = await P.readMarket(m);
    check(J, sym, "surgery: short side ResetPending", st1.sideMode.short === "ResetPending", "ResetPending", st1.sideMode.short);
    const q = await P.qForUsd(m, 100);
    const alone = await P.send([await P.tradeIx(t.publicKey, m, port, -q)], [t], { simulateOnly: true });
    check(J, sym, "negative control: short open alone blocked", !alone.ok, "error (Custom 21)", `${alone.err}`);
    const healed = await P.send([finalizeResetSideIx(P.pk(m.slab), 1), await P.tradeIx(t.publicKey, m, port, -q)], [t]);
    const p = await P.readPortfolio(port);
    const st2 = await P.readMarket(m);
    check(J, sym, "self-heal: [FinalizeResetSide(short) + open short] lands in ONE tx", healed.ok && p.legs.length === 1,
      "ok, side Normal, 1 leg", `${healed.ok ? "ok" : healed.err} side=${st2.sideMode.short} legs=${p.legs.length}`, healed.sig ? [healed.sig] : []);
    if (p.legs[0]) await P.send([await P.tradeIx(t.publicKey, m, port, -p.legs[0].basisPosQ)], [t]);
  } finally { keeper("start"); }
}

/** F6: stop the keeper, advance the chain, observe the lag, restart, observe recovery. */
export async function keeperOutage(syms: string[], slots = 750 /* ≈5 min */) {
  const J = "F6-keeper-outage";
  const ms = syms.map((s) => P.markets()[s]);
  keeper("stop");
  const t0 = await Promise.all(ms.map((m) => P.readMarket(m)));
  await P.advanceSlots(slots);
  await P.sleep(3000);
  const t1 = await Promise.all(ms.map((m) => P.readMarket(m)));
  syms.forEach((s, i) => check(J, s, `keeper stopped + ${slots} slots: engine clock lags`, t1[i].lag >= BigInt(slots) - 50n, `lag ≥ ${slots - 50}`, `lag ${t0[i].lag}→${t1[i].lag}`));
  // a trader during the outage (documents behaviour; no pass/fail expectation beyond "not a silent misprice")
  const t = await P.newWallet({ usdc: 2_000_000_000n });
  const port = await P.createPortfolio(t, ms[0]);
  await P.mustSend("deposit", [await P.depositIx(t.publicKey, ms[0], port, 1_000_000_000n)], [t]);
  const during = await P.send([await P.tradeIx(t.publicKey, ms[0], port, await P.qForUsd(ms[0], 100))], [t], { simulateOnly: true });
  record({ journey: J, market: syms[0], step: "trade during outage (observed)", ok: true, actual: during.ok ? "trade would land (engine self-accrues)" : `refused: ${during.err}` });
  keeper("start");
  const t2 = Date.now();
  let rec: P.MarketState[] = [];
  for (let i = 0; i < 40; i++) {
    await P.sleep(3000);
    rec = await Promise.all(ms.map((m) => P.readMarket(m)));
    if (rec.every((s) => s.lag < 150n)) break;
  }
  syms.forEach((s, i) => check(J, s, "after restart: engine clock caught up", rec[i].lag < 150n, "lag < 150", `lag=${rec[i].lag} after ${Math.round((Date.now() - t2) / 1000)}s`));
  const after = await P.send([await P.tradeIx(t.publicKey, ms[0], port, await P.qForUsd(ms[0], 100))], [t]);
  check(J, syms[0], "after restart: trade lands", after.ok, "ok", after.ok ? "ok" : `${after.err}`, after.sig ? [after.sig] : []);
  const p = await P.readPortfolio(port);
  if (p.legs[0]) await P.send([await P.tradeIx(t.publicKey, ms[0], port, -p.legs[0].basisPosQ)], [t]);
}

/**
 * F5: bankrupt account → keeper liquidates. Opens a near-max-leverage LONG, then lowers the
 * price on the MAINNET-FORK DEX pool the keeper reads (Raydium CLMM sqrt_price_x64 @253),
 * advancing slots so the 1 bps/slot engine clamp and the keeper breaker can follow.
 */
export async function bankruptLiquidation(sym = "SOL", dropPct = 9) {
  const J = "F5-bankrupt-liquidation";
  const m = P.markets()[sym];
  if (m.dexType !== "raydium-clmm") throw new Error("F5 implemented for raydium-clmm pools");
  const MRPC = P.RPC; // DEX pools are loaded into the single local validator
  const t = await P.newWallet({ usdc: 2_000_000_000n });
  const port = await P.createPortfolio(t, m);
  const dep = 100_000_000n; // $100
  await P.mustSend("deposit", [await P.depositIx(t.publicKey, m, port, dep)], [t]);
  // ~14x of $100 (SOL imr 500 bps; app caps at 15.01x)
  const sig = await P.mustSend("open long", [await P.tradeIx(t.publicKey, m, port, await P.qForUsd(m, 1400))], [t]);
  const p0 = await P.readPortfolio(port);
  check(J, sym, "open ~14x long", p0.legs.length === 1, "1 leg", `basisPosQ=${p0.legs[0]?.basisPosQ} capital=${p0.capital}`, [sig]);
  // move the DEX price
  const pool = new PublicKey(m.pool);
  const mc = new (await import("@solana/web3.js")).Connection(MRPC, "confirmed");
  const ai = (await mc.getAccountInfo(pool))!;
  const d = Buffer.from(ai.data);
  const orig = Buffer.from(d.subarray(253, 269));
  const sqrt = d.readBigUInt64LE(253) | (d.readBigUInt64LE(261) << 64n);
  const f = BigInt(Math.round(Math.sqrt(1 - dropPct / 100) * 1e9));
  const ns = (sqrt * f) / 1_000_000_000n;
  d.writeBigUInt64LE(ns & ((1n << 64n) - 1n), 253); d.writeBigUInt64LE(ns >> 64n, 261);
  await rpc(MRPC, "surfnet_setAccount", [pool.toBase58(), { data: d.toString("hex"), owner: ai.owner.toBase58(), lamports: ai.lamports }]);
  record({ journey: J, market: sym, step: `DEX price lowered ${dropPct}% on mainnet fork`, ok: true, actual: `sqrt ${sqrt}→${ns}` });
  const mark0 = (await P.readMarket(m)).markE6;
  let liquidated = false; let last: P.PortState | null = null; let st: P.MarketState | null = null;
  for (let i = 0; i < 90 && !liquidated; i++) {
    await P.sleep(8000);
    last = await P.readPortfolio(port);
    st = await P.readMarket(m);
    liquidated = last.legs.length === 0;
  }
  const log = await import("node:fs").then((fs) => fs.readFileSync(path.join(P.RUN, "keeper.log"), "utf8"));
  const liqLines = log.split("\n").filter((l) => /liquidat/i.test(l) && l.includes(m.slab.slice(0, 8)) || /"liq":[1-9]/.test(l)).slice(-3);
  check(J, sym, "keeper liquidated the bankrupt/under-margin account", liquidated, "0 legs",
    `mark ${mark0}→${st?.markE6} legs=${last?.legs.length} capital=${last?.capital} pnl=${last?.pnl}; keeper: ${liqLines.join(" | ").slice(0, 300)}`);
  // restore the pool price
  const d2 = Buffer.from((await mc.getAccountInfo(pool))!.data); orig.copy(d2, 253);
  await rpc(MRPC, "surfnet_setAccount", [pool.toBase58(), { data: d2.toString("hex"), owner: ai.owner.toBase58(), lamports: ai.lamports }]);
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * F3 (Sieve F-3): one bankruptcy + a large price move freezes the market; the
 * permissionless-resolve escape then lets every user withdraw.
 * Repro shape from independent-test-results-2026-09-30.md §F-3: two opposite positions (a
 * TradeCpi vs the LP and a TradeNoCpi user-vs-user), the oracle authority pushes a ~-34% mark,
 * permissionless cranks walk the engine to it (1 bps/slot cap on these markets → real time),
 * FinalizeResetSide both sides; then probe open / reduce / withdraw.
 * Escape: the market's OWN permissionless_resolve_stale_slots is recorded (the seed is to set
 * it; 0 = no exit). If 0, it is set by RECORDED surgery to MIN (9,000) to exercise the path, and
 * a dead feed is simulated by moving last_good_oracle_slot back ≥ 9,000 slots (recorded).
 */
import { encodeTradeNoCpi, encodePushAuthMark, ACCOUNTS_PUSH_AUTH_MARK, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_CLOSE_RESOLVED, buildIx, buildAccountMetas, parseWrapperConfigV17, parseAssetControlSequencesV17, V17_HEADER_LEN } from "@percolatorct/sdk";

function cfgFieldOffset(d: Buffer, field: "permissionlessResolveStaleSlots" | "lastGoodOracleSlot"): number {
  const cur = (parseWrapperConfigV17(new Uint8Array(d), V17_HEADER_LEN) as any)[field] as bigint;
  const probe = 0x1234_5678_9abcn;
  for (let o = V17_HEADER_LEN; o < V17_HEADER_LEN + 2048; o++) {
    const t = Buffer.from(d); t.writeBigUInt64LE(probe, o);
    try { if ((parseWrapperConfigV17(new Uint8Array(t), V17_HEADER_LEN) as any)[field] === probe && t.readBigUInt64LE(o) !== cur) return o; } catch { /* */ }
  }
  throw new Error(`offset of ${field} not found`);
}
async function pushMark(m: P.SeedMarket, markE6: bigint) {
  const d = new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
  const seq = parseAssetControlSequencesV17(d, ENGINE0 - V17_ASSET_SLOT_WRAPPER_LEN).oracleObservation + 1n;
  const marketId = (await P.readMarket(m)).marketId;
  return P.send([buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, { oracleAuthority: P.admin.publicKey, market: P.pk(m.slab) }),
    data: encodePushAuthMark({ assetIndex: 0, marketId, nowSlot: BigInt(await P.conn.getSlot("confirmed")), markE6, observationSequence: seq }) })], [P.admin]);
}
function closeResolvedIx(owner: PublicKey, m: P.SeedMarket, port: PublicKey) {
  const data = Buffer.alloc(17); data[0] = 30; // CloseResolved { fee_rate_per_slot: u128 = 0 }
  return buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED, {
    owner, market: P.pk(m.slab), portfolio: port, destToken: P.getAssociatedTokenAddressSync(P.USDC, owner, false, P.TOKEN_PROGRAM_ID),
    vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID } as any), data });
}

export async function freezeAndPermissionlessResolve(sym = "Percolator", dropPct = 34) {
  const J = "F3-freeze-permissionless-resolve";
  const m = P.markets()[sym];
  keeper("stop");
  const users: { name: string; kp: import("@solana/web3.js").Keypair; port: PublicKey; dep: bigint }[] = [];
  try {
    for (const [name, dep] of [["A-long-vs-LP", 200_000_000n], ["B-long", 1_000_000_000n], ["C-short", 1_000_000_000n]] as const) {
      const kp = await P.newWallet({ usdc: dep + 10_000_000n });
      const port = await P.createPortfolio(kp, m);
      await P.mustSend(`${name} deposit`, [await P.depositIx(kp.publicKey, m, port, dep)], [kp]);
      users.push({ name, kp, port, dep });
    }
    (await import("node:fs")).writeFileSync(`${P.RUN}/f3-users-${sym}.json`, JSON.stringify(users.map((u) => ({ name: u.name, port: u.port.toBase58(), secret: Array.from(u.kp.secretKey) }))));
    const [A, B, C] = users;
    await P.mustSend("A 9x long vs LP", [await P.tradeIx(A.kp.publicKey, m, A.port, await P.qForUsd(m, 1800))], [A.kp]);
    const st0 = await P.readMarket(m);
    const q = await P.qForUsd(m, 500);
    const [ib, ic] = [await P.readPortfolio(B.port), await P.readPortfolio(C.port)];
    const nocpi = buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_TRADE_NOCPI, { signerA: B.kp.publicKey, signerB: C.kp.publicKey, market: P.pk(m.slab), accountA: B.port, accountB: C.port }),
      data: encodeTradeNoCpi({ accountAPortfolioId: ib.portfolioId, accountAPositionEpoch: ib.positionEpoch, accountBPortfolioId: ic.portfolioId, accountBPositionEpoch: ic.positionEpoch, assetIndex: 0, marketId: st0.marketId, sizeQ: q, execPrice: st0.markE6, feeBps: 30n, backingFeeCapBps: 0 }) });
    const r0 = await P.send([nocpi], [B.kp, C.kp]);
    check(J, sym, "setup: A long vs LP (TradeCpi) + B long / C short (TradeNoCpi)", r0.ok && (await P.readPortfolio(A.port)).legs.length === 1, "both land", `${r0.ok ? "ok" : r0.err}`, r0.sig ? [r0.sig] : []);

    // walk the ENGINE effective price down: push the target, crank, repeat (1 bps/slot engine cap).
    // The engine effective price is located as the engine-region u64 that equals the pre-push
    // mark and then moves toward the target (the wrapper's markEwma jumps to the push at once).
    const target = (st0.markE6 * BigInt(100 - dropPct)) / 100n;
    const d0 = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
    const cands: number[] = [];
    for (let o = ENGINE0; o < ENGINE0 + 1300; o++) if (d0.readBigUInt64LE(o) === st0.markE6) cands.push(o);
    const t0 = Date.now(); let eff = st0.markE6; let effOff = -1;
    while (Date.now() - t0 < 50 * 60_000) {
      await pushMark(m, target);
      await P.send([P.crankIx(P.admin.publicKey, m)], [P.admin]);
      const d = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
      if (effOff < 0) effOff = cands.find((o) => { const v = d.readBigUInt64LE(o); return v < st0.markE6 && v >= target; }) ?? -1;
      if (effOff >= 0) eff = d.readBigUInt64LE(effOff);
      if (effOff >= 0 && eff <= (target * 1005n) / 1000n) break;
      await P.sleep(6000);
    }
    check(J, sym, `engine effective price walked ~-${dropPct}% (oracle-authority pushes + permissionless cranks)`, effOff >= 0 && eff <= (target * 1005n) / 1000n,
      `effective ≤ ${target}`, `effective ${st0.markE6}→${eff} @engine+${effOff - ENGINE0} in ${Math.round((Date.now() - t0) / 60000)} min (cands ${cands.map((o) => o - ENGINE0).join(",")})`);
    await P.send([P.crankIx(P.admin.publicKey, m, A.port)], [P.admin]); // touch A so its PnL settles at the walked price
    const aSettled = await P.readPortfolio(A.port);
    record({ journey: J, market: sym, step: "A (9x long) after the move, settled by a crank on its portfolio", ok: true, actual: `capital=${aSettled.capital} pnl=${aSettled.pnl} legs=${aSettled.legs.length}` });
    for (const side of [0, 1] as const) await P.send([finalizeResetSideIx(P.pk(m.slab), side)], [P.admin]);
    for (let i = 0; i < 3; i++) await P.send([P.crankIx(P.admin.publicKey, m)], [P.admin]);
    const stF = await P.readMarket(m);
    const pa = await P.readPortfolio(A.port);
    record({ journey: J, market: sym, step: "state after move", ok: true, actual: `A capital=${pa.capital} pnl=${pa.pnl} legs=${pa.legs.length}; buckets=${JSON.stringify(stF.buckets.filter((b) => b.domain < 2).map((b) => [b.domain, b.status]))} sides=${stF.sideMode.long}/${stF.sideMode.short}` });

    // freeze probes
    const fresh = await P.newWallet({ usdc: 200_000_000n });
    const fp = await P.createPortfolio(fresh, m);
    await P.send([await P.depositIx(fresh.publicKey, m, fp, 100_000_000n)], [fresh]);
    const pOpen = await P.send([await P.tradeIx(fresh.publicKey, m, fp, await P.qForUsd(m, 20))], [fresh], { simulateOnly: true });
    const pc = await P.readPortfolio(C.port);
    const pReduce = pc.legs[0] ? await P.send([await P.tradeIx(C.kp.publicKey, m, C.port, -(pc.legs[0].basisPosQ / 4n))], [C.kp], { simulateOnly: true }) : { ok: false, err: "no leg", logs: [] };
    const pWd = await P.send([await P.withdrawIx(C.kp.publicKey, m, C.port, 1_000_000n)], [C.kp], { simulateOnly: true });
    const frozen = !pOpen.ok && !pReduce.ok && !pWd.ok;
    record({ journey: J, market: sym, step: "freeze probes (F-3 predicts open 21, reduce 21, withdraw 19)", ok: true,
      actual: `open=${pOpen.ok ? "ok" : pOpen.err} reduce=${pReduce.ok ? "ok" : pReduce.err} withdraw=${pWd.ok ? "ok" : pWd.err} → ${frozen ? "FROZEN (F-3 reproduced)" : "not frozen"}` });

    // escape
    const raw = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
    const staleCfg = (parseWrapperConfigV17(new Uint8Array(raw), V17_HEADER_LEN) as any).permissionlessResolveStaleSlots as bigint;
    check(J, sym, "seeded market has a permissionless exit (permissionless_resolve_stale_slots ≠ 0)", staleCfg !== 0n, "≥ 9000 (seed to set)", `${staleCfg} (seed ${"ca17a8c2"})`);
    const stale = staleCfg !== 0n ? staleCfg : 9_000n;
    while (BigInt(await P.conn.getSlot("confirmed")) < stale + 50n) await P.sleep(5000); // young offline chain
    const slot = BigInt(await P.conn.getSlot("confirmed"));
    const edits: [number, Buffer][] = [[cfgFieldOffset(raw, "lastGoodOracleSlot"), u64(slot - stale - 1n)]];
    if (staleCfg === 0n) edits.push([cfgFieldOffset(raw, "permissionlessResolveStaleSlots"), u64(stale)]);
    await patchSlab(P.pk(m.slab), edits);
    record({ journey: J, market: sym, step: "RECORDED surgery for the escape", ok: true, actual: `${staleCfg === 0n ? "permissionless_resolve_stale_slots 0→9000; " : ""}last_good_oracle_slot → now-${stale + 1n} (simulated dead feed ≥ stale window)` });
    const rd = Buffer.alloc(9); rd[0] = 39; rd.writeBigUInt64LE(BigInt(await P.conn.getSlot("confirmed")), 1);
    const caller = await P.newWallet({ sol: 1 });
    const res = await P.send([new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: P.pk(m.slab), isSigner: false, isWritable: true }], data: rd })], [caller]);
    const { parseBackingBucketsV17 } = await import("@percolatorct/sdk");
    const modeAfter = parseBackingBucketsV17(new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data)).mode;
    check(J, sym, "anyone can ResolveStalePermissionless (tag 39) → market Resolved", res.ok && modeAfter !== 0, "ok, mode ≠ Live(0)", res.ok ? `ok (group mode ${modeAfter})` : `${res.err} ${res.logs.slice(-4).join(" | ")}`, res.sig ? [res.sig] : []);
    if (!res.ok) return;

    // every user exits
    let paid = 0n;
    for (const u of [...users, { name: "fresh", kp: fresh, port: fp, dep: 100_000_000n }]) {
      const w0 = await P.usdcBalance(u.kp.publicKey);
      const r = await P.send([closeResolvedIx(u.kp.publicKey, m, u.port)], [u.kp]);
      const got = (await P.usdcBalance(u.kp.publicKey)) - w0; paid += got;
      const after = await P.readPortfolio(u.port).catch(() => null);
      check(J, sym, `${u.name}: CloseResolved withdraws after resolve`, r.ok && (after === null || after.capital === 0n), "ok, capital 0", `${r.ok ? "ok" : r.err} +${got} (deposited ${u.dep})`, r.sig ? [r.sig] : []);
    }
    {
      const w0 = await P.usdcBalance(P.admin.publicKey);
      const rl = await P.send([closeResolvedIx(P.admin.publicKey, m, P.pk(m.lpPortfolio))], [P.admin]);
      record({ journey: J, market: sym, step: "LP portfolio (sandbox owner) CloseResolved", ok: rl.ok, actual: `${rl.ok ? "ok" : rl.err} +${(await P.usdcBalance(P.admin.publicKey)) - w0}` });
    }
    for (const u of users) {
      const left = await P.readPortfolio(u.port).catch(() => null);
      if (!left || (left.capital === 0n && left.pnl <= 0n)) continue;
      const w0 = await P.usdcBalance(u.kp.publicKey);
      const claim = buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED, {
        owner: u.kp.publicKey, market: P.pk(m.slab), portfolio: u.port, destToken: P.getAssociatedTokenAddressSync(P.USDC, u.kp.publicKey, false, P.TOKEN_PROGRAM_ID),
        vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID } as any), data: Buffer.from([46]) });
      const r46 = await P.send([claim], [u.kp]);
      const r30 = await P.send([closeResolvedIx(u.kp.publicKey, m, u.port)], [u.kp]);
      const got = (await P.usdcBalance(u.kp.publicKey)) - w0; paid += got;
      const after = await P.readPortfolio(u.port).catch(() => null);
      check(J, sym, `${u.name}: residual claim (tag 46 ClaimResolvedPayoutTopup + CloseResolved again)`, got > 0n && (!after || (after.capital === 0n && after.pnl <= 0n)),
        "remaining equity paid", `before: capital=${left.capital} pnl=${left.pnl}; tag46=${r46.ok ? "ok" : r46.err} close=${r30.ok ? "ok" : r30.err} +${got}; after capital=${after?.capital} pnl=${after?.pnl}`, [r46.sig ?? "", r30.sig ?? ""]);
    }
    const vaultLeft = (await P.readMarket(m)).vaultTokens;
    record({ journey: J, market: sym, step: "total paid out to users / vault left", ok: true, actual: `paid ${paid}; vault still holds ${vaultLeft}` });
  } finally { keeper("start"); }
}


/** F3b: the owner-signed exit from the F-3 state (triage: ADL reduce-only) — tag 44 RebalanceReduce by
 *  every holder, then cranks + FinalizeResetSide → a fresh pair can open/close and every flat account withdraws. */
export async function freezeThenOwnerExits(sym = "PENGU", dropPct = 34, order: "longs-first" | "shorts-first" = "longs-first", resetBetween = false) {
  const J = `F3b-freeze-owner-exits-${order}${resetBetween ? "-reset-between" : ""}`;
  const m = P.markets()[sym];
  keeper("stop");
  try {
    const users: { name: string; kp: import("@solana/web3.js").Keypair; port: PublicKey }[] = [];
    for (const [name, dep] of [["A-long-vs-LP", 200_000_000n], ["B-long", 1_000_000_000n], ["C-short", 1_000_000_000n]] as const) {
      const kp = await P.newWallet({ usdc: dep + 10_000_000n });
      const port = await P.createPortfolio(kp, m);
      await P.mustSend(`${name} deposit`, [await P.depositIx(kp.publicKey, m, port, dep)], [kp]);
      users.push({ name, kp, port });
    }
    const [A, B, C] = users;
    await P.mustSend("A 9x long", [await P.tradeIx(A.kp.publicKey, m, A.port, await P.qForUsd(m, 1800))], [A.kp]);
    const st0 = await P.readMarket(m);
    const [ib, ic] = [await P.readPortfolio(B.port), await P.readPortfolio(C.port)];
    await P.mustSend("B/C NoCpi", [buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_TRADE_NOCPI, { signerA: B.kp.publicKey, signerB: C.kp.publicKey, market: P.pk(m.slab), accountA: B.port, accountB: C.port }),
      data: encodeTradeNoCpi({ accountAPortfolioId: ib.portfolioId, accountAPositionEpoch: ib.positionEpoch, accountBPortfolioId: ic.portfolioId, accountBPositionEpoch: ic.positionEpoch, assetIndex: 0, marketId: st0.marketId, sizeQ: await P.qForUsd(m, 500), execPrice: st0.markE6, feeBps: 30n, backingFeeCapBps: 0 }) })], [B.kp, C.kp]);
    const target = (st0.markE6 * BigInt(100 - dropPct)) / 100n;
    for (let i = 0; i < 20; i++) { await pushMark(m, target); await P.send([P.crankIx(P.admin.publicKey, m)], [P.admin]); await P.sleep(4000); }
    for (const u of users) await P.send([P.crankIx(P.admin.publicKey, m, u.port)], [P.admin]);
    for (const side of [0, 1] as const) await P.send([finalizeResetSideIx(P.pk(m.slab), side)], [P.admin]);
    const fresh = await P.newWallet({ usdc: 200_000_000n });
    const fp = await P.createPortfolio(fresh, m);
    await P.send([await P.depositIx(fresh.publicKey, m, fp, 100_000_000n)], [fresh]);
    const before = await P.send([await P.tradeIx(fresh.publicKey, m, fp, await P.qForUsd(m, 20))], [fresh], { simulateOnly: true });
    record({ journey: J, market: sym, step: "state after the move: fresh open", ok: true, actual: before.ok ? "open OK (no freeze on this run)" : `blocked ${before.err}` });
    const holders = [...users, { name: "LP (matcher, sandbox owner)", kp: P.admin, port: P.pk(m.lpPortfolio) }];
    const sideOf = async (u: { port: PublicKey }) => { const l = (await P.readPortfolio(u.port)).legs[0]; return l ? (l.basisPosQ < 0n ? 1 : 0) : 2; };
    const withSide = await Promise.all(holders.map(async (u) => ({ u, s: await sideOf(u) })));
    withSide.sort((a, b) => (order === "shorts-first" ? b.s % 2 - a.s % 2 : a.s % 2 - b.s % 2));
    let prevSide = -1;
    for (const { u, s: side } of withSide) {
      if (resetBetween && prevSide >= 0 && side % 2 !== prevSide % 2) {
        for (let i = 0; i < 3; i++) await P.send([P.crankIx(P.admin.publicKey, m)], [P.admin]);
        for (const sd of [0, 1] as const) await P.send([finalizeResetSideIx(P.pk(m.slab), sd)], [P.admin]);
        record({ journey: J, market: sym, step: "cranks + FinalizeResetSide between sides", ok: true, actual: `sides=${(await P.readMarket(m)).sideMode.long}/${(await P.readMarket(m)).sideMode.short}` });
      }
      prevSide = side;
      const p = await P.readPortfolio(u.port);
      if (!p.legs.length) { record({ journey: J, market: sym, step: `${u.name}: no leg left (liquidated/ADL'd)`, ok: true, actual: `capital=${p.capital}` }); continue; }
      const q = p.legs[0].basisPosQ < 0n ? -p.legs[0].basisPosQ : p.legs[0].basisPosQ;
      const data = Buffer.alloc(1 + 8 + 8 + 2 + 16); data[0] = 44; data.writeBigUInt64LE(p.portfolioId, 1); data.writeBigUInt64LE(p.positionEpoch, 9); data.writeUInt16LE(0, 17);
      data.writeBigUInt64LE(q & ((1n << 64n) - 1n), 19); data.writeBigUInt64LE(q >> 64n, 27);
      const ix = new TransactionInstruction({ programId: P.WRAPPER, keys: [
        { pubkey: u.kp.publicKey, isSigner: true, isWritable: true }, { pubkey: P.pk(m.slab), isSigner: false, isWritable: true }, { pubkey: u.port, isSigner: false, isWritable: true } ], data });
      const r = await P.send([ix], [u.kp]);
      const after = await P.readPortfolio(u.port);
      check(J, sym, `${u.name}: owner-signed exit (tag 44 RebalanceReduce)`, r.ok && after.legs.length === 0, "ok, 0 legs", `${r.ok ? "ok" : `${r.err} ${r.logs.slice(-3).join(" | ")}`} legs=${after.legs.length}`, r.sig ? [r.sig] : []);
    }
    for (let i = 0; i < 3; i++) await P.send([P.crankIx(P.admin.publicKey, m)], [P.admin]);
    for (const side of [0, 1] as const) await P.send([finalizeResetSideIx(P.pk(m.slab), side)], [P.admin]);
    const reopen = await P.send([await P.tradeIx(fresh.publicKey, m, fp, await P.qForUsd(m, 20))], [fresh]);
    check(J, sym, "after exits: market reopens (fresh open lands)", reopen.ok, "ok", reopen.ok ? "ok" : `${reopen.err}`, reopen.sig ? [reopen.sig] : []);
    const fl = await P.readPortfolio(fp); if (fl.legs[0]) await P.send([await P.tradeIx(fresh.publicKey, m, fp, -fl.legs[0].basisPosQ)], [fresh]);
    for (const u of [...users, { name: "fresh", kp: fresh, port: fp }]) {
      const p = await P.readPortfolio(u.port);
      const w0 = await P.usdcBalance(u.kp.publicKey);
      const r = p.capital > 0n ? await P.send([await P.withdrawIx(u.kp.publicKey, m, u.port, p.capital)], [u.kp]) : { ok: true, err: undefined, sig: undefined, logs: [] };
      const got = (await P.usdcBalance(u.kp.publicKey)) - w0;
      check(J, sym, `${u.name}: withdraws all capital after exits`, r.ok && got === p.capital, `+${p.capital}`, `${r.ok ? "ok" : r.err} +${got}`, r.sig ? [r.sig] : []);
    }
  } finally { keeper("start"); }
}


/** F3c: on an already-resolved market, can ANYONE close the matcher-LP portfolio (CloseResolved,
 *  unsigned variant) so that a stuck winner gets paid? Uses the F3 users persisted for `sym`. */
export async function unsignedLpCloseUnblocksWinner(sym = "TRUMP") {
  const J = "F3c-unsigned-lp-close";
  const m = P.markets()[sym];
  const fs = await import("node:fs");
  const us = JSON.parse(fs.readFileSync(`${P.RUN}/f3-users-${sym}.json`, "utf8")) as { name: string; port: string; secret: number[] }[];
  const C = us.find((u) => u.name === "C-short")!;
  const ck = (await import("@solana/web3.js")).Keypair.fromSecretKey(Uint8Array.from(C.secret));
  const cp = P.pk(C.port);
  const before = await P.readPortfolio(cp);
  const { ACCOUNTS_CLOSE_RESOLVED_UNSIGNED, deriveNftRegistry } = await import("@percolatorct/sdk");
  const caller = await P.newWallet({ sol: 1 });
  const lpOwner = P.admin.publicKey;
  const data = Buffer.alloc(17); data[0] = 30;
  const ix = buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED_UNSIGNED, {
    owner: lpOwner, market: P.pk(m.slab), portfolio: P.pk(m.lpPortfolio), destToken: P.getAssociatedTokenAddressSync(P.USDC, lpOwner, false, P.TOKEN_PROGRAM_ID),
    vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID, nftRegistry: deriveNftRegistry(P.WRAPPER, P.pk(m.slab))[0] } as any), data });
  const r = await P.send([ix], [caller]);
  record({ journey: J, market: sym, step: "a random caller closes the resolved LP portfolio (CloseResolved, owner NOT signing)", ok: true, actual: r.ok ? "ok — permissionless" : `refused ${r.err} ${r.logs.slice(-2).join(" | ")}` });
  const w0 = await P.usdcBalance(ck.publicKey);
  const rc = await P.send([closeResolvedIx(ck.publicKey, m, cp)], [ck]);
  const got = (await P.usdcBalance(ck.publicKey)) - w0;
  check(J, sym, "stuck winner C is paid after the LP close", got > 0n, `> 0 (C had capital ${before.capital} pnl ${before.pnl})`, `${rc.ok ? "ok" : rc.err} +${got}`, rc.sig ? [rc.sig] : []);
}

/**
 * F7 dead oracle (keeper stopped for REAL slots): positions exist (loser, winner, flat, LP),
 * pushes stop, `permissionless_resolve_stale_slots` elapses in real slots, anyone resolves
 * (tag 39), and every account withdraws via CloseResolved (tag 30). The ONLY surgery: seeded
 * markets have stale_slots = 0 (B1), so it is set to the program minimum 9,000 — the value the
 * seed must set pre-InitPool. last_good_oracle_slot is NOT touched: the wait is real (~60 min).
 */
export async function deadOracleResolve(sym = "JUP", stale = 9_000n) {
  const J = "F7-dead-oracle-permissionless-resolve";
  const m = P.markets()[sym];
  const users: { name: string; kp: import("@solana/web3.js").Keypair; port: PublicKey }[] = [];
  for (const [name, dep] of [["L-long", 500_000_000n], ["S-short", 500_000_000n], ["F-flat", 300_000_000n]] as const) {
    const kp = await P.newWallet({ usdc: dep + 10_000_000n });
    const port = await P.createPortfolio(kp, m);
    await P.mustSend(`${name} deposit`, [await P.depositIx(kp.publicKey, m, port, dep)], [kp]);
    users.push({ name, kp, port });
  }
  await P.mustSend("L long vs LP", [await P.tradeIx(users[0].kp.publicKey, m, users[0].port, await P.qForUsd(m, 1000))], [users[0].kp]);
  await P.mustSend("S short vs LP", [await P.tradeIx(users[1].kp.publicKey, m, users[1].port, -(await P.qForUsd(m, 500)))], [users[1].kp]);
  const raw = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
  const staleCfg = (parseWrapperConfigV17(new Uint8Array(raw), V17_HEADER_LEN) as any).permissionlessResolveStaleSlots as bigint;
  check(J, sym, "seeded market has a permissionless exit (permissionless_resolve_stale_slots ≠ 0)", staleCfg !== 0n, "≥ 9000", `${staleCfg} (seed ca17a8c2)`);
  if (staleCfg === 0n) {
    await patchSlab(P.pk(m.slab), [[cfgFieldOffset(raw, "permissionlessResolveStaleSlots"), u64(stale)]]);
    record({ journey: J, market: sym, step: "RECORDED surgery: permissionless_resolve_stale_slots 0 → 9000 (what the seed must set before InitPool)", ok: true, actual: "only surgery in F7" });
  }
  keeper("stop");
  try {
    const lastGood = (await P.readMarket(m)).lastGoodOracleSlot;
    const matureAt = lastGood + stale;
    const caller = await P.newWallet({ sol: 1 });
    const resolveIx = async () => { const rd = Buffer.alloc(9); rd[0] = 39; rd.writeBigUInt64LE(BigInt(await P.conn.getSlot("confirmed")), 1);
      return new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: P.pk(m.slab), isSigner: false, isWritable: true }], data: rd }); };
    // negative control halfway
    while (BigInt(await P.conn.getSlot("confirmed")) < lastGood + stale / 2n) await P.sleep(10_000);
    const early = await P.send([await resolveIx()], [caller], { simulateOnly: true });
    check(J, sym, "negative control: resolve refused before the stale window elapses", !early.ok, "OracleStale refusal", `${early.err} @ slot ${await P.conn.getSlot()} (matures ${matureAt})`);
    while (BigInt(await P.conn.getSlot("confirmed")) < matureAt + 5n) await P.sleep(10_000);
    const res = await P.send([await resolveIx()], [caller]);
    const { parseBackingBucketsV17 } = await import("@percolatorct/sdk");
    const mode = parseBackingBucketsV17(new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data)).mode;
    check(J, sym, `pushes stopped ${stale} real slots → anyone resolves (tag 39)`, res.ok && mode !== 0, "Resolved", res.ok ? `mode ${mode}` : `${res.err}`, res.sig ? [res.sig] : []);
    if (!res.ok) return;
    const all = [...users, { name: "LP (owner)", kp: P.admin, port: P.pk(m.lpPortfolio) }];
    const paid: Record<string, bigint> = {};
    for (let round = 0; round < 4; round++) {
      for (const u of all) {
        const p = await P.readPortfolio(u.port).catch(() => null);
        if (!p || (p.capital === 0n && p.pnl === 0n && !p.legs.length)) continue;
        const w0 = await P.usdcBalance(u.kp.publicKey);
        await P.send([closeResolvedIx(u.kp.publicKey, m, u.port)], [u.kp]);
        paid[u.name] = (paid[u.name] ?? 0n) + (await P.usdcBalance(u.kp.publicKey)) - w0;
      }
    }
    for (const u of all) {
      const p = await P.readPortfolio(u.port).catch(() => null);
      check(J, sym, `${u.name}: withdrew everything after resolve`, (paid[u.name] ?? 0n) > 0n && (!p || (p.capital === 0n && p.pnl <= 0n)),
        "paid > 0, portfolio emptied", `paid ${paid[u.name] ?? 0n}; left capital=${p?.capital} pnl=${p?.pnl}`);
    }
    record({ journey: J, market: sym, step: "vault after all closes", ok: true, actual: `${(await P.readMarket(m)).vaultTokens}` });
  } finally { keeper("start"); }
}

/**
 * F8 stake#301 (f9b9190) terminal insurance recovery + CloseSlab proxy, on a stake-bound market:
 * the f9 stake .so is installed IN PLACE over v18.3 stake (existing pools kept — what a deploy does),
 * a staker deposits, fees accrue, the market is resolved (tag 39; stale window by RECORDED surgery —
 * the real-slot path is F7), every trader CloseResolves, then:
 *   negative control: stake tag 30 AdminCloseSlab BEFORE recovery → refused;
 *   anyone: stake tag 29 RecoverTerminalInsurance(amount) → pool.vault grows by amount, market_resolved set;
 *   the staker withdraws principal + recovered budget/fees;
 *   pool admin: tag 30 AdminCloseSlab → the wrapper slab is closed (tombstone / account gone).
 */
export async function stakeTerminalRecovery(sym = "PENGU", stakeSo = process.env.STAKE_F9_SO ?? `${process.env.HOME}/wt/e2e-stake-f9/target/deploy/percolator_stake.so`) {
  const J = "F8-stake-terminal-insurance-recovery";
  const m = P.markets()[sym];
  const fs = await import("node:fs");
  const { putProgram } = await import("../../lib/offline-programs.ts");
  const { sha256, readProgramBytes } = await import("../../lib/chain.ts");
  const bytes = fs.readFileSync(stakeSo);
  const auth = (await readProgramBytes(P.conn, P.STAKE)).authority!;
  await putProgram(P.RPC, P.STAKE, bytes, new PublicKey(auth), bytes.length + 16_384);
  const onchain = (await readProgramBytes(P.conn, P.STAKE)).data.subarray(0, bytes.length);
  check(J, sym, "install stake f9b9190 in place (existing pools kept)", sha256(onchain) === sha256(bytes), sha256(bytes).slice(0, 16), sha256(onchain).slice(0, 16));
  const pool0 = await P.readStakePool(m).catch((e) => { record({ journey: J, market: sym, step: "existing pool decodes under f9", ok: false, err: String(e) }); return null; });
  if (!pool0) return;
  // staker + fees
  const s = await P.newWallet({ usdc: 2_000_000_000n });
  const { userLpAta, ixs } = P.stakeDepositIxs(s.publicKey, m, 1_000_000_000n);
  await P.mustSend("stake deposit", ixs, [s]);
  const { churn } = await import("../chain/products.ts");
  await churn(sym, 3000, 2);
  const trader = await P.newWallet({ usdc: 600_000_000n }); const tp = await P.createPortfolio(trader, m);
  await P.mustSend("trader deposit", [await P.depositIx(trader.publicKey, m, tp, 500_000_000n)], [trader]);
  // resolve (recorded surgery for the stale window)
  keeper("stop");
  try {
    const raw = Buffer.from((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
    while (BigInt(await P.conn.getSlot("confirmed")) < 9_100n) await P.sleep(5000);
    const slot = BigInt(await P.conn.getSlot("confirmed"));
    await patchSlab(P.pk(m.slab), [[cfgFieldOffset(raw, "permissionlessResolveStaleSlots"), u64(9_000n)], [cfgFieldOffset(raw, "lastGoodOracleSlot"), u64(slot - 9_001n)]]);
    const rd = Buffer.alloc(9); rd[0] = 39; rd.writeBigUInt64LE(BigInt(await P.conn.getSlot("confirmed")), 1);
    const res = await P.send([new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: P.pk(m.slab), isSigner: false, isWritable: true }], data: rd })], [s]);
    check(J, sym, "market resolved (tag 39; stale window via RECORDED surgery)", res.ok, "ok", res.ok ? "ok" : `${res.err}`, res.sig ? [res.sig] : []);
    if (!res.ok) return;
    // traders + LP close
    for (const [kp, port] of [[trader, tp], [P.admin, P.pk(m.lpPortfolio)]] as const) for (let i = 0; i < 3; i++) await P.send([closeResolvedIx(kp.publicKey, m, port)], [kp]);
    // accounts
    const pool = P.pk(m.stakePool), vault = P.pk(m.stakeVault), vauth = P.pk(m.stakeVaultAuth), slab = P.pk(m.slab);
    const closeSlabIx = (admin: PublicKey) => {
      const poolAta = P.getAssociatedTokenAddressSync(P.USDC, pool, true, P.TOKEN_PROGRAM_ID);
      return { poolAta, ix: new TransactionInstruction({ programId: P.STAKE, data: Buffer.from([30]), keys: [
        { pubkey: admin, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: slab, isSigner: false, isWritable: true },
        { pubkey: P.pk(m.vaultAta), isSigner: false, isWritable: true }, { pubkey: P.pk(m.vaultAuth), isSigner: false, isWritable: false },
        { pubkey: poolAta, isSigner: false, isWritable: true }, { pubkey: P.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: P.USDC, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: P.WRAPPER, isSigner: false, isWritable: false } ] }) };
    };
    const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
    const cs = closeSlabIx(P.admin.publicKey);
    const pre = await P.send([createAssociatedTokenAccountIdempotentInstruction(P.admin.publicKey, cs.poolAta, pool, P.USDC, P.TOKEN_PROGRAM_ID), cs.ix], [P.admin], { simulateOnly: true });
    check(J, sym, "negative control: AdminCloseSlab (stake tag 30) refused while the insurance budget is outstanding", !pre.ok, "refused (21)", `${pre.err}`);
    const recIx = (amount: bigint) => { const d = Buffer.alloc(9); d[0] = 29; d.writeBigUInt64LE(amount, 1);
      return new TransactionInstruction({ programId: P.STAKE, data: d, keys: [
        { pubkey: s.publicKey, isSigner: false, isWritable: false }, { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: vauth, isSigner: false, isWritable: false }, { pubkey: slab, isSigner: false, isWritable: true }, { pubkey: P.pk(m.vaultAta), isSigner: false, isWritable: true },
        { pubkey: P.pk(m.vaultAuth), isSigner: false, isWritable: false }, { pubkey: P.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: P.WRAPPER, isSigner: false, isWritable: false } ] }); };
    // largest recoverable amount (simulate, descending)
    const wv = (await P.readMarket(m)).vaultTokens;
    let amount = 0n;
    for (let a = wv; a > 0n; a = a / 2n) { const r = await P.send([recIx(a)], [s], { simulateOnly: true }); if (r.ok) { amount = a; break; } }
    if (amount > 0n) { let hi = amount * 2n; let lo = amount; while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if ((await P.send([recIx(mid)], [s], { simulateOnly: true })).ok) lo = mid; else hi = mid; } amount = lo; }
    const v0 = await P.tokenBalance(vault);
    const r29 = await P.send([recIx(amount)], [s]);
    const v1 = await P.tokenBalance(vault);
    const pool1 = await P.readStakePool(m);
    check(J, sym, "anyone: RecoverTerminalInsurance (stake tag 29) moves the budget into pool.vault + sets market_resolved", r29.ok && v1 - v0 >= amount && pool1.marketResolved,
      `vault +${amount}, marketResolved`, `${r29.ok ? "ok" : r29.err} vault +${v1 - v0} marketResolved=${pool1.marketResolved}`, r29.sig ? [r29.sig] : []);
    // staker withdraws
    await P.sleep(3000);
    const lp = await P.tokenBalance(userLpAta);
    const w0 = await P.usdcBalance(s.publicKey);
    const wd = await P.send([P.stakeWithdrawIx(s.publicKey, m, lp)], [s]);
    const got = (await P.usdcBalance(s.publicKey)) - w0;
    check(J, sym, "staker withdraws principal + recovered budget/fees after resolve", wd.ok && got > 1_000_000_000n, "> 1000 USDC", `${wd.ok ? "ok" : wd.err} +${got}`, wd.sig ? [wd.sig] : []);
    // close slab via proxy
    const cs2 = closeSlabIx(P.admin.publicKey);
    const rc = await P.send([createAssociatedTokenAccountIdempotentInstruction(P.admin.publicKey, cs2.poolAta, pool, P.USDC, P.TOKEN_PROGRAM_ID), cs2.ix], [P.admin]);
    const slabAfter = await P.conn.getAccountInfo(slab);
    check(J, sym, "pool admin: AdminCloseSlab (stake tag 30) closes the wrapper market", rc.ok, "ok (slab closed/tombstoned)", `${rc.ok ? "ok" : `${rc.err} ${rc.logs.slice(-3).join(" | ")}`} slab lamports=${slabAfter?.lamports ?? 0} len=${slabAfter?.data.length ?? 0}`, rc.sig ? [rc.sig] : []);
  } finally { keeper("start"); }
}
