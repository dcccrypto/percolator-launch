import fs from "node:fs";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { buildIx, encodeExecuteRedemption, deriveLpRedemption, deriveLpEscrow, deriveVaultAuthority, deriveLpBackingLedger } from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
const m = P.markets()["SOL"]; const W = P.WRAPPER, mk = P.pk(m.slab), registry = P.pk(m.lpVaultRegistry), lpMint = P.pk(m.lpVaultMint);
const reg = await P.readLpVault(m);
const lines = fs.readFileSync(P.RUN + "/wallets.jsonl", "utf8").trim().split("\n").slice(-400);
for (const l of lines.reverse()) {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(l).sk));
  const [redemption] = deriveLpRedemption(W, registry, kp.publicKey);
  if (!(await P.conn.getAccountInfo(redemption))) continue;
  const [escrow] = deriveLpEscrow(W, mk); const [vaultAuth] = deriveVaultAuthority(W, mk);
  const [ledger] = deriveLpBackingLedger(W, mk, reg.domain); const [sib] = deriveLpBackingLedger(W, mk, reg.domain ^ 1);
  const dest = P.getAssociatedTokenAddressSync(P.USDC, kp.publicKey, false, P.TOKEN_PROGRAM_ID);
  const ex = buildIx({ programId: W, keys: [
    { pubkey: kp.publicKey, isSigner: true, isWritable: true }, { pubkey: mk, isSigner: false, isWritable: true },
    { pubkey: registry, isSigner: false, isWritable: true }, { pubkey: redemption, isSigner: false, isWritable: true },
    { pubkey: lpMint, isSigner: false, isWritable: true }, { pubkey: escrow, isSigner: false, isWritable: true },
    { pubkey: P.pk(m.vaultAta), isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false },
    { pubkey: ledger, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: P.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: sib, isSigner: false, isWritable: true },
    { pubkey: kp.publicKey, isSigner: false, isWritable: true }], data: encodeExecuteRedemption({ domain: reg.domain }) });
  const exT = await P.withP3TailIfBound(ex, m);
  const a = await P.send([exT], [kp], { simulateOnly: true });
  const b = await P.send([P.crankIx(kp.publicKey, m), exT], [kp], { simulateOnly: true });
  const st = await P.readMarket(m);
  console.log(kp.publicKey.toBase58(), "77 alone:", a.ok ? "OK" : a.err, "| crank+77:", b.ok ? "OK" : b.err, "lastGood", st.lastGoodOracleSlot, "chain", st.chainSlot);
  if (!a.ok) console.log(a.logs.join("\n"));
}
