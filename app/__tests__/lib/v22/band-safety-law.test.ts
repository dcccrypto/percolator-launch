/**
 * R6 (Khubair, 2 Nov): the Band Safety Law pre-check in the launch path.
 *
 * Program verdicts quoted here were measured on the real wrapper .so in LiteSVM with the app's own InitMarket bytes
 * (bsl6 matrix): x5 = rc23 34996503 (.so md5 ae4fdd9b), x1 = bbaa0e7b (.so md5 f52a302d). Every config the wizard can
 * derive (IMR 1000..5000 x holding fee x price protection, 15,432 InitMarkets) is accepted by both.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { deriveLaunchMarketParams } from "@/lib/market-params";
import { buildV17InitMarketArgs } from "@/lib/create-market-args";
import { defaultGrowthLaunch } from "@/lib/v21/growth-launch";
import { BSL_OCCUPANCY_MULTIPLE_APP, bandSafetyLawIssue, planLaunchV22, toLaunchParams } from "@/lib/v22/launch-plan";
import { encodeInitMarketDataWithV22 } from "@/lib/v22/launch-wire";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { V22_COPY } from "@/lib/v22/copy";

/** sha256 of percolator-sdk PR #442 `src/abi/v22-band-safety-law.ts` (the SDK test pins the same value). */
const BSL_SHA256 = "cf96931c39c1b024b492a881acb3937814ddb908fdc6348529e18d6045c97f09";
const PRICE = 20_000_000n;

function launch(imr: number, protection: boolean, holdingFee: boolean) {
  const derived = deriveLaunchMarketParams({ initialMarginBps: imr, lpCollateral: 1_000_000_000n, initialPriceE6: PRICE });
  const growth = defaultGrowthLaunch({ engineImrBps: derived.initialMarginBps, maintenanceMarginBps: derived.maintenanceMarginBps, maxPriceMoveBpsPerSlot: derived.maxPriceMoveBpsPerSlot, baseFeeBps: 20 });
  const initArgs = buildV17InitMarketArgs({ p3: true, initialPriceE6: PRICE, tradingFeeBps: 20, growth }, derived);
  const plan = planLaunchV22({ tokenPriceE6: PRICE, collateralDecimals: 6, oracleMode: "keeper", growthOn: true, protection, holdingFee, initArgs });
  return { derived, growth, initArgs, plan };
}

describe("R6: Band Safety Law pre-check (launch path)", () => {
  beforeAll(() => __setDevnetV22ForTest(true));
  afterAll(() => __setDevnetV22ForTest(null));

  it("the vendored file is byte-identical to the SDK copy (sha256 pin)", () => {
    const p = path.join(__dirname, "../../../lib/v22/sdk/v22-band-safety-law.ts");
    expect(createHash("sha256").update(readFileSync(p)).digest("hex")).toBe(BSL_SHA256);
    expect(BSL_OCCUPANCY_MULTIPLE_APP).toBe(5n);
  });

  it("every wizard leverage x toggle passes (program: ok on x5 and x1 for all 15,432) and encodes", () => {
    const seen = new Set<number>();
    let n = 0;
    for (let imr = 1000; imr <= 5000; imr++) {
      const { derived, growth, initArgs } = launch(imr, false, false);
      if (seen.has(derived.initialMarginBps)) continue;
      seen.add(derived.initialMarginBps);
      for (const [prot, fee] of [[false, true], [true, false], [true, true]] as const) {
        const { plan } = launch(imr, prot, fee);
        expect(plan.issues, `imr ${imr} prot ${prot} fee ${fee}`).toEqual([]);
        expect(() => encodeInitMarketDataWithV22(initArgs, growth, toLaunchParams(plan))).not.toThrow();
        n++;
      }
    }
    expect(n).toBe(3 * 3858);
  });

  // Program rows (sdk test/fixtures/v22-bsl/parity.json): the 10x margin (MMR 500, price move 4, dt 100, funding 111) with
  // price protection: rent 500 ok on both; rent 1000 -> 106 on x5, ok on x1.
  it("refuses, before encoding, what the program refuses at the 10x margin (rent 1000 + protection -> 106 on rc23)", () => {
    const { initArgs, growth, plan } = launch(1000, true, true);
    const v22 = toLaunchParams(plan)!;
    expect(bandSafetyLawIssue(initArgs, { ...v22, rent: { rentMaxE9PerSlot: 500, rentKinkBps: 5000 } })).toBeNull();
    const bad = { ...v22, rent: { rentMaxE9PerSlot: 1000, rentKinkBps: 5000 } };
    expect(bandSafetyLawIssue(initArgs, bad)).toEqual({ code: "protection-unsafe", message: V22_COPY.wizard.protectionUnsafe });
    expect(() => encodeInitMarketDataWithV22(initArgs, growth, bad)).toThrow(V22_COPY.wizard.protectionUnsafe);
  });

  it("the plan surfaces it as a blocking issue and sends nothing v2.2", () => {
    const { initArgs } = launch(1000, true, true);
    // a margin the wizard cannot produce but a resumed / edited launch could: MMR 400 (program: refused, edge-mm400-band130)
    const thin = { ...initArgs, maintenanceMarginBps: "400" };
    const plan = planLaunchV22({ tokenPriceE6: PRICE, collateralDecimals: 6, oracleMode: "keeper", growthOn: true, protection: true, holdingFee: true, initArgs: thin });
    expect(plan.issues.map((x) => x.code)).toEqual(["protection-unsafe"]);
    expect(toLaunchParams(plan)).toBeUndefined();
  });

  it("no rent block (both toggles off): nothing to check", () => {
    const { initArgs } = launch(1000, false, false);
    expect(bandSafetyLawIssue(initArgs, { lotExp: 0 })).toBeNull();
  });
});
