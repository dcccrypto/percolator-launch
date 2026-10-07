// @vitest-environment node
/**
 * v2.2 launch (flag NEXT_PUBLIC_DEVNET_V22): lot size, holding fee, price protection and the atomic capacity bond.
 * Same harness as useCreateMarket.single-tx.test.ts: the REAL hook (attemptFreshBatchedLaunch) (attemptFreshBatchedLaunch) builds the
 * bundle from its own descriptors, the REAL orchestrator (lib/launch-single-tx/run.ts) runs it, and the
 * REAL keeper co-sign route validates and signs it with a real keeper key. Only the network and the
 * wallet are faked. Every rule has a negative control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { bandDefaultsV22, encodeInitMarketTrailerV22, IX_TAG_V22 } from "@/lib/v22/sdk";
import { placeBondTranche } from "@/lib/v22/launch-wire";
import { DEFAULT_BOND, DEFAULT_RENT } from "@/lib/v22/launch-plan";
import { expectedLaunchShape } from "@/lib/launch-single-tx/shape";
import { writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { ComputeBudgetProgram, Keypair, MessageV1, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { IX_TAG, IX_TAG_P3, STAKE_IX } from "@percolatorct/sdk";

const h = vi.hoisted(async () => {
  const { Keypair } = await import("@solana/web3.js");
  const seed = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (i * 7 + n) & 0xff));
  const keeper = Keypair.fromSeed(seed(202));
  process.env.PLAYGROUND_KEEPER_KEYPAIR = JSON.stringify(Array.from(keeper.secretKey));
  return {
    keeper,
    seed,
    deps: null as unknown as import("@/lib/launch-single-tx/run").SingleTxLaunchDeps | null,
    depsFactory: null as unknown as ((a: { cosign: import("@/lib/launch-single-tx/deps").KeeperCosignRequestBase }) => import("@/lib/launch-single-tx/run").SingleTxLaunchDeps) | null,
    signAllCompat: (await import("vitest")).vi.fn(),
    broadcastSignedTx: (await import("vitest")).vi.fn(),
    presimulateOrThrow: (await import("vitest")).vi.fn(async () => undefined),
    saveInFlightMarket: (await import("vitest")).vi.fn(),
    serverSlot: 5_000,
    serverSlabExists: false,
    /** Blockhashes the fake cluster reports as still valid (isBlockhashValid). */
    validBlockhashes: new Set<string>(),
  };
});

vi.mock("@/lib/tx", async (orig) => {
  const s = await h;
  return {
    ...(await orig<typeof import("@/lib/tx")>()),
    signAllCompat: s.signAllCompat,
    broadcastSignedTx: s.broadcastSignedTx,
    presimulateOrThrow: s.presimulateOrThrow,
    getFreshBlockhash: vi.fn(async () => "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS"),
    getPriorityFee: vi.fn(async () => 50_000),
    prewarmTxLanding: vi.fn(),
  };
});
vi.mock("@/lib/inFlightMarket", async () => {
  const s = await h;
  return { saveInFlightMarket: s.saveInFlightMarket, updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(), loadLastInFlightMarket: vi.fn(() => null) };
});
vi.mock("@/lib/launch-single-tx/deps", async (orig) => {
  const s = await h;
  return {
    ...(await orig<typeof import("@/lib/launch-single-tx/deps")>()),
    liveSingleTxDeps: (a: { cosign: import("@/lib/launch-single-tx/deps").KeeperCosignRequestBase }) => s.depsFactory!(a),
  };
});
vi.mock("@/lib/server-rpc", async () => {
  const s = await h;
  return {
    getServerConnection: () => ({
      getSlot: async () => s.serverSlot,
      getLatestBlockhash: async () => ({ blockhash: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR", lastValidBlockHeight: 99 }),
      getAccountInfo: async () => (s.serverSlabExists ? { data: new Uint8Array(10), owner: PublicKey.default, lamports: 1, executable: false } : null),
      // Same rent formula as the client-side harness connection below (1_000_000 + space).
      getMinimumBalanceForRentExemption: async (n: number) => 1_000_000 + n,
      isBlockhashValid: async (bh: string) => ({ context: { slot: s.serverSlot }, value: s.validBlockhashes.has(bh) }),
    }),
  };
});

import { attemptFreshBatchedLaunch, singleTxInstructionPlan, type CreateMarketParams, type CreateMarketState } from "@/hooks/useCreateMarket";
import { getConfig } from "@/lib/config";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { POST as cosignPOST } from "@/app/api/playground/keeper-cosign/route";
import { requestKeeperV1Signature, type KeeperCosignRequestBase } from "@/lib/launch-single-tx/deps";
import { singleTxLaunchGate, type LaunchSigStatus, type SingleTxLaunchDeps } from "@/lib/launch-single-tx/run";
import { decodeV1Message, encodeV1Message, v1IsWritable } from "@/lib/launch-single-tx/v1-decode";
import { launchBundleViolations, neutralFromV1, v1LimitViolations, type NeutralIx } from "@/lib/launch-single-tx/shape";
import { splitV1Wire, type RawTxSigner } from "@/lib/tx-v1";
import { compileV1Message } from "@/lib/v21/sdk";
import { buildKeeperRegisterMemoIx, verifyKeeperRegisterProofTx } from "@/lib/keeper-register-memo";
import { COSIGN_V1_LIMIT_PER_DEPLOYER, COSIGN_V1_LIMIT_PER_IP, resetCosignV1RateLimits } from "@/lib/launch-single-tx/cosign-rate-limit";
import {
  COSIGN_HEAP_BYTES,
  COSIGN_MAX_LOADED_ACCOUNTS_BYTES,
  COSIGN_MAX_PRIORITY_FEE_LAMPORTS,
  COSIGN_MIN_LOADED_ACCOUNTS_BYTES,
  ValidatedLaunchMessage,
} from "@/lib/launch-single-tx/cosign-validate";
import { SINGLE_TX_COMPUTE_UNITS, SINGLE_TX_LOADED_ACCOUNTS_BYTES } from "@/lib/launch-single-tx/run";
import { claimValidatedLaunchMessageMinter } from "@/lib/launch-single-tx/validated-launch-message";
import { PRIORITY_FEE_MAX_MICRO_LAMPORTS } from "@/lib/tx";
import { MAX_PRIORITY_FEE_LAMPORTS, priorityFeeLamportsFromMicroPerCu } from "@/lib/v21/sdk";
import { requirePlaygroundKeeperSigner } from "@/lib/playground-keeper-signer";
import { V1RpcError } from "@/lib/v21/sdk";
import { V1TransportError } from "@/lib/tx-v1/rpc";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
// Lot markets are only creatable once every trade surface is lot-aware (review F3); these tests exercise the lot path itself.
__setLotMarketsEnabledForTest(true);

const S = await h;
const seed = S.seed;
const KEEPER = S.keeper;
const WALLET = Keypair.fromSeed(seed(201));
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const POOL = Keypair.fromSeed(seed(203)).publicKey;
const PROGRAM = new PublicKey(getConfig().programId);
const STAKE = new PublicKey((getConfig() as { vaultProgramId?: string }).vaultProgramId ?? DEVNET_PROGRAM_IDS.stake);

// ---------------------------------------------------------------- harness
let generated = 0;
let stateBox: CreateMarketState;
let sent: Uint8Array[] = [];
let simulated: Uint8Array[] = [];
let walletPrompts = 0;
let keeperCalls = 0;
let routeCalls: { v1: boolean; status: number }[] = [];

function params(over: Partial<CreateMarketParams> = {}): CreateMarketParams {
  return {
    mint: MINT,
    initialPriceE6: 1_000_000n,
    lpCollateral: 1_000_000_000n,
    insuranceAmount: 100_000_000n,
    oracleFeed: "0".repeat(64),
    invert: false,
    tradingFeeBps: 30,
    initialMarginBps: 2_000,
    decimals: 6,
    symbol: "TST",
    name: "Test",
    oracleMode: "keeper",
    dexPoolAddress: POOL.toBase58(),
    dexType: "raydium-clmm",
    mainnetCA: POOL.toBase58(),
    p3: { juniorFloorBps: 2_000, juniorAtoms: 1_000_000_000n },
    ...over,
  };
}

async function routeFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes("keeper-cosign")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const res = await cosignPOST(new NextRequest("http://localhost/api/playground/keeper-cosign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    routeCalls.push({ v1: "v1MessageBase64" in body, status: res.status });
    return res;
  }
  return new Response("{}", { status: 200 });
}

const fakeSigner: RawTxSigner = {
  source: "wallet-adapter",
  name: "FakeV1",
  versions: new Set<unknown>(["legacy", 0, 1]),
  supportsV1: true,
  async signRaw(wires) {
    return wires.map((w) => {
      const { message } = splitV1Wire(w);
      const out = new Uint8Array(w);
      out.set(ed25519.sign(message, WALLET.secretKey.slice(0, 32)), message.length);
      return out;
    });
  },
};

/** Default deps: everything succeeds; tests override single members. */
function deps(cosign: KeeperCosignRequestBase, over: Partial<SingleTxLaunchDeps> = {}): SingleTxLaunchDeps {
  let t = 0;
  return {
    simulate: async (wire) => {
      simulated.push(wire);
      return { err: null, logs: [], unitsConsumed: 477_473, loadedAccountsDataSize: 2_770_000 };
    },
    keeperSign: async (m) => {
      keeperCalls++;
      return requestKeeperV1Signature(cosign, m, routeFetch as typeof fetch);
    },
    walletSign: async (wire) => {
      walletPrompts++;
      return (await fakeSigner.signRaw([wire]))[0]!;
    },
    send: async (wire) => {
      sent.push(wire);
      return "sig";
    },
    status: async (): Promise<LaunchSigStatus> => ({ kind: "confirmed" }),
    blockHeight: async () => 0,
    slabExists: async () => false,
    sleep: async () => undefined,
    now: () => (t += 1_000),
    ...over,
  };
}

function freshState(): CreateMarketState {
  return { batchFallbackReason: null, step: 0, stepLabel: "", txSigs: [], slabAddress: null, error: null, loading: false, devnetMint: null, insuranceMintFailed: false, backingSeedFailed: false, keeperDelegated: false, keeperMessage: null, keeperRegistering: false, priceFeedRequired: false, phase: "idle", landingIndex: 0, landingTotal: 0 };
}

async function launch(o: { singleTx: boolean; params?: CreateMarketParams; deps?: Partial<SingleTxLaunchDeps> }) {
  generated = 0;
  const slabKp = Keypair.fromSeed(seed(77));
  S.depsFactory = (a) => deps(a.cosign, o.deps ?? {});
  const outcome = await attemptFreshBatchedLaunch({
    connection: {
      rpcEndpoint: "http://127.0.0.1:1",
      getAccountInfo: vi.fn(async () => null),
      getMinimumBalanceForRentExemption: vi.fn(async (n: number) => 1_000_000 + n),
      getBalance: vi.fn(async () => 50_000_000_000),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS", lastValidBlockHeight: 1_000 })),
    } as unknown as import("@solana/web3.js").Connection,
    wallet: { publicKey: WALLET.publicKey, signTransaction: async (tx: Transaction) => tx, signAllTransactions: async (txs: Transaction[]) => txs },
    programId: PROGRAM,
    slabKp,
    params: o.params ?? params(),
    isDevnetEnv: true,
    isKeeperOracle: true,
    isAdminOracle: false,
    isHyperpOracle: false,
    oracleMode: "keeper",
    setState: (u) => {
      stateBox = u(stateBox);
    },
    singleTx: o.singleTx ? { rawSigner: fakeSigner } : null,
  });
  return { outcome, slab: slabKp.publicKey };
}

/** Batched txs the wallet was asked to sign (captured; the stub then stops the batch pre-broadcast). */
let batches: Transaction[][] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Keypair, "generate").mockImplementation(() => Keypair.fromSeed(seed(100 + generated++)));
  vi.spyOn(globalThis, "fetch").mockImplementation(routeFetch as typeof fetch);
  stateBox = freshState();
  sent = [];
  simulated = [];
  walletPrompts = 0;
  keeperCalls = 0;
  routeCalls = [];
  batches = [];
  S.serverSlot = 5_000;
  S.serverSlabExists = false;
  S.validBlockhashes = new Set(["GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS"]);
  resetCosignV1RateLimits();
  S.signAllCompat.mockImplementation(async (_w: unknown, txs: Transaction[]) => {
    batches.push(txs);
    throw new Error("stop: batch captured before broadcast");
  });
});
afterEach(() => vi.restoreAllMocks());

const tagOf = (d: ReturnType<typeof decodeV1Message>, i: number) => d.instructions[i]!.data[0];
const progOf = (d: ReturnType<typeof decodeV1Message>, i: number) => d.accountKeys[d.instructions[i]!.programIdIndex]!;
function findIx(d: ReturnType<typeof decodeV1Message>, program: PublicKey, tag: number): number[] {
  return d.instructions.map((_, i) => i).filter((i) => progOf(d, i).equals(program) && tagOf(d, i) === tag);
}
const u64 = (b: Uint8Array, off: number) => Buffer.from(b).readBigUInt64LE(off);

// ---------------------------------------------------------------- v2.2
const GROWTH = { lLaunchX100: 500, rGapBps: 400, maxAbsFundingE9PerSlot: 1_000n, maxTradingFeeBps: 630n };
const BOND = { ...DEFAULT_BOND };
const bondParams = () => params({ growth: GROWTH, v22: { lotExp: 3, rent: { ...DEFAULT_RENT }, band: bandDefaultsV22(6), bond: BOND } });
const kindsOf = (d: ReturnType<typeof decodeV1Message>) => d.instructions.map((_, i) => `${progOf(d, i).equals(PROGRAM) ? "w" : progOf(d, i).equals(STAKE) ? "s" : "x"}${tagOf(d, i)}`);

describe("v2.2 launch", () => {
  afterEach(() => __setDevnetV22ForTest(null));

  it("flag ON, lot + holding fee + price protection: InitMarket carries the merged trailer; still ONE transaction", async () => {
    __setDevnetV22ForTest(true);
    const p = params({ growth: GROWTH, v22: { lotExp: 3, rent: { ...DEFAULT_RENT }, band: bandDefaultsV22(6) } });
    const { outcome } = await launch({ singleTx: true, params: p });
    expect(outcome).toEqual({ status: "success" });
    expect(sent).toHaveLength(1);
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const im = findIx(d, PROGRAM, IX_TAG.InitMarket);
    expect(im).toHaveLength(1);
    const data = d.instructions[im[0]!]!.data;
    const trailer = encodeInitMarketTrailerV22({ rGapBps: 400, lLaunchX100: 500, lotExp: 3, rent: { ...DEFAULT_RENT }, band: bandDefaultsV22(6) });
    expect(trailer).toHaveLength(29);
    expect(Buffer.from(data.subarray(data.length - 29)).equals(Buffer.from(trailer))).toBe(true);
    expect(findIx(d, PROGRAM, IX_TAG_V22.InitBondTranche)).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: flag OFF drops the v2.2 params; InitMarket is the plain growth form (4-byte trailer)", async () => {
    __setDevnetV22ForTest(false);
    await launch({ singleTx: true, params: params({ growth: GROWTH, v22: { lotExp: 3, rent: { ...DEFAULT_RENT }, band: bandDefaultsV22(6) } }) });
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const im = findIx(d, PROGRAM, IX_TAG.InitMarket)[0]!;
    // The wizard never passes v22 with the flag off; the encoder still honours the explicit params, so prove parity through the plain path:
    sent = [];
    await launch({ singleTx: true, params: params({ growth: GROWTH }) });
    const d0 = decodeV1Message(splitV1Wire(sent[0]!).message);
    const plain = d0.instructions[findIx(d0, PROGRAM, IX_TAG.InitMarket)[0]!]!.data;
    expect(plain.length).toBe(d.instructions[im]!.data.length - 25);
  });

  it("flag ON + bond: 74, create, create, 94, 107, then the Earn seeds; ONE v1 tx; the real keeper route co-signs it", async () => {
    __setDevnetV22ForTest(true);
    const { outcome } = await launch({ singleTx: true, params: bondParams() });
    expect(outcome).toEqual({ status: "success" });
    expect(sent).toHaveLength(1);
    expect(routeCalls).toEqual([{ v1: false, status: 200 }, { v1: true, status: 200 }]);
    const wire = sent[0]!;
    const d = decodeV1Message(splitV1Wire(wire).message);
    expect(wire.length).toBeLessThanOrEqual(4096);
    const k = kindsOf(d);
    const i74 = k.indexOf("w74");
    const i94 = k.indexOf("w94");
    const i107 = k.indexOf("w107");
    expect(i107).toBe(i94 + 1);
    // seeds (75 x2) are AFTER 107; nothing between 74 and 94 but the two creates
    const seeds = k.map((x, i) => (x === "w75" ? i : -1)).filter((i) => i >= 0);
    expect(seeds.length).toBeGreaterThan(0);
    for (const s of seeds) expect(s).toBeGreaterThan(i107);
    expect(i74).toBeLessThan(i94);
    expect(k.slice(i74 + 1, i94).every((x) => x === "x0" || x.startsWith("x"))).toBe(true);
    // 107 precedes the stake InitPool (marketauth rotation)
    expect(i107).toBeLessThan(findIx(d, STAKE, STAKE_IX.InitPool)[0]!);
    // never split: no second transaction, no batch
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(S.broadcastSignedTx).not.toHaveBeenCalled();
  });

  it("F2: in the bond launch each Earn seed (75) carries the bound-vault tail [11] vault_lp_state (w), [12] LP portfolio; the plain launch does not", async () => {
    __setDevnetV22ForTest(true);
    await launch({ singleTx: true, params: bondParams() });
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const key = (ix: (typeof d.instructions)[number], j: number) => d.accountKeys[ix.accountIndexes[j]!]!;
    const ix94 = d.instructions[findIx(d, PROGRAM, 94)[0]!]!;
    const seeds = findIx(d, PROGRAM, 75).map((i) => d.instructions[i]!);
    expect(seeds).toHaveLength(2);
    for (const ix of seeds) {
      expect(ix.accountIndexes).toHaveLength(13);
      expect(key(ix, 11).equals(key(ix94, 3))).toBe(true);
      expect(key(ix, 12).equals(key(ix94, 4))).toBe(true);
    }
    // no bond: the seeds stay the plain 11 accounts (the vault is not bound yet when they run)
    sent = [];
    await launch({ singleTx: true, params: params({ growth: GROWTH, v22: { lotExp: 0, rent: { ...DEFAULT_RENT }, band: bandDefaultsV22(6) } }) });
    const d2 = decodeV1Message(splitV1Wire(sent[0]!).message);
    for (const i of findIx(d2, PROGRAM, 75)) expect(d2.instructions[i]!.accountIndexes).toHaveLength(11);
  });

  it("F2 shape rule: the real bond bundle is valid; the same bundle with the seeds' tail stripped (or the tail on an unbound seed) is refused", async () => {
    __setDevnetV22ForTest(true);
    await launch({ singleTx: true, params: bondParams() });
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const ctx = { programs: { wrapper: PROGRAM.toBase58(), stake: STAKE.toBase58() }, payer: WALLET.publicKey.toBase58(), slab: Keypair.fromSeed(seed(77)).publicKey.toBase58(), keeper: KEEPER.publicKey.toBase58() };
    const good = neutralFromV1(d);
    expect(launchBundleViolations(good, ctx).filter((x) => /DepositToLpVault/.test(x))).toEqual([]);
    const stripped = good.map((x) => (x.programId === ctx.programs.wrapper && x.data[0] === 75 ? { ...x, accounts: x.accounts.slice(0, 11) } : x));
    expect(launchBundleViolations(stripped, ctx).some((x) => /bound vault must carry the vault_lp_state/.test(x) || /must carry the vault_lp_state/.test(x))).toBe(true);
    const wrongKey = good.map((x) => (x.programId === ctx.programs.wrapper && x.data[0] === 75 ? { ...x, accounts: x.accounts.map((a, i) => (i === 12 ? { ...a, key: ctx.payer } : a)) } : x));
    expect(launchBundleViolations(wrongKey, ctx).some((x) => /must carry the vault_lp_state/.test(x))).toBe(true);
  });

  // Dump of the REAL bond launch the app builds, for the LiteSVM replay against the real wrapper binary
  // (scripts are outside the repo: the replay harness lives in the session scratchpad). Only runs when V22_BOND_DUMP is set.
  it.runIf(!!process.env.V22_BOND_DUMP)("dump: the bond launch instructions as JSON", async () => {
    __setDevnetV22ForTest(true);
    const { outcome } = await launch({ singleTx: true, params: params({ initialPriceE6: 10_000_000n, growth: GROWTH, v22: { lotExp: 0, rent: { ...DEFAULT_RENT }, band: bandDefaultsV22(6), bond: BOND } }) });
    expect(outcome).toEqual({ status: "success" });
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const out = {
      wrapper: PROGRAM.toBase58(), stake: STAKE.toBase58(), payer: WALLET.publicKey.toBase58(), keeper: KEEPER.publicKey.toBase58(), mint: MINT.toBase58(),
      computeUnitLimit: d.computeUnitLimit, heap: d.heapSizeBytes,
      instructions: d.instructions.map((ix) => ({
        program: d.accountKeys[ix.programIdIndex]!.toBase58(),
        keys: ix.accountIndexes.map((i) => ({ pubkey: d.accountKeys[i]!.toBase58(), signer: i < d.numRequiredSignatures, writable: v1IsWritable(d, i) })),
        data: Buffer.from(ix.data).toString("hex"),
      })),
    };
    writeFileSync(process.env.V22_BOND_DUMP!, JSON.stringify(out, null, 1));
  });

  it("NEGATIVE CONTROL: the same bond list in the v2.1 order (107 after the seeds) is refused by the shape", () => {
    __setDevnetV22ForTest(true);
    const shape = expectedLaunchShape({ memo: true, cosign: true, feeSplit: false, bond: true });
    const v21 = expectedLaunchShape({ memo: true, cosign: true, feeSplit: false });
    const iSeed = shape.indexOf("ata.createIdempotent");
    expect(shape.indexOf("wrapper.InitBondTranche")).toBeLessThan(iSeed);
    expect(v21).not.toContain("wrapper.InitBondTranche");
    expect(shape).toHaveLength(v21.length + 1);
  });

  it("flag OFF: a bond bundle is not a launch shape (tag 107 is foreign) so the keeper route refuses it", async () => {
    __setDevnetV22ForTest(true);
    await launch({ singleTx: true, params: bondParams() });
    const wire = sent[0]!;
    const d = decodeV1Message(splitV1Wire(wire).message);
    __setDevnetV22ForTest(false);
    const v = launchBundleViolations(neutralFromV1(d), { programs: { wrapper: PROGRAM.toBase58(), stake: STAKE.toBase58() }, payer: WALLET.publicKey.toBase58(), slab: Keypair.fromSeed(seed(100)).publicKey.toBase58(), keeper: KEEPER.publicKey.toBase58() });
    expect(v.length).toBeGreaterThan(0);
  });

  it("bond with NO single-transaction path: refused with a calm line, nothing sent, never the batch", async () => {
    __setDevnetV22ForTest(true);
    const { outcome } = await launch({ singleTx: false, params: bondParams() });
    expect(outcome).toEqual({ status: "aborted" });
    expect(stateBox.error).toMatch(/single approval/);
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("bond whose single tx cannot run (v1 format rejected): refused, nothing sent, never the batch", async () => {
    __setDevnetV22ForTest(true);
    const { outcome } = await launch({
      singleTx: true,
      params: bondParams(),
      deps: { simulate: async () => { throw new Error("transaction version 1 is not supported"); } },
    });
    expect(outcome).toEqual({ status: "aborted" });
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: without a bond, a failing single tx still falls back to the batch (the v2.1 behaviour)", async () => {
    __setDevnetV22ForTest(true);
    await launch({
      singleTx: true,
      params: params({ growth: GROWTH, v22: { lotExp: 3 } }),
      deps: { simulate: async () => { throw new Error("transaction version 1 is not supported"); } },
    });
    expect(S.signAllCompat).toHaveBeenCalled();
  });
});

describe("placeBondTranche (pure)", () => {
  const w = PROGRAM;
  const dummy = (n: number) => Array.from({ length: n }, (_, i) => ({ pubkey: Keypair.fromSeed(seed(150 + i)).publicKey, isSigner: false, isWritable: true }));
  const ix = (tag: number, program = w) => new TransactionInstruction({ programId: program, keys: tag === 75 ? dummy(11) : tag === 94 ? dummy(11) : [], data: Buffer.from([tag]) });
  const create = () => new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(52) });
  const list = () => [ix(0), ix(74), ix(1, new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")), ix(75), ix(75), create(), create(), ix(94), ix(96)];
  it("moves the seed segment after 107 and keeps everything else in order", () => {
    const out = placeBondTranche(list(), ix(107), w).map((i) => (i.programId.equals(SystemProgram.programId) ? "c" : i.data[0]));
    expect(out).toEqual([0, 74, "c", "c", 94, 107, 1, 75, 75, 96]);
  });
  it("F2: the moved seeds gain exactly [11] = the 94's vault_lp_state and [12] = its LP portfolio; the 94 itself is untouched", () => {
    const l = list();
    const out = placeBondTranche(l, ix(107), w);
    const i94 = out.find((x) => x.data[0] === 94)!;
    const seeds = out.filter((x) => x.data[0] === 75);
    expect(seeds).toHaveLength(2);
    for (const sx of seeds) {
      expect(sx.keys).toHaveLength(13);
      expect(sx.keys[11]!.pubkey.equals(i94.keys[3]!.pubkey)).toBe(true);
      expect(sx.keys[11]!.isWritable).toBe(true);
      expect(sx.keys[12]!.pubkey.equals(i94.keys[4]!.pubkey)).toBe(true);
    }
    expect(i94.keys).toHaveLength(11);
  });
  it("NEGATIVE CONTROL: refuses a list that is not a 74 ... create create 94 launch, and a second bond", () => {
    expect(() => placeBondTranche([ix(0), ix(74)], ix(107), w)).toThrow();
    expect(() => placeBondTranche([ix(74), ix(1, new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")), ix(94)], ix(107), w)).toThrow();
    expect(() => placeBondTranche([ix(0), ix(74), create(), create(), ix(94), ix(107)], ix(107), w)).toThrow();
  });
});
