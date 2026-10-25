import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readSource } from "../helpers/source-scan";

// #2513 — every read against the indexer DB must be scoped to the deployment's
// network. The `trades` and `funding_history` tables both carry a `network`
// column, but no query used it as a predicate, so a devnet deployment could
// serve mainnet rows and vice versa.
//
// Asserted structurally rather than by running SQL: the failure mode is a NEW
// query being added without the filter, and only a source-level invariant
// catches that. A value test over the existing queries would pass forever while
// query #13 silently leaks.
describe("#2513 indexer-db reads are network-scoped", () => {
  const src = readSource(path.join(__dirname, "../../lib/indexer-db.ts"));
  const lines = src.split("\n");

  it("every FROM trades / funding_history is followed by a network predicate", () => {
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/FROM\s+(trades|funding_history)\b/.test(line)) return;
      // the predicate may be on this line (single-line form) or within the
      // next few lines of the same statement
      const window = [line, ...lines.slice(i + 1, i + 5)].join("\n");
      // Tagged-template form, or a positional `$N` param (CANDLE_AGG_SQL, run with sql.unsafe;
      // the binding of that param to getServerNetwork() is asserted below).
      if (!/network\s*=\s*(\$\{getServerNetwork\(\)\}|\$\d+\b)/.test(window)) {
        offenders.push(`line ${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("the positional-param query (CANDLE_AGG_SQL) binds the server network", () => {
    expect(src).toMatch(/AND network = \$2\n/);
    expect(src).toMatch(/sql\.unsafe\(CANDLE_AGG_SQL, \[\s*slabAddress,\s*opts\.network \?\? getServerNetwork\(\),/);
  });

  it("actually found query sites — the scan cannot pass vacuously", () => {
    const sites = lines.filter((l) => /FROM\s+(trades|funding_history)\b/.test(l));
    expect(sites.length).toBeGreaterThanOrEqual(12);
  });

  it("imports the server-side resolver, not the localStorage one", () => {
    expect(src).toMatch(/import \{ getServerNetwork \} from "\.\/supabase"/);
    expect(src).not.toMatch(/from "\.\/config"/);
  });
});
