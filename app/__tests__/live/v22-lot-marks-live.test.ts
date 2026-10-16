// @vitest-environment node
/**
 * LIVE (skipped unless LIVE_RPC): v2.2 QA L-1 keeper-mark-scaling evidence. For every keeper-priced market of the
 * preview list (LIVE_MARKETS_JSON: [{symbol, slab, ca}]), read the per-LOT mark on chain and the lot exponent with the
 * app's own reader, take the token's USD price from Jupiter, and check mark == price x 10^lot_exp (within LIVE_TOL,
 * default 3%: DEX pool vs aggregator, and the keeper's ~3 s cadence). Writes one line per market to LIVE_LOG.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { lotExpOf, lotPriceToTokenE6 } from "@/lib/v22/lot";

const RPC = process.env.LIVE_RPC ?? "";
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", m + "\n");

describe.skipIf(!RPC)("LIVE L-1: keeper pushes price x 10^lot_exp", () => {
  it("every keeper-priced market", async () => {
    __setDevnetV22ForTest(true);
    const conn = new Connection(RPC, "confirmed");
    const slot = await conn.getSlot();
    const markets = JSON.parse(fs.readFileSync(process.env.LIVE_MARKETS_JSON ?? "", "utf8")) as { symbol: string; slab: string; ca: string }[];
    const ids = [...new Set(markets.map((m) => m.ca))].join(",");
    const px = (await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`)).json()) as Record<string, { usdPrice: number }>;
    const tol = Number(process.env.LIVE_TOL ?? "0.03");
    let checked = 0;
    for (const m of markets) {
      const a = await conn.getAccountInfo(new PublicKey(m.slab), "confirmed");
      const raw = new Uint8Array(a!.data);
      const cfg = parseWrapperConfigV17(raw, V17_HEADER_LEN);
      const k = lotExpOf(raw);
      const mark = BigInt(cfg.markEwmaE6);
      const pushAge = slot - Number(cfg.lastGoodOracleSlot ?? 0n);
      const usd = px[m.ca]?.usdPrice;
      const expected = usd === undefined ? null : usd * 10 ** k * 1e6;
      const ratio = expected ? Number(mark) / expected : NaN;
      const live = pushAge < 150; // pushed within ~1 min: keeper-priced now
      LOG(`${m.symbol} slab=${m.slab} lot_exp=${k} markE6(per lot)=${mark} perTokenE6=${lotPriceToTokenE6(mark, k)} jupUsd=${usd} expectedPerLotE6=${expected?.toFixed(0)} ratio=${ratio.toFixed(4)} pushAgeSlots=${pushAge} ${live ? "LIVE" : "not-pushed (skipped)"}`);
      if (!live || expected === null) continue;
      expect(Math.abs(ratio - 1), `${m.symbol}`).toBeLessThan(tol);
      // Control: an UNSCALED mark (price per token pushed as-is) would be off by 10^k on every lot market.
      if (k > 0) expect(Math.abs(Number(mark) / (usd! * 1e6) - 1), `${m.symbol} unscaled control`).toBeGreaterThan(0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
