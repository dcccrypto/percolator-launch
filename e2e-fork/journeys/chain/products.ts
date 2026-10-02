/**
 * C2 Earn (LP vault) deposit → fees accrue → keeper tag-78 crank → redeem (claim)
 * C3 Stake deposit → fees → keeper tag-87 + stake AccrueFees → withdraw
 * C4 Creator fee claim (tag 90)
 * C5 Position NFT mint → transfer to a second wallet → burn by the new holder → close
 * Every step asserts on-chain state; keeper-driven legs wait (bounded) for the keeper.
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createTransferCheckedWithTransferHookInstruction, createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  buildIx, buildAccountMetas, deriveLpRedemption, deriveLpEscrow, deriveLpBackingLedger, deriveVaultAuthority,
  encodeRequestRedeemLpShares, encodeExecuteRedemption, parseAssetControlSequencesV17, parseAssetOracleProfileV17,
  V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN,
} from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";

const ASSET0 = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;

/** Generate fee volume: open+close $notional `rounds` times with a fresh trader. */
export async function churn(sym: string, notionalUsd = 2000, rounds = 2): Promise<bigint> {
  const m = P.markets()[sym];
  const t = await P.newWallet({ usdc: 5_000_000_000n });
  const port = await P.createPortfolio(t, m);
  await P.mustSend("churn deposit", [await P.depositIx(t.publicKey, m, port, 4_000_000_000n)], [t]);
  const before = (await P.readMarket(m)).fees;
  for (let i = 0; i < rounds; i++) {
    const q = await P.qForUsd(m, notionalUsd);
    await P.mustSend("churn open", [await P.tradeIx(t.publicKey, m, port, i % 2 ? -q : q)], [t]);
    const leg = (await P.readPortfolio(port)).legs[0];
    await P.mustSend("churn close", [await P.tradeIx(t.publicKey, m, port, -leg.basisPosQ)], [t]);
  }
  const after = (await P.readMarket(m)).fees;
  return after.lpAccrued - before.lpAccrued;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000, everyMs = 3000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await P.sleep(everyMs);
  }
  console.log(`  (timeout waiting for ${what})`);
  return null;
}

// ── C2 Earn ──────────────────────────────────────────────────────────────────
export async function earnJourney(sym: string) {
  const J = "C2-earn";
  const m = P.markets()[sym];
  const d = await P.newWallet({ usdc: 2_000_000_000n });
  const reg0 = await P.readLpVault(m);
  const amt = 1_000_000_000n;
  const { lpAta, ixs } = await P.lpVaultDepositIxs(d.publicKey, m, amt, reg0.domain);
  const v0 = (await P.readMarket(m)).vaultTokens;
  const sig = await P.mustSend("earn deposit", ixs, [d]);
  const shares = await P.tokenBalance(lpAta);
  const reg1 = await P.readLpVault(m);
  const v1 = (await P.readMarket(m)).vaultTokens;
  check(J, sym, "deposit: LP shares minted", shares > 0n && reg1.totalLpSharesOutstanding - reg0.totalLpSharesOutstanding === shares, `shares>0 & registry +shares`, `shares=${shares} registryΔ=${reg1.totalLpSharesOutstanding - reg0.totalLpSharesOutstanding}`, [sig]);
  check(J, sym, "deposit: market vault +amount", v1 - v0 === amt, `${amt}`, `${v1 - v0}`);

  const lpFeeGen = await churn(sym, 3000, 2);
  check(J, sym, "fees accrue to LP leg (48%)", lpFeeGen > 0n, "> 0", `lpAccrued Δ=${lpFeeGen}`);
  const s0 = await P.readMarket(m);
  const cranked = await waitFor("keeper tag-78 crank", async () => {
    const s = await P.readMarket(m);
    return s.fees.lpWithdrawn >= s0.fees.lpAccrued ? s : null;
  }, 120_000);
  check(J, sym, "keeper tag-78 LpVaultCrankFees credits the vault", !!cranked, `lpWithdrawn ≥ ${s0.fees.lpAccrued}`, `lpWithdrawn=${cranked?.fees.lpWithdrawn ?? (await P.readMarket(m)).fees.lpWithdrawn}`);
  const reg2 = await P.readLpVault(m);
  check(J, sym, "vault fee distribution total increased", reg2.feeDistributionTotalAtoms > reg1.feeDistributionTotalAtoms, `> ${reg1.feeDistributionTotalAtoms}`, `${reg2.feeDistributionTotalAtoms}`);

  // redeem: request (tag 76) → cooldown → execute (tag 77)
  const W = P.WRAPPER, mk = P.pk(m.slab), registry = P.pk(m.lpVaultRegistry), lpMint = P.pk(m.lpVaultMint);
  const [redemption] = deriveLpRedemption(W, registry, d.publicKey);
  const [escrow] = deriveLpEscrow(W, mk);
  const reqIx = buildIx({ programId: W, keys: [
    { pubkey: d.publicKey, isSigner: true, isWritable: true }, { pubkey: registry, isSigner: false, isWritable: true },
    { pubkey: lpMint, isSigner: false, isWritable: false }, { pubkey: lpAta, isSigner: false, isWritable: true },
    { pubkey: escrow, isSigner: false, isWritable: true }, { pubkey: redemption, isSigner: false, isWritable: true },
    { pubkey: P.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: encodeRequestRedeemLpShares({ shares: shares.toString() }) });
  const sigReq = await P.mustSend("request redeem", [reqIx], [d]);
  check(J, sym, "request redeem: shares escrowed", (await P.tokenBalance(lpAta)) === 0n, "wallet LP 0", `${await P.tokenBalance(lpAta)}`, [sigReq]);
  await P.advanceSlots(Number(reg2.redemptionCooldownSlots) + 5).catch(() => undefined);
  await P.sleep(2000);
  const [vaultAuth] = deriveVaultAuthority(W, mk);
  const [ledger] = deriveLpBackingLedger(W, mk, reg2.domain);
  const [sib] = deriveLpBackingLedger(W, mk, reg2.domain ^ 1);
  const dest = P.getAssociatedTokenAddressSync(P.USDC, d.publicKey, false, P.TOKEN_PROGRAM_ID);
  const exIx = buildIx({ programId: W, keys: [
    { pubkey: d.publicKey, isSigner: true, isWritable: true }, { pubkey: mk, isSigner: false, isWritable: true },
    { pubkey: registry, isSigner: false, isWritable: true }, { pubkey: redemption, isSigner: false, isWritable: true },
    { pubkey: lpMint, isSigner: false, isWritable: true }, { pubkey: escrow, isSigner: false, isWritable: true },
    { pubkey: P.pk(m.vaultAta), isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false },
    { pubkey: ledger, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: P.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: sib, isSigner: false, isWritable: true },
    { pubkey: d.publicKey, isSigner: false, isWritable: true },
  ], data: encodeExecuteRedemption({ domain: reg2.domain }) });
  const exIxT = await P.withP3TailIfBound(exIx, m);
  const w0 = await P.usdcBalance(d.publicKey);
  let ex = await P.send([P.crankIx(d.publicKey, m), exIxT], [d]);
  for (let i = 0; !ex.ok && i < 20 && /Custom":(36|3)\b/.test(ex.err ?? ""); i++) { await P.sleep(3000); ex = await P.send([P.crankIx(d.publicKey, m), exIxT], [d]); }
  const got = (await P.usdcBalance(d.publicKey)) - w0;
  if (!ex.ok) record({ journey: J, market: sym, step: "execute redemption (claim)", ok: false, err: `${ex.err} ${ex.logs.slice(-6).join(" | ")}` });
  else check(J, sym, "execute redemption: paid principal + fee share", got > amt, `> ${amt} (deposit + share of cranked fees)`, `${got} (Δ ${got - amt})`, [ex.sig!]);
}

// ── C3 Stake ─────────────────────────────────────────────────────────────────
export async function stakeJourney(sym: string) {
  const J = "C3-stake";
  const m = P.markets()[sym];
  const s = await P.newWallet({ usdc: 2_000_000_000n });
  const amt = 1_000_000_000n;
  const pool0 = await P.readStakePool(m);
  const { userLpAta, ixs } = P.stakeDepositIxs(s.publicKey, m, amt);
  const sig = await P.mustSend("stake deposit", ixs, [s]);
  const lp = await P.tokenBalance(userLpAta);
  const pool1 = await P.readStakePool(m);
  check(J, sym, "deposit: stake LP minted + pool totalDeposited +amount", lp > 0n && pool1.totalDeposited - pool0.totalDeposited === amt, `lp>0, Δdeposited=${amt}`, `lp=${lp} Δ=${pool1.totalDeposited - pool0.totalDeposited}`, [sig]);

  await churn(sym, 3000, 2);
  const mk0 = await P.readMarket(m);
  check(J, sym, "insurance/staker leg accrued (16%)", mk0.fees.insReserveAccrued > mk0.fees.insReserveWithdrawn, "accrued > withdrawn", `accrued=${mk0.fees.insReserveAccrued} withdrawn=${mk0.fees.insReserveWithdrawn}`);
  const pushed = await waitFor("keeper tag-87 + AccrueFees", async () => {
    const [mk, pl] = await Promise.all([P.readMarket(m), P.readStakePool(m)]);
    return mk.fees.insReserveWithdrawn >= mk0.fees.insReserveAccrued && pl.totalFeesEarned > pool1.totalFeesEarned ? { mk, pl } : null;
  }, 150_000);
  const pl2 = await P.readStakePool(m);
  const mk2 = await P.readMarket(m);
  check(J, sym, "keeper pushes staker leg (tag 87) and books it (AccrueFees)", !!pushed,
    `insReserveWithdrawn ≥ ${mk0.fees.insReserveAccrued} and pool.totalFeesEarned > ${pool1.totalFeesEarned}`,
    `insReserveWithdrawn=${mk2.fees.insReserveWithdrawn} totalFeesEarned=${pl2.totalFeesEarned}`);

  // withdraw after cooldown
  await P.advanceSlots(Number(pl2.cooldownSlots) + 5).catch(() => undefined);
  await P.sleep(1500);
  const w0 = await P.usdcBalance(s.publicKey);
  let wd = await P.send([P.stakeWithdrawIx(s.publicKey, m, lp)], [s]);
  for (let i = 0; !wd.ok && i < 15; i++) { await P.sleep(2000); wd = await P.send([P.stakeWithdrawIx(s.publicKey, m, lp)], [s]); }
  const got = (await P.usdcBalance(s.publicKey)) - w0;
  if (!wd.ok) record({ journey: J, market: sym, step: "withdraw (claim)", ok: false, err: `${wd.err} ${wd.logs.slice(-6).join(" | ")}` });
  else check(J, sym, "withdraw: principal + staker fee share", got > amt - 2_000n, `≈ ≥ ${amt} (minus min-liquidity lock dust)`, `${got} (Δ ${got - amt})`, [wd.sig!]);
}

// ── C4 Creator fee claim ─────────────────────────────────────────────────────
export async function creatorFeeJourney(sym: string) {
  const J = "C4-creator-fee";
  const m = P.markets()[sym];
  await churn(sym, 2000, 1);
  const raw = new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
  const prof = parseAssetOracleProfileV17(raw, ASSET0) as any;
  const claimable: bigint = prof.creatorFeeClaimableAtoms;
  const assetAdmin: PublicKey = prof.assetAdmin;
  check(J, sym, "creator (asset_admin) accrued a claimable fee", claimable > 0n, "> 0", `${claimable} asset_admin=${assetAdmin?.toBase58?.()}`);
  if (!assetAdmin?.equals(P.admin.publicKey)) {
    record({ journey: J, market: sym, step: "asset_admin is the seed creator key", ok: false, expected: P.admin.publicKey.toBase58(), actual: assetAdmin?.toBase58?.() });
    return;
  }
  const seqs = parseAssetControlSequencesV17(raw, ASSET0);
  const dest = P.getAssociatedTokenAddressSync(P.USDC, P.admin.publicKey, false, P.TOKEN_PROGRAM_ID);
  const b0 = await P.tokenBalance(dest);
  const ix = buildIx({
    programId: P.WRAPPER,
    keys: buildAccountMetas(P.ACCOUNTS_WITHDRAW_CREATOR_FEE, { authority: P.admin.publicKey, market: P.pk(m.slab), destToken: dest, vaultToken: P.pk(m.vaultAta), vaultAuthority: P.pk(m.vaultAuth), tokenProgram: P.TOKEN_PROGRAM_ID } as any),
    data: P.encodeWithdrawCreatorFee({ amount: claimable, assetIndex: 0, authorityEpoch: seqs.authorityEpoch }),
  });
  const r = await P.send([ix], [P.admin]);
  if (!r.ok) { record({ journey: J, market: sym, step: "tag 90 WithdrawCreatorFee", ok: false, err: `${r.err} ${r.logs.slice(-6).join(" | ")}` }); return; }
  const b1 = await P.tokenBalance(dest);
  const after = (parseAssetOracleProfileV17(new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data), ASSET0) as any).creatorFeeClaimableAtoms;
  check(J, sym, "claim: creator ATA +claimable, counter → 0", b1 - b0 === claimable && after === 0n, `+${claimable}, 0`, `+${b1 - b0}, ${after}`, [r.sig!]);
}

// ── C5 NFT mint → transfer → burn by new holder → close ──────────────────────
export async function nftJourney(sym: string) {
  const J = "C5-nft";
  const m = P.markets()[sym];
  const a = await P.newWallet({ usdc: 2_000_000_000n });
  const b = await P.newWallet({ usdc: 0n });
  const port = await P.createPortfolio(a, m);
  await P.mustSend("deposit", [await P.depositIx(a.publicKey, m, port, 1_000_000_000n)], [a]);
  await P.mustSend("open", [await P.tradeIx(a.publicKey, m, port, await P.qForUsd(m, 100))], [a]);
  const leg = (await P.readPortfolio(port)).legs[0];
  const nftMint = Keypair.generate();
  const mint = P.nftMintIx(a.publicKey, m, port, leg.marketId, nftMint.publicKey);
  const sigMint = await P.mustSend("nft mint", [mint.ix], [a, nftMint]);
  const pAfterMint = await P.readPortfolio(port);
  check(J, sym, "mint: NFT PDA exists, holder ATA =1, portfolio owner escrowed", !!(await P.conn.getAccountInfo(mint.nftPda)) && (await P.tokenBalance(mint.ownerAta)) === 1n && pAfterMint.owner !== a.publicKey.toBase58(),
    "pda, 1 token, owner≠A", `owner=${pAfterMint.owner}`, [sigMint]);

  // transfer (Token-2022 + transfer hook) A → B
  const bAta = P.getAssociatedTokenAddressSync(nftMint.publicKey, b.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const xfer = await createTransferCheckedWithTransferHookInstruction(P.conn, mint.ownerAta, nftMint.publicKey, bAta, a.publicKey, 1n, 0, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  const r = await P.send([createAssociatedTokenAccountIdempotentInstruction(a.publicKey, bAta, b.publicKey, nftMint.publicKey, TOKEN_2022_PROGRAM_ID), xfer], [a]);
  if (!r.ok) { record({ journey: J, market: sym, step: "transfer NFT A→B (transfer hook)", ok: false, err: `${r.err} ${r.logs.slice(-8).join(" | ")}` }); return; }
  check(J, sym, "transfer: B holds the NFT", (await P.tokenBalance(bAta)) === 1n && (await P.tokenBalance(mint.ownerAta)) === 0n, "B=1 A=0", `B=${await P.tokenBalance(bAta)}`, [r.sig!]);

  // burn by B → B becomes portfolio owner; B closes and withdraws
  const burn = P.nftBurnIx(b.publicKey, m, port, leg.marketId, nftMint.publicKey);
  const rb = await P.send([burn], [b]);
  if (!rb.ok) { record({ journey: J, market: sym, step: "burn by new holder", ok: false, err: `${rb.err} ${rb.logs.slice(-8).join(" | ")}` }); return; }
  const pB = await P.readPortfolio(port);
  check(J, sym, "burn: portfolio owner == B, NFT PDA closed", pB.owner === b.publicKey.toBase58() && !(await P.conn.getAccountInfo(mint.nftPda)), `owner=${b.publicKey.toBase58()}`, `owner=${pB.owner}`, [rb.sig!]);
  const sigClose = await P.mustSend("B close", [await P.tradeIx(b.publicKey, m, port, -pB.legs[0].basisPosQ)], [b]);
  const pC = await P.readPortfolio(port);
  await P.mintUsdc(b.publicKey, 1n); // ensure B's USDC ATA exists
  const wb0 = await P.usdcBalance(b.publicKey);
  const wd = await P.send([await P.withdrawIx(b.publicKey, m, port, pC.capital)], [b]);
  const wb1 = await P.usdcBalance(b.publicKey);
  check(J, sym, "B closes + withdraws the transferred position's capital", pC.legs.length === 0 && wd.ok && wb1 - wb0 === pC.capital, `0 legs, +${pC.capital}`, `legs=${pC.legs.length} +${wb1 - wb0} ${wd.err ?? ""}`, [sigClose, wd.sig ?? ""]);
}
