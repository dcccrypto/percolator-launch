// @vitest-environment node
/**
 * Next P3 FINAL: TradeNoCpi / BatchTradeNoCpi that grow either side on a P3 asset return 77
 * (VaultLpExclusiveCounterparty). The app must never send them: every trade path goes through
 * the matcher (TradeCpi / BatchTradeCpi). This scans every shipped source file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSource, toPosixPath } from "../../helpers/source-scan";
import { P3_ERROR_COPY_BY_NAME } from "@/lib/limits/copy";
import { P3_ERR } from "@/lib/limits/constants";

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const NOCPI = /\b(encodeTradeNoCpi|encodeBatchTradeNoCpi|ACCOUNTS_TRADE_NOCPI|ACCOUNTS_BATCH_TRADE_NOCPI|TradeNoCpi|BatchTradeNoCpi)\b/;

describe("no NoCpi trades anywhere in the app", () => {
  it("no code line (comments excluded) references a NoCpi trade encoder / tag / account list", () => {
    const hits: string[] = [];
    for (const root of ["hooks", "lib", "components", "app"]) {
      for (const f of files(join(process.cwd(), root))) {
        readSource(f).split("\n").forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "").trim();
          if (code.startsWith("*") || code.startsWith("/*")) return;
          if (NOCPI.test(code)) hits.push(`${toPosixPath(f)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
  it("77 has clear copy that names the matcher-only rule", () => {
    expect(P3_ERR.VaultLpExclusiveCounterparty).toBe(77);
    // UX WP-10 (§5.1/§5.3): plain words ("This trade route isn't available on this market.").
    expect(P3_ERROR_COPY_BY_NAME.VaultLpExclusiveCounterparty).toMatch(/trade route isn't available on this market/);
    expect(P3_ERROR_COPY_BY_NAME.VaultLpExclusiveCounterparty).toMatch(/closing a position still works/);
  });
});
