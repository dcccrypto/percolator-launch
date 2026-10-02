import { buildVaultLpReleaseSurplusIxP3, decodeAssetVaultLpP3, decodeVaultLpStateP3, deriveVaultLpStateP3, parseBackingBucketsV17 } from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
for (const sym of ["Percolator", "BURNIE"]) {
  const m = P.markets()[sym]; const slab = P.pk(m.slab);
  const d = new Uint8Array((await P.conn.getAccountInfo(slab))!.data);
  const lp = decodeAssetVaultLpP3(d, 0).vaultLpPortfolio ?? P.pk(m.lpPortfolio);
  const [pda] = deriveVaultLpStateP3(P.WRAPPER, slab); const st = decodeVaultLpStateP3(new Uint8Array((await P.conn.getAccountInfo(pda))!.data)) as any;
  const pot = (x: number) => ((parseBackingBucketsV17(d).buckets.find((b: any) => b.domain === x) as any)?.freshUnlienedBackingNum ?? 0n) / 1_000_000_000_000n;
  const C = st.seniorClaimAtoms as bigint; const reg = await P.readLpVault(m) as any;
  const ata = P.getAssociatedTokenAddressSync(P.USDC, P.admin.publicKey, false, P.TOKEN_PROGRAM_ID);
  const mk = (amt: bigint, dom: number) => buildVaultLpReleaseSurplusIxP3({ programId: P.WRAPPER, market: slab, registryDomain: 0, lpPortfolio: lp } as any, P.admin.publicKey, amt, dom, { juniorDestToken: ata, vaultToken: P.pk(m.vaultAta) });
  const full = await P.send([mk(pot(1), 1)], [P.admin], { simulateOnly: true });
  const minus = await P.send([mk(pot(1) - C, 1)], [P.admin], { simulateOnly: true });
  console.log(sym, P.j({ C, sharesOutstanding: reg.totalLpSharesOutstanding, pot0: pot(0), pot1: pot(1), full: full.ok || full.err, minusC: minus.ok || minus.err }));
  if (minus.ok) { const r = await P.send([mk(pot(1) - C, 1)], [P.admin]); console.log("  landed 102 d1 amt-C:", r.ok ? r.sig : r.err); }
}
