/**
 * App overlay (harness-only, never committed to the app branch): regenerate
 * app/lib/playground-slab-meta.ts from the P0a seed state so the curated-only
 * /api/markets filter shows the fork's freshly seeded slabs. This is exactly the
 * cutover edit fresh-id-redeploy-plan §1.2 lists ("playground-slab-meta.ts:8-71: the
 * 6 slab records, repointed to the new slabs"), which no app branch has made yet.
 * Usage: tsx lib/app-overlay.ts <seed-state.json> <appDir>
 */
import fs from "node:fs";
import path from "node:path";
const [, , seedP, appDir] = process.argv;
const s = JSON.parse(fs.readFileSync(seedP, "utf8"));
const target = path.join(appDir, "lib", "playground-slab-meta.ts");
const orig = fs.readFileSync(target, "utf8");
const header = orig.slice(0, orig.indexOf("> = {") + "> = {".length);
const rows = Object.values(s.markets as Record<string, any>)
  .filter((m) => m.allGreen)
  .map((m) => {
    const sym = String(m.shortSym);
    return `  // ${m.symbol} — ${m.dexType} — e2e-fork seed ${m.provenAt ?? ""}
  ${JSON.stringify(m.slab)}: {
    symbol: ${JSON.stringify(`${sym}-PERP`)},
    name: ${JSON.stringify(`${m.symbol} Perpetual`)},
    mainnet_ca: ${JSON.stringify(m.mainnet_ca)},
    dex_pool_address: ${JSON.stringify(m.pool)},
    lp_portfolio_address: ${JSON.stringify(m.lpPortfolio)},
  },`;
  });
const rest = orig.slice(orig.indexOf("\n};", orig.indexOf("> = {")));
fs.writeFileSync(target, `${header}\n  // E2E-FORK OVERLAY (generated) — do not commit\n${rows.join("\n")}${rest}`);
console.log(`overlay: ${rows.length} slab records → ${target}`);
