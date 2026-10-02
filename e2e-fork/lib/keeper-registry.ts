/** seed-state.json (P0a seed) → keeper registry.json. Usage: tsx lib/keeper-registry.ts <seed-state> <out> */
import fs from "node:fs";
const [, , inP, outP] = process.argv;
const s = JSON.parse(fs.readFileSync(inP, "utf8"));
const markets = Object.values(s.markets as Record<string, any>)
  .filter((m) => m.allGreen)
  .map((m) => ({
    label: `${m.symbol} — ${m.dexType}`,
    marketAddress: m.slab,
    poolAddress: m.pool,
    dexType: m.dexType,
    assetIndex: 0,
    symbol: m.shortSym,
    mainnetCa: m.mainnet_ca,
    collateral: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
    lpPortfolio: m.lpPortfolio,
    registeredAt: Date.now(),
  }));
fs.writeFileSync(outP, JSON.stringify({ version: 1, description: "e2e-fork LOCAL registry (generated from P0a seed state)", markets }, null, 2));
console.log(`registry: ${markets.length} markets → ${outP}`);
