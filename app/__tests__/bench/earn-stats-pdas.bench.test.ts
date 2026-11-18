// @vitest-environment node
/**
 * Timed bench (not a gate): fetchCuratedVaultsOnChain with N=100 slabs and a mocked chunked RPC,
 * 50 iterations per run, median of 5 runs, plus the count of PublicKey.findProgramAddressSync calls.
 * Run: BENCH=1 npx vitest run __tests__/bench/earn-stats-pdas.bench.test.ts --reporter=verbose
 * Output line: BENCH earn-stats-pdas median_ms=… fpas_calls=…
 */
import { writeFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chunked: vi.fn() }));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ programId: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB" }),
  getRpcEndpoint: () => "http://localhost:8899",
}));
vi.mock("@/lib/program-upgrade-detect", () => ({
  programUpgradeState: async () => "post",
  earnNavFloorLive: async () => true,
}));
vi.mock("@/lib/rpc-chunk", () => ({ getMultipleAccountsInfoChunked: mocks.chunked }));
vi.mock("@/lib/v22/records", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/records")>()),
  parseLpVaultRegistry: () => ({
    totalLpSharesOutstanding: 2_000_000_000n,
    feeDistributionTotalAtoms: 350_000n,
    redemptionCooldownSlots: 150n,
    domain: 0,
  }),
}));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/decode")>()),
  decodeLpVaultRegistryBound: () => false,
}));
vi.mock("@/lib/limits/earn-split-pot", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/earn-split-pot")>()),
  splitPotStateFromAccounts: () => null,
}));

import { fetchCuratedVaultsOnChain } from "@/hooks/useEarnStats";

const N = 100;
const ITERS = 50;
const RUNS = 5;
const SLABS = Array.from({ length: N }, () => Keypair.generate().publicKey.toBase58());
const acct = { data: new Uint8Array(8), owner: PublicKey.default, lamports: 1, executable: false, rentEpoch: 0 };

describe("earn-stats PDA derivation bench", () => {
  // Opt-in (BENCH=1): keeps ~25 s out of the default suite.
  it.skipIf(!process.env.BENCH)("N=100, 50 iterations, median of 5", async () => {
    // First RPC call = registries (one account per slab); second = market+2 ledgers per vault.
    mocks.chunked.mockImplementation(async (_c: unknown, keys: unknown[]) => keys.map(() => acct));
    const spy = vi.spyOn(PublicKey, "findProgramAddressSync");
    const times: number[] = [];
    let calls = 0;
    for (let r = 0; r < RUNS; r++) {
      spy.mockClear();
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) await fetchCuratedVaultsOnChain(SLABS);
      times.push(performance.now() - t0);
      calls = spy.mock.calls.length;
    }
    times.sort((a, b) => a - b);
    const line = `BENCH earn-stats-pdas median_ms=${times[2].toFixed(1)} fpas_calls_per_run=${calls}`;
    console.log(line);
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, line + "\n");
    expect(times).toHaveLength(RUNS);
  }, 120_000);
});
