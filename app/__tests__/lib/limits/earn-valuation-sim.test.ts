// @vitest-environment node
/**
 * UX WP-5 AC1 (jsdom/node half; the fork half re-runs with the keeper stopped): a stale vault-LP
 * certificate is valued by simulating [PermissionlessCrank(vault LP)] and decoding the returned
 * post-state with the program's own `vault_lp_value_atoms` port — never "Needs refresh". The
 * deposit button stays enabled on a stale valuation (85 is repaired inside the deposit tx).
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { __clearValuationCache, lpValueFromAccounts, simulateVaultLpValue, VALUATION_CACHE_MS } from "@/lib/limits/earn-valuation-sim";
import { earnDepositPause } from "@/lib/limits/earn";
import { readdirSync, readFileSync } from "node:fs";
import { toPosixPath } from "../../helpers/source-scan";
import { join } from "node:path";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { afterLegsShift, blankPortfolio, v22MarketBytes } from "../../helpers/v22-fixtures";


// Flag on: the captured v2.2 (VERSION 19) one-slot market (helpers/v22-fixtures.ts). Flag off: the v2.1 CdN8r7FB bytes this test always used.
const FX = JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/CdN8r7FB.freshness.market.json"), "utf8")) as { dataBase64: string };
const market = () => (isDevnetV22Enabled() ? v22MarketBytes() : new Uint8Array(Buffer.from(FX.dataBase64, "base64")));

/** A vault-LP portfolio image: capital, an open leg, and a certificate at the given epochs. */
function portfolio(o: { certEquity: bigint; epochs: { oracle: bigint; funding: bigint; risk: bigint; assetSet: bigint }; stale?: number; valid?: number; bitmap?: bigint }): Uint8Array {
  const d = new Uint8Array(blankPortfolio());
  const dv = new DataView(d.buffer);
  const put128 = (off: number, v: bigint) => {
    const m = (1n << 128n) + v;
    dv.setBigUint64(off, m & ((1n << 64n) - 1n), true);
    dv.setBigUint64(off + 8, (m >> 64n) & ((1n << 64n) - 1n), true);
  };
  put128(C.PF_CAPITAL, 100_000_000n);
  const bitmap = o.bitmap ?? 1n;
  dv.setBigUint64(C.PF_ACTIVE_BITMAP, bitmap, true);
  const c = C.PF_HEALTH_CERT + afterLegsShift(); // after the legs: moved by +1,040 B on v2.2
  put128(c + C.CERT_EQUITY, o.certEquity);
  dv.setBigUint64(c + C.CERT_ORACLE_EPOCH, o.epochs.oracle, true);
  dv.setBigUint64(c + C.CERT_FUNDING_EPOCH, o.epochs.funding, true);
  dv.setBigUint64(c + C.CERT_RISK_EPOCH, o.epochs.risk, true);
  dv.setBigUint64(c + C.CERT_ASSET_SET_EPOCH, o.epochs.assetSet, true);
  dv.setBigUint64(c + C.CERT_ACTIVE_BITMAP, bitmap, true);
  d[c + C.CERT_VALID] = o.valid ?? 1;
  d[C.PF_STALE_STATE + afterLegsShift()] = o.stale ?? 0;
  return d;
}

describe("lpValueFromAccounts: the program's value from post-crank images", () => {
  const m = market();
  const e = decodeMarketEngineView(m)!;
  const current = { oracle: e.oracleEpoch, funding: e.fundingEpoch, risk: e.riskEpoch, assetSet: e.assetSetEpoch };
  it("a certificate at the market's epochs = certified equity (to the atom)", () => {
    expect(lpValueFromAccounts(portfolio({ certEquity: 123_456_789n, epochs: current }), m)).toEqual({ kind: "certified", atoms: 123_456_789n });
  });
  it("CONTROL: a certificate one oracle epoch behind is stale (the program refuses to value it)", () => {
    expect(lpValueFromAccounts(portfolio({ certEquity: 1n, epochs: { ...current, oracle: current.oracle - 1n } }), m)).toEqual({ kind: "stale" });
  });
});

describe("simulateVaultLpValue", () => {
  const m = market();
  const e = decodeMarketEngineView(m)!;
  const epochs = { oracle: e.oracleEpoch, funding: e.fundingEpoch, risk: e.riskEpoch, assetSet: e.assetSetEpoch };
  const params = () => ({
    programId: Keypair.generate().publicKey,
    market: Keypair.generate().publicKey,
    vaultLp: Keypair.generate().publicKey,
    payer: Keypair.generate().publicKey,
  });

  it("simulates ONE crank ix with the vault LP + market returned, and values the post-state", async () => {
    __clearValuationCache();
    const p = params();
    const simulate = vi.fn(async (ixs: unknown[], addrs: PublicKey[]) => {
      expect(ixs).toHaveLength(1);
      expect(addrs.map((a) => a.toBase58())).toEqual([p.vaultLp.toBase58(), p.market.toBase58()]);
      return { err: null, accounts: [portfolio({ certEquity: 987_654_321n, epochs }), m] };
    });
    const r = await simulateVaultLpValue(p, { simulate, now: () => 1_000 });
    expect(r).toMatchObject({ value: { kind: "certified", atoms: 987_654_321n }, at: 1_000 });
    // the post-crank state is kept for the worse-of pricing (earn-pricing.ts prices THIS state)
    expect(r!.lp?.cert.certifiedEquity).toBe(987_654_321n);
    expect(r!.market?.oracleEpoch).toBe(epochs.oracle);
    expect(r!.market?.priceOf(0)).toEqual({ eff: e.effectivePriceE6, tgt: e.targetPriceE6 });
    // cached for one crank cycle, then re-simulated
    await simulateVaultLpValue(p, { simulate, now: () => 1_000 + VALUATION_CACHE_MS - 1 });
    expect(simulate).toHaveBeenCalledTimes(1);
    await simulateVaultLpValue(p, { simulate, now: () => 1_000 + VALUATION_CACHE_MS + 1 });
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("a failed simulation or a still-stale post-state gives null (the card keeps the last value, 'as of')", async () => {
    __clearValuationCache();
    expect(await simulateVaultLpValue(params(), { simulate: async () => ({ err: { InstructionError: [0, { Custom: 19 }] }, accounts: [] }) })).toBeNull();
    __clearValuationCache();
    const stillStale = portfolio({ certEquity: 5n, epochs: { ...epochs, risk: epochs.risk + 1n } });
    expect(await simulateVaultLpValue(params(), { simulate: async () => ({ err: null, accounts: [stillStale, m] }) })).toBeNull();
    __clearValuationCache();
    expect(await simulateVaultLpValue(params(), { simulate: async () => { throw new Error("429"); } })).toBeNull();
  });
});

describe("the deposit stays enabled on a stale valuation (85 self-repairs in the tx)", () => {
  it("only 'covering a loss' pauses deposits", () => {
    expect(earnDepositPause("senior-impaired")).toBe("senior-impaired");
    expect(earnDepositPause("valuation-stale")).toBeNull();
    expect(earnDepositPause("harvest-pending")).toBeNull();
    expect(earnDepositPause(null)).toBeNull();
  });
});

describe("AC3: the resolved 'not available yet' string is gone", () => {
  it("no source file carries it", () => {
    // Pure node, no shell. This used to be execSync(`grep -rlnE ... || true`): on Windows (cmd.exe,
    // no grep) the command failed and `|| true` turned that into empty stdout, so the guard passed
    // whatever the tree contained -- and a missing grep on any minimal CI image did the same.
    const FORBIDDEN = /settlement for resolved markets is not available yet|resolvedVault/;
    const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|json|css|mdx?)$/;
    const SKIP_DIRS = new Set(["node_modules", ".next"]);
    let scanned = 0;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(full);
        } else if (SOURCE_EXT.test(ent.name)) {
          scanned++;
          if (FORBIDDEN.test(readFileSync(full, "utf8"))) hits.push(toPosixPath(full));
        }
      }
    };
    for (const d of ["app", "components", "lib", "hooks"]) walk(join(process.cwd(), d));
    // The old shape could not tell "nothing found" from "nothing searched"; so assert the scan
    // really covered the tree (about 1000 source files at f13b73b3e).
    expect(scanned).toBeGreaterThan(500);
    expect(hits).toEqual([]);
  });
});
