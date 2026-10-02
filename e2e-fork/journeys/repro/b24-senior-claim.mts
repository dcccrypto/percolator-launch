import { decodeVaultLpStateP3, deriveVaultLpStateP3 } from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
for (const sym of ["SOL", "PENGU", "Percolator"]) {
  const m = P.markets()[sym]; const [pda] = deriveVaultLpStateP3(P.WRAPPER, P.pk(m.slab));
  const st = decodeVaultLpStateP3(new Uint8Array((await P.conn.getAccountInfo(pda))!.data)) as any;
  const reg = await P.readLpVault(m) as any;
  console.log(sym, P.j({ C: st.seniorClaimAtoms, feeCredited: st.seniorFeeCreditedAtoms, juniorDep: st.juniorDepositedAtoms, shares: reg.totalLpSharesOutstanding }));
}
