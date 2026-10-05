// @vitest-environment node
/**
 * OPT-IN, READ-ONLY: the single-transaction launch bundle, exactly as the hook builds it, through
 * simulateTransaction on devnet (sigVerify off), plus the REAL keeper co-sign route's v1 validation
 * against the live slot. Nothing is ever sent: every send/airdrop path throws, the wallet "declines"
 * after the keeper has signed, and the batch the hook then falls back to is stopped before signing.
 *
 * Skipped unless LAUNCH_SINGLE_TX_DEVNET_SIM=1. Inputs:
 *   LAUNCH_SIM_RPC_URL     devnet RPC (default https://api.devnet.solana.com)
 *   LAUNCH_SIM_RPC_ORIGIN  Origin header for an Origin-restricted endpoint (optional)
 *   LAUNCH_SIM_PAYER       a funded devnet pubkey holding SOL + sim-USDC (the fee payer / creator)
 *   LAUNCH_SIM_FEE_SPLIT=1 add a non-default UpdateFeeSplit
 *   LAUNCH_SIM_OUT         write the report line to this file (the test setup silences console.log)
 *
 * Program IDs are whatever the app resolves for devnet today (lib/program-ids.ts). The v2.1 programs
 * are not on devnet yet: this bundle carries no growth trailer / l_launch (params.growth unset), so CU
 * and loaded-account numbers for the v2.1 programs remain unmeasured.
 */
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";

const ON = process.env.LAUNCH_SINGLE_TX_DEVNET_SIM === "1";
const h = vi.hoisted(async () => {
  const { Keypair } = await import("@solana/web3.js");
  const keeper = Keypair.generate();
  process.env.PLAYGROUND_KEEPER_KEYPAIR = JSON.stringify(Array.from(keeper.secretKey));
  if (process.env.LAUNCH_SIM_RPC_URL) process.env.DEVNET_RPC_URL = process.env.LAUNCH_SIM_RPC_URL;
  if (process.env.LAUNCH_SIM_RPC_ORIGIN) process.env.RPC_UPSTREAM_ORIGIN = process.env.LAUNCH_SIM_RPC_ORIGIN;
  return { factory: null as null | ((a: { cosign: import("@/lib/launch-single-tx/deps").KeeperCosignRequestBase }) => import("@/lib/launch-single-tx/run").SingleTxLaunchDeps) };
});

vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  signAllCompat: vi.fn(async () => { throw new Error("live sim: the batch is never signed"); }),
  broadcastSignedTx: vi.fn(async () => { throw new Error("live sim: never broadcasts"); }),
  presimulateOrThrow: vi.fn(async () => undefined),
  prewarmTxLanding: vi.fn(),
}));
vi.mock("@/lib/inFlightMarket", () => ({ saveInFlightMarket: vi.fn(), updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(), loadLastInFlightMarket: vi.fn(() => null) }));
vi.mock("@/lib/launch-single-tx/deps", async (orig) => {
  const s = await h;
  return { ...(await orig<typeof import("@/lib/launch-single-tx/deps")>()), liveSingleTxDeps: (a: { cosign: import("@/lib/launch-single-tx/deps").KeeperCosignRequestBase }) => s.factory!(a) };
});

describe.skipIf(!ON)("single-tx launch: devnet simulation (opt-in, read-only)", () => {
  it("simulates the full bundle and the keeper route accepts it", async () => {
    const s = await h;
    const { attemptFreshBatchedLaunch } = await import("@/hooks/useCreateMarket");
    const { POST } = await import("@/app/api/playground/keeper-cosign/route");
    const { NextRequest } = await import("next/server");
    const { getConfig } = await import("@/lib/config");
    const { requestKeeperV1Signature } = await import("@/lib/launch-single-tx/deps");
    const { decodeV1Message } = await import("@/lib/launch-single-tx/v1-decode");
    const { splitV1Wire } = await import("@/lib/tx-v1");

    const url = process.env.LAUNCH_SIM_RPC_URL ?? "https://api.devnet.solana.com";
    const origin = process.env.LAUNCH_SIM_RPC_ORIGIN;
    const headers: Record<string, string> = origin ? { Origin: origin } : {};
    const real = new Connection(url, { commitment: "confirmed", httpHeaders: headers });
    const forbidden = new Set(["sendTransaction", "sendRawTransaction", "sendEncodedTransaction", "requestAirdrop", "confirmTransaction"]);
    const connection = new Proxy(real, {
      get(t, k, r) {
        if (typeof k === "string" && forbidden.has(k)) return () => { throw new Error(`live sim: ${k} is forbidden`); };
        const v = Reflect.get(t, k, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const payer = new PublicKey(process.env.LAUNCH_SIM_PAYER ?? "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");
    const programId = new PublicKey(getConfig().programId);

    const routeFetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).includes("keeper-cosign")) return POST(new NextRequest("http://localhost/api/playground/keeper-cosign", { method: "POST", headers: { "content-type": "application/json" }, body: String(init?.body) }));
      return new Response("{}", { status: 200 }); // /api/devnet-pre-fund is NOT called for real: the payer must already be funded
    }) as typeof fetch;
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(routeFetch);

    const report: Record<string, unknown> = { rpc: url.replace(/(api-key|key)=[^&]+/gi, "$1=***"), wrapper: programId.toBase58() };
    s.factory = (a) => ({
      simulate: async (wire) => {
        const d = decodeV1Message(splitV1Wire(wire).message);
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [Buffer.from(wire).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true }] });
        const resp = await realFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
        const j = (await resp.json()) as { error?: unknown; result?: { value: { err: unknown; logs: string[] | null; unitsConsumed?: number; loadedAccountsDataSize?: number; innerInstructions?: { index: number; instructions: unknown[] }[] } } };
        if (j.error) throw new Error(`simulate RPC error ${JSON.stringify(j.error)}`);
        const v = j.result!.value;
        const inner = new Map((v.innerInstructions ?? []).map((x) => [x.index, x.instructions.length]));
        const trace = d.instructions.reduce((n, _ix, i) => n + 1 + (inner.get(i) ?? 0), 0);
        Object.assign(report, { err: v.err, unitsConsumed: v.unitsConsumed, loadedAccountsDataSize: v.loadedAccountsDataSize, trace, bytes: wire.length, accounts: d.accountKeys.length, signers: d.numRequiredSignatures, instructions: d.instructions.length, logsTail: v.err ? (v.logs ?? []).slice(-8) : undefined });
        return { err: v.err, logs: v.logs ?? [], unitsConsumed: v.unitsConsumed, loadedAccountsDataSize: v.loadedAccountsDataSize };
      },
      keeperSign: async (m) => {
        const sig = await requestKeeperV1Signature(a.cosign, m, routeFetch);
        report.keeperRoute = "co-signed";
        return sig;
      },
      walletSign: async () => { throw new Error("live sim: the wallet never signs"); },
      send: async () => { throw new Error("live sim: never sends"); },
      status: async () => ({ kind: "not-found" }),
      blockHeight: async () => Number.MAX_SAFE_INTEGER,
      slabExists: async () => false,
      sleep: async () => undefined,
      now: () => Date.now(),
    });

    const pool = Keypair.generate().publicKey;
    const lp = 1_000_000_000n;
    const outcome = await attemptFreshBatchedLaunch({
      connection: connection as unknown as Connection,
      wallet: { publicKey: payer, signTransaction: async (t: Transaction) => t, signAllTransactions: async (t: Transaction[]) => t },
      programId,
      slabKp: Keypair.generate(),
      params: {
        mint: new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC"),
        initialPriceE6: 1_000_000n, lpCollateral: lp, insuranceAmount: 100_000_000n, oracleFeed: "0".repeat(64), invert: false,
        tradingFeeBps: 30, initialMarginBps: 2_000, decimals: 6, symbol: "SIM", name: "Sim", oracleMode: "keeper",
        dexPoolAddress: pool.toBase58(), dexType: "raydium-clmm", mainnetCA: pool.toBase58(),
        p3: { juniorFloorBps: 2_000, juniorAtoms: lp },
        ...(process.env.LAUNCH_SIM_FEE_SPLIT === "1" ? { feeSplit: { creatorShareBps: 2_000, lpShareBps: 4_400, insuranceShareBps: 1_600 } } : {}),
      },
      isDevnetEnv: true, isKeeperOracle: true, isAdminOracle: false, isHyperpOracle: false, oracleMode: "keeper",
      setState: () => undefined,
      singleTx: { rawSigner: { source: "wallet-adapter", name: "sim", versions: new Set([1]), supportsV1: true, signRaw: async () => { throw new Error("unused"); } } },
    });
    report.outcome = outcome.status;
    const line = `SINGLE_TX_DEVNET_SIM ${JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
    console.log(line);
    if (process.env.LAUNCH_SIM_OUT) (await import("node:fs")).writeFileSync(process.env.LAUNCH_SIM_OUT, line);
    expect(report.err).toBeNull();
    expect(report.keeperRoute).toBe("co-signed");
  }, 120_000);
});
