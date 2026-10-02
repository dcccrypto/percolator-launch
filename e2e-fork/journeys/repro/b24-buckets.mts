import { parseLpRedemption, deriveLpRedemption } from "@percolatorct/sdk";
import * as P from "../../lib/perc.ts";
const PB = await import("@percolatorct/sdk") as any;
for (const sym of ["SOL", "PENGU", "Percolator"]) {
  const m = P.markets()[sym]; const d = new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data);
  const fn = Object.keys(PB).find((k) => k.startsWith("parseBackingBucketsV"))!;
  const bb = PB[fn](d) as any;
  console.log(sym, fn, P.j(bb.buckets.map((b: any) => ({ d: b.domain, st: b.statusName, fresh: b.freshUnlienedBackingNum, util: b.utilizationFeeEarnings, keys: Object.keys(b).join("|") }))).slice(0, 900));
}
const m = P.markets()["SOL"]; const [r] = deriveLpRedemption(P.WRAPPER, P.pk(m.lpVaultRegistry), P.pk("7fMv6htVqwFuumNaYePke3hhy11aVe2eGAEKogK9HoQa"));
console.log("redemption", P.j(parseLpRedemption(new Uint8Array((await P.conn.getAccountInfo(r))!.data))));
