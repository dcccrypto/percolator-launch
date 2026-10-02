/**
 * Chain-level journeys (throwaway wallets, LOCAL validator). ONLY=C1,F1 to filter.
 * Results → .run/results.json (every step with expected/actual + sigs).
 */
import { traderJourney } from "./chain/trader.ts";
import { earnJourney, stakeJourney, creatorFeeJourney, nftJourney } from "./chain/products.ts";
import { lapsedBucket, resetPendingSide, keeperOutage, bankruptLiquidation, freezeAndPermissionlessResolve, freezeThenOwnerExits, unsignedLpCloseUnblocksWinner, deadOracleResolve, stakeTerminalRecovery } from "./chain/forced.ts";
import { journey } from "../lib/results.ts";

const ONLY = new Set((process.env.ONLY ?? "").split(",").filter(Boolean));
const want = (id: string) => ONLY.size === 0 || ONLY.has(id);
const plan: [string, string, () => Promise<unknown>][] = [
  ["C1", "SOL:long", () => traderJourney("SOL", "long")],
  ["C1", "SOL:short", () => traderJourney("SOL", "short")],
  ["C1", "BURNIE:long", () => traderJourney("BURNIE", "long")],
  ["C1", "JUP:short", () => traderJourney("JUP", "short")],
  ["C1", "PENGU:short", () => traderJourney("PENGU", "short")],
  ["C2", "PENGU", () => earnJourney("PENGU")],
  ["C3", "TRUMP", () => stakeJourney("TRUMP")],
  ["C4", "JUP", () => creatorFeeJourney("JUP")],
  ["C5", "SOL", () => nftJourney("SOL")],
  ["F1", "JUP:d1", () => lapsedBucket("JUP", 1)],
  ["F1", "PENGU:d0", () => lapsedBucket("PENGU", 0)],
  ["F2", "BURNIE", () => resetPendingSide("BURNIE")],
  ["F6", "SOL,JUP", () => keeperOutage(["SOL", "JUP"])],
  ["F5", "SOL", () => bankruptLiquidation("SOL")],
  ["F3b", "PENGU", () => freezeThenOwnerExits("PENGU")],
  ["F3b2", "JUP", () => freezeThenOwnerExits("JUP", 34, "shorts-first")],
  ["F3b3", "Percolator", () => freezeThenOwnerExits("Percolator", 34, "longs-first", true)],
  ["F3", "TRUMP", () => freezeAndPermissionlessResolve("TRUMP")],
  ["F3r2", "SOL", () => freezeAndPermissionlessResolve("SOL")],
  ["F3c", "TRUMP", () => unsignedLpCloseUnblocksWinner("TRUMP")],
  ["F7", "JUP", () => deadOracleResolve("JUP")],
  ["F8", "PENGU", () => stakeTerminalRecovery("PENGU")], // LAST: resolves the market
];
let failed = 0;
for (const [id, label, fn] of plan) {
  if (!want(id)) continue;
  console.log(`\n=== ${id} ${label} ===`);
  if (!(await journey(id, label, async () => { await fn(); }))) failed++;
}
const { default: fs } = await import("node:fs");
const { RUN } = await import("../lib/perc.ts");
const steps = JSON.parse(fs.readFileSync(`${RUN}/results.json`, "utf8"));
const bad = steps.filter((s: { ok: boolean }) => !s.ok);
console.log(`\nchain journeys: ${steps.length} steps, ${bad.length} failed, ${failed} journeys aborted`);
process.exit(bad.length ? 1 : 0);
