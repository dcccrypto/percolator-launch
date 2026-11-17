import { bench, describe } from "vitest";
import { preTradeQuote, quoteFailsLimit, skewIndicatorBps } from "@/lib/limits/matcher-quote";
import { genCases } from "./matcher-quote-inputs";

// 10k realistic size/price/inventory inputs (non-edgy: no zero oracle / zero size).
const cases = genCases(10_000, 0xc0ffee, false);

describe("matcher-quote", () => {
  bench("preTradeQuote x10k", () => {
    let acc = 0n;
    for (const c of cases) {
      const q = preTradeQuote(c.ctx, c.oracleE6, c.sizeQ, c.takerBuys, c.opts);
      if (q && !quoteFailsLimit(q.quotePriceE6, c.limitE6, c.takerBuys)) acc += q.fillQ;
      acc += BigInt(skewIndicatorBps(c.ctx.inventoryBase, c.invRef));
    }
    return acc as unknown as void;
  });
});
