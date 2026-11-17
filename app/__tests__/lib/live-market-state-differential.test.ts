// @vitest-environment node
/**
 * parseLiveState must return byte-for-byte what it returned before the stake-pool PDA memo
 * (lib/market-completeness.ts). The golden values below were produced by the PRE-change code:
 *  - the three fixtures are compared object-for-object;
 *  - 2,000 seeded fuzzed slabs (flipped bytes, truncation, other slab keys) are reduced to one sha256
 *    of their outcomes (returned object or thrown message).
 * Also checks the memo against a direct deriveStakePool for every fuzzed key.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { parseLiveState } from "@/lib/live-market-state";
import { isMarketauthComplete } from "@/lib/market-completeness";
import { getConfig } from "@/lib/config";
import { liveMarketFixtures } from "../helpers/live-market-slabs";

__setDevnetV22ForTest(true);

const GOLDEN_FIXTURES: Record<string, unknown> = {
  "single-asset": {
    "markPriceUsd": 107.147025,
    "oiLongQ": 1370584,
    "oiShortQ": 1370584,
    "totalOiQ": 2741168,
    "totalOiUsd": 293.7079962252,
    "insurance": 56942509,
    "vault": 2536591916,
    "cTot": 1752856673,
    "isComplete": false,
    "maxLeverage": 10
  },
  "multi-asset": {
    "markPriceUsd": 107.23276,
    "oiLongQ": 0,
    "oiShortQ": 0,
    "totalOiQ": 0,
    "totalOiUsd": 0,
    "insurance": 16751668,
    "vault": 2019037967,
    "cTot": 1998998643,
    "isComplete": false,
    "maxLeverage": 10
  },
  "chillhouse": {
    "markPriceUsd": 0.0010954732,
    "oiLongQ": 0,
    "oiShortQ": 0,
    "totalOiQ": 0,
    "totalOiUsd": 0,
    "insurance": 1872000,
    "vault": 2000000000,
    "cTot": 1496397788,
    "isComplete": false,
    "maxLeverage": 20
  }
};
const GOLDEN_FUZZ_SHA = "2ad784a4e8eab95d3645f686e4290e529de86780092fe0a32c07ff7aebc4b5b0";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function outcome(data: Uint8Array, key: PublicKey): unknown {
  try {
    return parseLiveState(data, key);
  } catch (e) {
    return { threw: (e as Error).message };
  }
}

const norm = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? `n:${String(x)}` : typeof x === "bigint" ? `b:${x}` : x));

function fuzzOutcomes(): string[] {
  const fx = liveMarketFixtures();
  const r = rng(0xc0ffee);
  const keys = fx.map((f) => f.key);
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const base = fx[Math.floor(r() * fx.length)];
    let data = base.data.slice();
    const mode = r();
    if (mode < 0.2) data = data.slice(0, Math.floor(r() * data.length));
    else if (mode < 0.4) data = data.slice(0, 700 + Math.floor(r() * 400)); // cut inside the config / group region
    const flips = Math.floor(r() * 6);
    for (let j = 0; j < flips; j++) {
      const lo = r() < 0.6 ? 0 : 560; // header/config region vs anywhere
      const span = r() < 0.6 ? Math.min(900, data.length) : data.length;
      if (data.length) data[Math.min(data.length - 1, lo + Math.floor(r() * (span - lo > 0 ? span - lo : 1)))] = Math.floor(r() * 256);
    }
    const key = r() < 0.7 ? keys[Math.floor(r() * keys.length)] : PublicKey.unique();
    out.push(norm(outcome(data, key)));
  }
  return out;
}

describe("parseLiveState differential (pre-memo goldens)", () => {
  it("fixtures deep-equal the pre-change objects", () => {
    for (const f of liveMarketFixtures()) {
      const got = JSON.parse(norm(outcome(f.data, f.key)));
      if (process.env.GEN_GOLDEN) require("node:fs").appendFileSync("/tmp/lms-golden.txt", `FIX ${f.name} ${norm(got)}\n`);
      else expect(got).toEqual(GOLDEN_FIXTURES[f.name]);
    }
  });

  it("2,000 fuzzed slabs throw or return exactly what they did before", () => {
    const sha = createHash("sha256").update(fuzzOutcomes().join("\n")).digest("hex");
    if (process.env.GEN_GOLDEN) require("node:fs").appendFileSync("/tmp/lms-golden.txt", `FUZZ ${sha}\n`);
    else expect(sha).toBe(GOLDEN_FUZZ_SHA);
  });

  it("memoised isMarketauthComplete equals a direct derivation, hit or miss", () => {
    const stake = new PublicKey(getConfig().vaultProgramId as string);
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const slab = PublicKey.unique();
      const [pda] = deriveStakePool(slab, stake);
      const other = PublicKey.unique();
      for (let rep = 0; rep < 2; rep++) {
        expect(isMarketauthComplete(pda, slab)).toBe(true);
        expect(isMarketauthComplete(other, slab)).toBe(false);
      }
      void r;
    }
  });
});
