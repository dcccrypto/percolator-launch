/**
 * B9 on the FINAL set (P3 markets: the matcher LP is the VAULT LP, owner = registry PDA, cannot sign).
 * After a permissionless resolve, does a WINNER's payout depend on an LP-owner signature or on call order?
 *   variant "adversarial": winner CloseResolves first (×2), then the loser, then vault-LP settle (tag 101), then the winner again
 *   variant "permissionless": after the owners' window, a STRANGER closes loser → 101 → winner → every other portfolio
 * Records every payout, what stays stuck, and whether tag 101 is permissionless.
 * Usage: B9_MARKET=TRUMP B9_ORDER=adversarial npx tsx journeys/chain/b9.ts
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  buildIx, buildAccountMetas, ACCOUNTS_CLOSE_RESOLVED, ACCOUNTS_CLOSE_RESOLVED_UNSIGNED, deriveNftRegistry, encodePushAuthMark, ACCOUNTS_PUSH_AUTH_MARK,
  parseWrapperConfigV17, parseAssetControlSequencesV17, parsePortfolioV17, V17_HEADER_LEN, V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN, V17_PORTFOLIO_ACCOUNT_LEN,
  buildVaultLpSettleResolvedIxP3, decodeAssetVaultLpP3, deriveLpVaultRegistry,
} from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";
import { patchSlab, u64 } from "./forced.ts";

const SYM = process.env.B9_MARKET ?? "TRUMP";
const ORDER = (process.env.B9_ORDER ?? "adversarial") as "adversarial" | "permissionless";
const J = `B9-final-${ORDER}`;
const m = P.markets()[SYM];
const slab = P.pk(m.slab);
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
const ata = (o: PublicKey) => P.getAssociatedTokenAddressSync(P.USDC, o, true, P.TOKEN_PROGRAM_ID);
const crSigned = (owner: PublicKey, port: PublicKey) => { const d = Buffer.alloc(17); d[0] = 30; return buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED, { owner, market: slab, portfolio: port, destToken: ata(owner), vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID } as any), data: d }); };
const crUnsigned = (owner: PublicKey, port: PublicKey) => { const d = Buffer.alloc(17); d[0] = 30; return buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_CLOSE_RESOLVED_UNSIGNED, { owner, market: slab, portfolio: port, destToken: ata(owner), vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID, nftRegistry: deriveNftRegistry(P.WRAPPER, slab)[0] } as any), data: d }); };
async function cfgOff(field: string) { const raw = Buffer.from((await P.conn.getAccountInfo(slab))!.data); const pv = 0x1234_5678_9abcn; for (let o = V17_HEADER_LEN; o < V17_HEADER_LEN + 2048; o++) { const t = Buffer.from(raw); t.writeBigUInt64LE(pv, o); try { if ((parseWrapperConfigV17(new Uint8Array(t), V17_HEADER_LEN) as any)[field] === pv) return o; } catch { /* */ } } throw new Error(field); }
async function push(markE6: bigint) {
  const d = new Uint8Array((await P.conn.getAccountInfo(slab))!.data);
  const seq = parseAssetControlSequencesV17(d, V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN).oracleObservation + 1n;
  return P.send([buildIx({ programId: P.WRAPPER, keys: buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, { oracleAuthority: P.admin.publicKey, market: slab }), data: encodePushAuthMark({ assetIndex: 0, marketId: (await P.readMarket(m)).marketId, nowSlot: BigInt(await P.conn.getSlot("confirmed")), markE6, observationSequence: seq }) })], [P.admin]);
}
async function paid(owner: PublicKey, f: () => Promise<P.TxResult>) { const b0 = await P.tokenBalance(ata(owner)); const r = await f(); return { r, got: (await P.tokenBalance(ata(owner))) - b0 }; }

// 1. keep the keeper off this market (its pushes would undo the move / a live oracle blocks the resolve)
const regP = path.join(P.RUN, "keeper-registry.json");
const reg = JSON.parse(fs.readFileSync(regP, "utf8")); reg.markets = reg.markets.filter((x: any) => x.marketAddress !== m.slab); fs.writeFileSync(regP, JSON.stringify(reg, null, 2));
await P.sleep(20_000);
const av = decodeAssetVaultLpP3(new Uint8Array((await P.conn.getAccountInfo(slab))!.data), 0);
record({ journey: J, market: SYM, step: "market is P3 (vault-owned LP, owner = registry PDA)", ok: av.bound, actual: `bound=${av.bound} vaultLp=${av.vaultLpPortfolio?.toBase58()}` });
// 2. winner (short) + loser (long) against the vault LP; price −10%
const W = await P.newWallet({ usdc: 2_000_000_000n }), L = await P.newWallet({ usdc: 2_000_000_000n });
const wp = await P.createPortfolio(W, m), lp = await P.createPortfolio(L, m);
await P.mustSend("W dep", [await P.depositIx(W.publicKey, m, wp, 1_000_000_000n)], [W]);
await P.mustSend("L dep", [await P.depositIx(L.publicKey, m, lp, 1_000_000_000n)], [L]);
await P.mustSend("W short", [await P.tradeIx(W.publicKey, m, wp, -(await P.qForUsd(m, 2000)))], [W]);
await P.mustSend("L long", [await P.tradeIx(L.publicKey, m, lp, await P.qForUsd(m, 2000))], [L]);
const mark0 = (await P.readMarket(m)).markE6; const target = (mark0 * 90n) / 100n;
for (let i = 0; i < 200; i++) { await push(target); await P.send([P.crankIx(P.admin.publicKey, m, wp)], [P.admin]); await P.send([P.crankIx(P.admin.publicKey, m, lp)], [P.admin]); const w = await P.readPortfolio(wp); if (w.pnl > 150_000_000n) break; await P.sleep(4000); }
const wS = await P.readPortfolio(wp), lS = await P.readPortfolio(lp);
check(J, SYM, "setup: winner (short) has positive PnL; loser (long) lost (the engine settles a loss into capital at once)", wS.pnl > 0n && (lS.pnl < 0n || lS.capital < 1_000_000_000n - 6_000_000n), "W pnl>0, L pnl<0 or capital down", `mark ${mark0}→${(await P.readMarket(m)).markE6}; W cap=${wS.capital} pnl=${wS.pnl}; L cap=${lS.capital} pnl=${lS.pnl}`);
// 3. resolve (RECORDED surgery of the dead window; F7 proves the real-slot path)
const stale = (parseWrapperConfigV17(new Uint8Array((await P.conn.getAccountInfo(slab))!.data), V17_HEADER_LEN) as any).permissionlessResolveStaleSlots as bigint;
while (BigInt(await P.conn.getSlot("confirmed")) < stale + 100n) await P.sleep(5000);
await patchSlab(slab, [[await cfgOff("lastGoodOracleSlot"), u64(BigInt(await P.conn.getSlot("confirmed")) - stale - 1n)]]);
const rd = Buffer.alloc(9); rd[0] = 39; rd.writeBigUInt64LE(BigInt(await P.conn.getSlot("confirmed")), 1);
const stranger = await P.newWallet({ sol: 2 });
const res = await P.send([new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: slab, isSigner: false, isWritable: true }], data: rd })], [stranger]);
check(J, SYM, "resolve (tag 39 by a stranger)", res.ok, "ok", res.ok ? "ok" : `${res.err}`, res.sig ? [res.sig] : []);
for (const o of [W.publicKey, L.publicKey, P.admin.publicKey]) await P.send([createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, ata(o), o, P.USDC, P.TOKEN_PROGRAM_ID)], [stranger]);
const vault0 = (await P.readMarket(m)).vaultTokens;
const [registry] = deriveLpVaultRegistry(P.WRAPPER, slab);
const settle = async (signer: Keypair, mode: 0 | 1) => P.send([buildVaultLpSettleResolvedIxP3({ programId: P.WRAPPER, market: slab, registryDomain: 0, lpPortfolio: av.vaultLpPortfolio! } as any, signer.publicKey, ata(P.admin.publicKey), P.pk(m.vaultAta), mode)], [signer]);
const seq: string[] = [];
const step = async (label: string, owner: PublicKey, f: () => Promise<P.TxResult>) => { const { r, got } = await paid(owner, f); seq.push(`${label}: ${r.ok ? "ok" : r.err} +${got}`); return got; };
let wGot = 0n, lGot = 0n;
if (ORDER === "adversarial") {
  wGot += await step("W CloseResolved #1 (before loser/LP)", W.publicKey, () => P.send([crSigned(W.publicKey, wp)], [W]));
  wGot += await step("W CloseResolved #2", W.publicKey, () => P.send([crSigned(W.publicKey, wp)], [W]));
  lGot += await step("L CloseResolved", L.publicKey, () => P.send([crSigned(L.publicKey, lp)], [L]));
  const s1 = await settle(stranger, 0); seq.push(`vault-LP settle (101) by STRANGER: ${s1.ok ? "ok" : s1.err}`);
  if (!s1.ok) { const s2 = await settle(P.admin, 0); seq.push(`vault-LP settle (101) by junior (creator): ${s2.ok ? "ok" : s2.err}`); }
  wGot += await step("W CloseResolved #3 (after 101)", W.publicKey, () => P.send([crSigned(W.publicKey, wp)], [W]));
  wGot += await step("W CloseResolved #4", W.publicKey, () => P.send([crSigned(W.publicKey, wp)], [W]));
} else {
  const fcd = (parseWrapperConfigV17(new Uint8Array((await P.conn.getAccountInfo(slab))!.data), V17_HEADER_LEN) as any).forceCloseDelaySlots as bigint;
  const t0 = BigInt(await P.conn.getSlot("confirmed")); while (BigInt(await P.conn.getSlot("confirmed")) < t0 + fcd + 10n) await P.sleep(5000);
  seq.push(`waited the owners' window (${fcd} slots)`);
  lGot += await step("stranger CloseResolved(L)", L.publicKey, () => P.send([crUnsigned(L.publicKey, lp)], [stranger]));
  const s1 = await settle(stranger, 0); seq.push(`stranger vault-LP settle (101): ${s1.ok ? "ok" : s1.err}`);
  wGot += await step("stranger CloseResolved(W)", W.publicKey, () => P.send([crUnsigned(W.publicKey, wp)], [stranger]));
  wGot += await step("stranger CloseResolved(W) #2", W.publicKey, () => P.send([crUnsigned(W.publicKey, wp)], [stranger]));
  // everyone else too
  const accs = await P.conn.getProgramAccounts(P.WRAPPER, { filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }] });
  for (const a of accs) { const p = parsePortfolioV17(new Uint8Array(a.account.data)) as any; if (!p.marketGroupId.equals(slab) || a.pubkey.equals(wp) || a.pubkey.equals(lp) || a.pubkey.equals(av.vaultLpPortfolio!)) continue;
    await P.send([createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, ata(p.owner), p.owner, P.USDC, P.TOKEN_PROGRAM_ID), crUnsigned(p.owner, a.pubkey)], [stranger]); }
  wGot += await step("stranger CloseResolved(W) after sweep", W.publicKey, () => P.send([crUnsigned(W.publicKey, wp)], [stranger]));
}
const wE = await P.readPortfolio(wp), lE = await P.readPortfolio(lp);
const wEq = wS.capital + wS.pnl, lEq = lS.capital + (lS.pnl < 0n ? lS.pnl : 0n);
record({ journey: J, market: SYM, step: "exact sequence", ok: true, actual: seq.join(" → ") });
check(J, SYM, `winner paid its resolved equity (${ORDER} order)`, wGot > 0n && wE.capital === 0n && wE.pnl <= 0n, `≈ ${wEq} paid, portfolio emptied`, `W paid ${wGot}; left capital=${wE.capital} pnl=${wE.pnl}`);
check(J, SYM, "loser paid its remaining equity", lE.capital === 0n, `≈ ${lEq}`, `L paid ${lGot}; left capital=${lE.capital} pnl=${lE.pnl}`);
record({ journey: J, market: SYM, step: "vault before/after this sequence (stuck = what W/L could not take)", ok: true, actual: `vault ${vault0} → ${(await P.readMarket(m)).vaultTokens}; W stuck=${wE.capital + (wE.pnl > 0n ? wE.pnl : 0n)} L stuck=${lE.capital}` });
