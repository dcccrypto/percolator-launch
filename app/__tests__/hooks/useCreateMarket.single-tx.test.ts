// @vitest-environment node
/**
 * Single-transaction market launch (Solana v1): the REAL hook (attemptFreshBatchedLaunch) builds the
 * bundle from its own descriptors, the REAL orchestrator (lib/launch-single-tx/run.ts) runs it, and the
 * REAL keeper co-sign route validates and signs it with a real keeper key. Only the network and the
 * wallet are faked. Every rule has a negative control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
import { PRIORITY_FEE_MAX_MICRO_LAMPORTS } from "@/lib/tx";
import { MAX_PRIORITY_FEE_LAMPORTS, priorityFeeLamportsFromMicroPerCu } from "@/lib/v21/sdk";
import { requirePlaygroundKeeperSigner } from "@/lib/playground-keeper-signer";
import { V1RpcError } from "@/lib/v21/sdk";
import { V1TransportError } from "@/lib/tx-v1/rpc";

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

// ---------------------------------------------------------------- happy path + structure
describe("single-transaction launch: happy path", () => {
  it("one v1 tx, one wallet prompt, keeper co-signed by the real route, lands; no batch, no in-flight record", async () => {
    const { outcome, slab } = await launch({ singleTx: true });
    expect(outcome).toEqual({ status: "success" });
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(0x81);
    expect(walletPrompts).toBe(1);
    expect(keeperCalls).toBe(1);
    expect(routeCalls).toEqual([{ v1: false, status: 200 }, { v1: true, status: 200 }]);
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(S.broadcastSignedTx).not.toHaveBeenCalled();
    expect(S.presimulateOrThrow).not.toHaveBeenCalled();
    expect(S.saveInFlightMarket).not.toHaveBeenCalled();
    expect(stateBox.step).toBe(6);
    expect(stateBox.phase).toBe("done");
    expect(stateBox.slabAddress).toBe(slab.toBase58());
    // Every signature slot verifies against the message (wallet, keeper, 5 fresh keypairs).
    const { message, signatures } = splitV1Wire(sent[0]!);
    const d = decodeV1Message(message);
    expect(signatures).toHaveLength(7);
    signatures.forEach((s, k) => expect(ed25519.verify(s, message, d.accountKeys[k]!.toBytes())).toBe(true));
    // The simulated message is the sent message (simulate-before-sign covers the exact bytes).
    expect(Buffer.from(splitV1Wire(simulated[0]!).message).equals(Buffer.from(message))).toBe(true);
  });

  it("structural ordering of the built bundle (independent of shape.ts)", async () => {
    await launch({ singleTx: true });
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const sys = SystemProgram.programId;
    const createAccounts = d.instructions.map((_, i) => i).filter((i) => progOf(d, i).equals(sys) && Buffer.from(d.instructions[i]!.data).readUInt32LE(0) === 0);
    const initPool = findIx(d, STAKE, STAKE_IX.InitPool);
    const bind = findIx(d, STAKE, STAKE_IX.BindInsuranceAuthority);
    const topup = findIx(d, PROGRAM, IX_TAG.TopUpInsurance);
    const gated = [IX_TAG.SetNftProgramId, IX_TAG.CreateLpVault, IX_TAG_P3.InitVaultLp, IX_TAG.UpdateFeeSplit].flatMap((t) => findIx(d, PROGRAM, t));
    expect(d.instructions).toHaveLength(20);
    expect(createAccounts).toHaveLength(5);
    expect(initPool).toHaveLength(1);
    expect(bind).toHaveLength(1);
    expect(topup).toHaveLength(1);
    expect(gated.length).toBeGreaterThanOrEqual(3);
    for (const g of gated) expect(g).toBeLessThan(initPool[0]!);
    expect(bind[0]!).toBeGreaterThan(initPool[0]!);
    expect(topup[0]!).toBeLessThan(bind[0]!);
    // createAccount before any other reference to the new account
    for (const c of createAccounts) {
      const target = d.instructions[c]!.accountIndexes[1]!;
      const firstUse = d.instructions.findIndex((ix) => ix.accountIndexes.includes(target) || ix.programIdIndex === target);
      expect(firstUse).toBe(c);
    }
    // oracle-observation lane: exactly one ConfigureAuthMark (seq 1) and no PushAuthMark in the app bundle
    const cam = findIx(d, PROGRAM, IX_TAG.ConfigureAuthMark);
    expect(cam).toHaveLength(1);
    expect(u64(d.instructions[cam[0]!]!.data, 27)).toBe(1n);
    expect(findIx(d, PROGRAM, IX_TAG.PushAuthMark)).toHaveLength(0);
    // authority-epoch lane: UpdateAssetAuthority at 0, TopUpInsurance after it at 1
    const uaa = findIx(d, PROGRAM, IX_TAG.UpdateAssetAuthority);
    expect(uaa).toHaveLength(1);
    expect(uaa[0]!).toBeLessThan(topup[0]!);
    expect(u64(d.instructions[topup[0]!]!.data, 17)).toBe(1n);
    // keeper: signer of exactly that one ix (new_authority), read-only, not the payer
    const k = d.accountKeys.findIndex((x) => x.equals(KEEPER.publicKey));
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(d.numRequiredSignatures);
    expect(v1IsWritable(d, k)).toBe(false);
    const users = d.instructions.map((ix, i) => ({ i, pos: ix.accountIndexes.indexOf(k) })).filter((x) => x.pos >= 0);
    expect(users).toEqual([{ i: uaa[0]!, pos: 1 }]);
    expect(d.accountKeys[0]!.equals(WALLET.publicKey)).toBe(true);
    // v1 config: heap 128 KiB (required by the wrapper), explicit loaded-size and CU limits
    expect(d.heapSizeBytes).toBe(131_072);
    expect(d.loadedAccountsDataSizeLimit).toBeGreaterThan(0);
    expect(d.computeUnitLimit).toBe(1_400_000);
  });

  it("limits: bytes / accounts / signers / instructions (reported) and +UpdateFeeSplit = 21 ix", async () => {
    await launch({ singleTx: true });
    const wire = sent[0]!;
    const d = decodeV1Message(splitV1Wire(wire).message);
    const r1 = { bytes: wire.length, accounts: d.accountKeys.length, signers: d.numRequiredSignatures, ixs: d.instructions.length };
    sent = [];
    await launch({ singleTx: true, params: params({ feeSplit: { creatorShareBps: 2_000, lpShareBps: 4_400, insuranceShareBps: 1_600 } }) });
    const wire2 = sent[0]!;
    const d2 = decodeV1Message(splitV1Wire(wire2).message);
    const r2 = { bytes: wire2.length, accounts: d2.accountKeys.length, signers: d2.numRequiredSignatures, ixs: d2.instructions.length };
    if (process.env.SINGLE_TX_STATS_OUT) writeFileSync(process.env.SINGLE_TX_STATS_OUT, JSON.stringify({ base: r1, feeSplit: r2 }));
    for (const r of [r1, r2]) {
      expect(r.bytes).toBeLessThanOrEqual(4096);
      expect(r.accounts).toBeLessThanOrEqual(64);
      expect(r.signers).toBeLessThanOrEqual(12);
      expect(r.ixs).toBeLessThanOrEqual(64);
    }
    expect(r1.signers).toBe(7);
    expect(r2.ixs).toBe(21);
    expect(findIx(d2, PROGRAM, IX_TAG.UpdateFeeSplit)[0]!).toBeLessThan(findIx(d2, STAKE, STAKE_IX.InitPool)[0]!);
    expect(u64(d2.instructions[findIx(d2, PROGRAM, IX_TAG.UpdateFeeSplit)[0]!]!.data, 7)).toBe(1n);
  });

  it("the single tx carries EXACTLY the batch's instructions, in the batch's order (no second source of truth)", async () => {
    await launch({ singleTx: true });
    const d = decodeV1Message(splitV1Wire(sent[0]!).message);
    const single = d.instructions.map((ix, i) => Buffer.concat([progOf(d, i).toBuffer(), Buffer.from(ix.accountIndexes.map((a) => d.accountKeys[a]!.toBase58()).join(",")), Buffer.from(ix.data)]).toString("hex"));
    await launch({ singleTx: false });
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toHaveLength(6);
    const flat = batch.flatMap((tx) => tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)));
    const batched = flat.map((ix) => Buffer.concat([ix.programId.toBuffer(), Buffer.from(ix.keys.map((k) => k.pubkey.toBase58()).join(",")), Buffer.from(ix.data)]).toString("hex"));
    expect(single).toEqual(batched);
  });

  it("singleTxInstructionPlan puts the co-sign pair right after M1 and dedupes signers", () => {
    const a = Keypair.fromSeed(seed(1));
    const ix = (n: number) => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([n]) });
    const plan = singleTxInstructionPlan([{ instructions: [ix(1)], signers: [a] }, { instructions: [ix(3)], signers: [a] }], [ix(2)]);
    expect(plan.instructions.map((i) => i.data[0])).toEqual([1, 2, 3]);
    expect(plan.signers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- gate
describe("gate", () => {
  const base = { v21Enabled: true, mode: "auto" as const, p3: true, walletSupportsV1: () => true, clusterSupportsV1: async () => true };
  it("use only when every condition holds; cheap checks short-circuit the RPC", async () => {
    expect(await singleTxLaunchGate(base)).toBe("use");
    expect(await singleTxLaunchGate({ ...base, mode: "on" })).toBe("use");
    const cluster = vi.fn(async () => true);
    const walletProbe = vi.fn(() => true);
    expect(await singleTxLaunchGate({ ...base, v21Enabled: false, clusterSupportsV1: cluster, walletSupportsV1: walletProbe })).toBe("v21-flag-off");
    expect(await singleTxLaunchGate({ ...base, mode: "off", clusterSupportsV1: cluster, walletSupportsV1: walletProbe })).toBe("mode-off");
    expect(await singleTxLaunchGate({ ...base, p3: false, clusterSupportsV1: cluster })).toBe("not-p3");
    expect(await singleTxLaunchGate({ ...base, walletSupportsV1: () => false, clusterSupportsV1: cluster })).toBe("wallet-no-v1");
    expect(cluster).not.toHaveBeenCalled();
    expect(walletProbe).not.toHaveBeenCalled();
    expect(await singleTxLaunchGate({ ...base, clusterSupportsV1: async () => false })).toBe("cluster-no-v1");
  });

  it("wallet without v1 (gate closed => singleTx null): the 6-tx batch, no v1 bytes anywhere, no v1 dep touched", async () => {
    await launch({ singleTx: false });
    expect(batches).toHaveLength(1);
    expect(batches[0]!).toHaveLength(6);
    for (const tx of batches[0]!) expect(tx.serializeMessage()[0]).not.toBe(0x81);
    expect(sent).toHaveLength(0);
    expect(simulated).toHaveLength(0);
    expect(walletPrompts).toBe(0);
    expect(routeCalls.every((r) => !r.v1)).toBe(true);
  });
});

// ---------------------------------------------------------------- failure paths
describe("failure paths", () => {
  it("simulation failure => no keeper call, no wallet prompt, no fallback, nothing sent", async () => {
    const { outcome } = await launch({ singleTx: true, deps: { simulate: async () => ({ err: { InstructionError: [9, { Custom: 63 }] }, logs: ["Program log: x"] }) } });
    expect(outcome).toEqual({ status: "aborted" });
    expect(walletPrompts).toBe(0);
    expect(keeperCalls).toBe(0);
    expect(sent).toHaveLength(0);
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(stateBox.error).toMatch(/refused before anything was created/);
  });

  it("wallet v1-signing error => exactly ONE fallback (the batch, same slab), the v1 tx never sent", async () => {
    const { outcome, slab } = await launch({ singleTx: true, deps: { walletSign: async () => { walletPrompts++; throw new Error("Reached end of buffer unexpectedly"); } } });
    expect(walletPrompts).toBe(1);
    expect(sent).toHaveLength(0);
    expect(S.signAllCompat).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("fallback"); // the batch stub stops pre-broadcast -> sequential (unchanged contract)
    // The batch reuses the SAME slab keypair: M1's createAccount targets the slab the v1 tx would have.
    const m1 = batches[0]![0]!;
    const create = m1.instructions.find((ix) => ix.programId.equals(SystemProgram.programId))!;
    expect(create.keys[1]!.pubkey.equals(slab)).toBe(true);
    // A fresh legacy co-sign was requested for the batch (the first may have aged).
    expect(routeCalls.filter((r) => !r.v1)).toHaveLength(2);
    expect(stateBox.singleTxFallbackReason).toMatch(/could not sign/);
  });

  it("user declines the single prompt => refused, no fallback prompt", async () => {
    const { outcome } = await launch({ singleTx: true, deps: { walletSign: async () => { walletPrompts++; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } } });
    expect(outcome).toEqual({ status: "aborted" });
    expect(walletPrompts).toBe(1);
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(stateBox.error).toMatch(/declined/);
  });

  it("keeper route refusal => fallback to the batch before any wallet prompt", async () => {
    const { outcome } = await launch({ singleTx: true, deps: { keeperSign: async () => { keeperCalls++; throw new Error("co-sign 422"); } } });
    expect(walletPrompts).toBe(0);
    expect(S.signAllCompat).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("fallback");
  });

  it("RPC format rejection on send => fallback once (nothing accepted)", async () => {
    let sends = 0;
    await launch({ singleTx: true, deps: { send: async () => { sends++; throw new V1RpcError("sendTransaction", -32602, "invalid transaction: transaction failed to sanitize"); } } });
    expect(sends).toBe(1);
    expect(S.signAllCompat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a transport failure (fetch failed)", () => new V1TransportError("sendTransaction", new TypeError("Failed to fetch"))],
    ["an error whose TEXT says -32602 / -32002 but carries no code", () => new Error("RPC sendTransaction failed: -32602 invalid transaction; -32002 Transaction simulation failed")],
    ["a transport failure whose text says -32002", () => new V1TransportError("sendTransaction", new Error("-32002 Transaction simulation failed"))],
  ])("send throws %s => never a fallback: the outcome resolver decides (here: landed)", async (_n, mk) => {
    const textOnly = _n.startsWith("an error whose TEXT");
    const { outcome } = await launch({ singleTx: true, deps: { send: async (w) => { sent.push(w); throw mk(); } } });
    expect(sent).toHaveLength(1);
    expect(S.signAllCompat).not.toHaveBeenCalled(); // no batch, no second prompt
    // a code-less plain Error mentioning "Transaction simulation failed" is still read as a preflight refusal (legacy text rule)
    if (textOnly) expect(outcome).toEqual({ status: "aborted" });
    else expect(outcome).toEqual({ status: "success" }); // the resolver read the (default) confirmed status
  });

  it.each([
    ["Phantom 4001", () => ({ code: 4001, message: "User rejected the request." })],
    ["wallet-adapter wrapping 4001", () => Object.assign(new Error("Unexpected error"), { name: "WalletSignTransactionError", error: { code: 4001, message: "Unexpected error" } })],
    ["Transaction cancelled", () => new Error("Transaction cancelled")],
    ["MWA not signed", () => Object.assign(new Error("not signed"), { name: "SolanaMobileWalletAdapterProtocolError", code: -3 })],
  ])("decline (%s) => refused, ONE prompt, no batch fallback", async (_n, mk) => {
    const { outcome } = await launch({ singleTx: true, deps: { walletSign: async () => { walletPrompts++; throw mk(); } } });
    expect(outcome).toEqual({ status: "aborted" });
    expect(walletPrompts).toBe(1);
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(stateBox.error).toMatch(/declined/);
  });

  it("a wallet error that is neither a decline nor a v1 parse failure => refused, no batch re-prompt", async () => {
    const { outcome } = await launch({ singleTx: true, deps: { walletSign: async () => { walletPrompts++; throw new Error("WalletNotConnectedError"); } } });
    expect(outcome).toEqual({ status: "aborted" });
    expect(walletPrompts).toBe(1);
    expect(S.signAllCompat).not.toHaveBeenCalled();
  });

  it("preflight refusal (-32002) => refused, no fallback", async () => {
    const { outcome } = await launch({ singleTx: true, deps: { send: async () => { throw new Error("RPC sendTransaction failed: -32002 Transaction simulation failed: Error processing Instruction 9"); } } });
    expect(outcome).toEqual({ status: "aborted" });
    expect(S.signAllCompat).not.toHaveBeenCalled();
  });

  it("landed-but-failed on chain => refused (atomic: nothing created), no fallback", async () => {
    const { outcome } = await launch({ singleTx: true, deps: { status: async () => ({ kind: "failed", err: { InstructionError: [3, { Custom: 19 }] } }) } });
    expect(outcome).toEqual({ status: "aborted" });
    expect(S.signAllCompat).not.toHaveBeenCalled();
  });
});

describe("unknown send outcome => never a blind re-launch", () => {
  it("send times out, the blockhash expires, the slab EXISTS => landed (no fallback)", async () => {
    const { outcome } = await launch({
      singleTx: true,
      deps: { send: async () => { throw new Error("fetch failed"); }, status: async () => ({ kind: "not-found" }), blockHeight: async () => 2_000, slabExists: async () => true },
    });
    expect(outcome).toEqual({ status: "success" });
    expect(S.signAllCompat).not.toHaveBeenCalled();
  });

  it("send times out, the RPC never answers => unknown: aborted with the signature, no fallback, proof saved for a later registration", async () => {
    const { outcome } = await launch({
      singleTx: true,
      deps: { send: async () => { throw new Error("fetch failed"); }, status: async () => { throw new Error("503"); } },
    });
    expect(outcome).toEqual({ status: "aborted" });
    expect(S.signAllCompat).not.toHaveBeenCalled();
    expect(stateBox.error).toMatch(/Do not launch again/);
  });

  it("pending until the blockhash expires, still not found, NO slab => exactly one fallback", async () => {
    let polls = 0;
    let heights = 0;
    const { outcome } = await launch({
      singleTx: true,
      deps: { status: async () => (++polls <= 2 ? { kind: "pending" } : { kind: "not-found" }), blockHeight: async () => (++heights >= 2 ? 2_000 : 0), slabExists: async () => false },
    });
    expect(heights).toBe(2);
    expect(sent).toHaveLength(1);
    expect(S.signAllCompat).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("fallback");
  });

  it("not found but the blockhash is still valid => keeps waiting (never falls back early)", async () => {
    let polls = 0;
    const { outcome } = await launch({
      singleTx: true,
      deps: { status: async () => (++polls < 5 ? { kind: "not-found" } : { kind: "confirmed" }), blockHeight: async () => 10 },
    });
    expect(polls).toBe(5);
    expect(outcome).toEqual({ status: "success" });
    expect(S.signAllCompat).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- keeper co-sign route
describe("keeper-cosign route: v1 validation", () => {
  let good: Uint8Array;
  let body: KeeperCosignRequestBase;
  beforeEach(async () => {
    await launch({ singleTx: true });
    good = splitV1Wire(sent[0]!).message;
    body = { deployer: WALLET.publicKey.toBase58(), slabAddress: Keypair.fromSeed(seed(77)).publicKey.toBase58(), initialPriceE6: "1000000", assetIndex: 0, fresh: true };
  });
  /** POST without touching the rate-limit windows (the L-3 test counts requests itself). */
  const postRaw = async (message: Uint8Array, over: Record<string, unknown> = {}) => {
    const res = await cosignPOST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...over, v1MessageBase64: Buffer.from(message).toString("base64") }) }));
    return { status: res.status, json: (await res.json()) as { error?: string; keeperSignatureBase64?: string } };
  };
  const post = async (message: Uint8Array, over: Record<string, unknown> = {}) => {
    resetCosignV1RateLimits(); // validation probes are not rate-limit probes
    const res = await cosignPOST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...over, v1MessageBase64: Buffer.from(message).toString("base64") }) }));
    return { status: res.status, json: (await res.json()) as { error?: string; keeperSignatureBase64?: string } };
  };
  /** Instructions of the good message, as web3 instructions (for recompiling mutations). */
  const ixsOf = (m: Uint8Array): TransactionInstruction[] => {
    const d = decodeV1Message(m);
    return d.instructions.map((ix) => new TransactionInstruction({
      programId: d.accountKeys[ix.programIdIndex]!,
      keys: ix.accountIndexes.map((a) => ({ pubkey: d.accountKeys[a]!, isSigner: a < d.numRequiredSignatures, isWritable: v1IsWritable(d, a) })),
      data: Buffer.from(ix.data),
    }));
  };
  const recompile = (ixs: TransactionInstruction[], payer = WALLET.publicKey) =>
    compileV1Message({ payer, instructions: ixs, recentBlockhash: "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS", config: { computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: 8 << 20, heapSizeBytes: 131_072 } }).message;

  it("positive control: the real bundle is co-signed and the signature verifies", async () => {
    const r = await post(good);
    expect(r.status).toBe(200);
    expect(ed25519.verify(Buffer.from(r.json.keeperSignatureBase64!, "base64"), good, KEEPER.publicKey.toBytes())).toBe(true);
    // recompiling the same instructions is accepted too (the mutation baseline is sound)
    expect((await post(recompile(ixsOf(good)))).status).toBe(200);
  });

  it("rejects the keeper as fee payer", async () => {
    const r = await post(recompile(ixsOf(good), KEEPER.publicKey));
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/fee payer/);
    expect((await post(good, { deployer: KEEPER.publicKey.toBase58() })).status).toBe(400);
  });

  it("rejects the keeper as a transfer source", async () => {
    const ixs = ixsOf(good);
    ixs.push(SystemProgram.transfer({ fromPubkey: KEEPER.publicKey, toPubkey: WALLET.publicKey, lamports: 1 }));
    const r = await post(recompile(ixs));
    expect(r.status).toBe(422);
  });

  it("rejects the keeper as a createAccount funder inside the shape (swap a create's source)", async () => {
    const ixs = ixsOf(good);
    const i = ixs.findIndex((x) => x.programId.equals(SystemProgram.programId));
    ixs[i] = new TransactionInstruction({ ...ixs[i]!, keys: [{ pubkey: KEEPER.publicKey, isSigner: true, isWritable: true }, ...ixs[i]!.keys.slice(1)] });
    const r = await post(recompile(ixs));
    expect(r.status).toBe(422);
  });

  it("rejects an extra signer instruction", async () => {
    const ixs = ixsOf(good);
    ixs.push(new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [{ pubkey: Keypair.fromSeed(seed(9)).publicKey, isSigner: true, isWritable: false }], data: Buffer.from("x") }));
    expect((await post(recompile(ixs))).status).toBe(422);
  });

  it("rejects a wrong program", async () => {
    const ixs = ixsOf(good);
    const bindIdx = ixs.findIndex((x) => x.programId.equals(STAKE) && x.data[0] === STAKE_IX.BindInsuranceAuthority);
    ixs[bindIdx] = new TransactionInstruction({ ...ixs[bindIdx]!, programId: Keypair.fromSeed(seed(8)).publicKey });
    const r = await post(recompile(ixs));
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/not allowed|launch shape/);
  });

  it("rejects an oversize message", async () => {
    const d = decodeV1Message(good);
    const big = encodeV1Message({ ...d, instructions: [...d.instructions, { programIdIndex: d.instructions[4]!.programIdIndex, accountIndexes: [0], data: new Uint8Array(3_000) }] });
    const r = await post(big);
    expect(r.status).toBe(400); // refused before decoding: base64 longer than any 4096-byte message
    expect(r.json.error).toMatch(/Invalid v1MessageBase64/);
    // under the 4096-byte message cap but over 4096 bytes with its 7 signatures
    const near = encodeV1Message({ ...d, instructions: [...d.instructions, { programIdIndex: d.instructions[4]!.programIdIndex, accountIndexes: [0], data: new Uint8Array(4096 - good.length - 4 - 1 - 100) }] });
    expect(near.length).toBeLessThanOrEqual(4096);
    expect(near.length + 7 * 64).toBeGreaterThan(4096);
    const r2 = await post(near);
    expect(r2.status).toBe(422);
    expect(r2.json.error).toMatch(/over v1 limits/);
  });

  it("rejects a tampered instruction order (TopUpInsurance moved after Bind; CreateLpVault after InitPool)", async () => {
    const d = decodeV1Message(good);
    const ixs = [...d.instructions];
    const top = ixs.findIndex((ix) => d.accountKeys[ix.programIdIndex]!.equals(PROGRAM) && ix.data[0] === IX_TAG.TopUpInsurance);
    const [t] = ixs.splice(top, 1);
    ixs.push(t!);
    expect((await post(encodeV1Message({ ...d, instructions: ixs }))).status).toBe(422);
    const ixs2 = [...d.instructions];
    const lp = ixs2.findIndex((ix) => d.accountKeys[ix.programIdIndex]!.equals(PROGRAM) && ix.data[0] === IX_TAG.CreateLpVault);
    const pool = ixs2.findIndex((ix) => d.accountKeys[ix.programIdIndex]!.equals(STAKE) && ix.data[0] === STAKE_IX.InitPool);
    [ixs2[lp], ixs2[pool]] = [ixs2[pool]!, ixs2[lp]!];
    expect((await post(encodeV1Message({ ...d, instructions: ixs2 }))).status).toBe(422);
  });

  it("rejects a tampered co-sign pair (another price / another keeper epoch) and a stale now_slot", async () => {
    expect((await post(good, { initialPriceE6: "2000000" })).status).toBe(422);
    const d = decodeV1Message(good);
    const ixs = d.instructions.map((ix) => ({ ...ix, data: new Uint8Array(ix.data) }));
    const uaa = ixs.findIndex((ix) => d.accountKeys[ix.programIdIndex]!.equals(PROGRAM) && ix.data[0] === IX_TAG.UpdateAssetAuthority);
    ixs[uaa]!.data[ixs[uaa]!.data.length - 8] = 7;
    expect((await post(encodeV1Message({ ...d, instructions: ixs }))).status).toBe(422);
    S.serverSlot = 5_000 + 10_000;
    const r = await post(good);
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/window/);
  });

  it("rejects a writable keeper, trailing bytes, an unknown config bit, and an existing slab", async () => {
    const d = decodeV1Message(good);
    expect((await post(encodeV1Message({ ...d, numReadonlySigned: d.numReadonlySigned - 1 })))).toMatchObject({ status: 422 });
    const trailing = await post(Uint8Array.from([...good, 0]));
    expect(trailing.status).toBe(422);
    expect(trailing.json.error).toMatch(/trailing bytes/);
    expect((await post(encodeV1Message({ ...d, configMask: d.configMask | 0x20 })))).toMatchObject({ status: 422 });
    S.serverSlabExists = true;
    expect((await post(good)).status).toBe(409);
  });

  // ---- security review 2026-10-05 L-1 / L-2 / L-3 / L-4 (each a negative control against the real route)
  const createIdx = (d: ReturnType<typeof decodeV1Message>) =>
    d.instructions.map((ix, i) => ({ ix, i })).filter(({ ix }) => d.accountKeys[ix.programIdIndex]!.equals(SystemProgram.programId)).map(({ i }) => i);
  /** Rewrite one createAccount field in place (lamports @4, space @12, owner @20). */
  const withCreate = (m: Uint8Array, n: number, f: (data: Buffer) => void): Uint8Array => {
    const d = decodeV1Message(m);
    const ixs = d.instructions.map((ix) => ({ ...ix, data: new Uint8Array(ix.data) }));
    const i = createIdx(d)[n]!;
    const b = Buffer.from(ixs[i]!.data);
    f(b);
    ixs[i]!.data = new Uint8Array(b);
    return encodeV1Message({ ...d, instructions: ixs });
  };

  it("L-1: the five createAccounts are pinned (owner, space, rent-exempt lamports) to the builders' constants", async () => {
    const d = decodeV1Message(good);
    const creates = createIdx(d).map((i) => Buffer.from(d.instructions[i]!.data));
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const owners = creates.map((b) => new PublicKey(b.subarray(20, 52)));
    expect(creates.map((b) => Number(b.readBigUInt64LE(12)))).toEqual([3_675, 9_563, 320, 82, 165]);
    expect(owners[0]!.equals(PROGRAM) && owners[1]!.equals(PROGRAM) && owners[3]!.equals(tokenProgram) && owners[4]!.equals(tokenProgram)).toBe(true);
    // rent in this harness = 1_000_000 + space on both the client and the server connection
    expect(creates.map((b) => Number(b.readBigUInt64LE(4)))).toEqual([3_675, 9_563, 320, 82, 165].map((n) => 1_000_000 + n));
    for (let n = 0; n < 5; n++) {
      const plus1 = await post(withCreate(good, n, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(4) + 1n, 4)));
      expect(plus1.status, `create ${n} lamports+1`).toBe(422);
      expect(plus1.json.error).toMatch(/lamports/);
      const space = await post(withCreate(good, n, (b) => b.writeBigUInt64LE(10n * 1024n * 1024n, 12)));
      expect(space.status, `create ${n} space`).toBe(422);
      expect(space.json.error).toMatch(/space/);
      const owner = await post(withCreate(good, n, (b) => b.set(KEEPER.publicKey.toBytes(), 20)));
      expect(owner.status, `create ${n} owner`).toBe(422);
      expect(owner.json.error).toMatch(/owner/);
    }
    expect((await post(good)).status).toBe(200); // positive control after the mutations
  });

  it("L-1: priority fee capped, heap only {default, 128 KiB}, loaded-accounts limit in [3 MiB, 64 MiB]", async () => {
    // the route constants agree with the client's own ceilings (the keeper never refuses an honest launch)
    expect(COSIGN_MAX_PRIORITY_FEE_LAMPORTS).toBe(priorityFeeLamportsFromMicroPerCu(PRIORITY_FEE_MAX_MICRO_LAMPORTS, SINGLE_TX_COMPUTE_UNITS));
    expect(COSIGN_MAX_PRIORITY_FEE_LAMPORTS <= MAX_PRIORITY_FEE_LAMPORTS).toBe(true);
    expect(SINGLE_TX_LOADED_ACCOUNTS_BYTES).toBeGreaterThanOrEqual(COSIGN_MIN_LOADED_ACCOUNTS_BYTES);
    expect(SINGLE_TX_LOADED_ACCOUNTS_BYTES).toBeLessThanOrEqual(COSIGN_MAX_LOADED_ACCOUNTS_BYTES);
    expect(SINGLE_TX_COMPUTE_UNITS).toBeLessThanOrEqual(1_400_000);
    const d = decodeV1Message(good);
    expect(d.priorityFeeLamports).not.toBeNull();
    expect(d.heapSizeBytes).toBe(COSIGN_HEAP_BYTES);
    const at = async (over: Partial<ReturnType<typeof decodeV1Message>>) => (await post(encodeV1Message({ ...d, ...over }))).status;
    expect(await at({ priorityFeeLamports: 0xffff_ffff_ffff_ffffn })).toBe(422);
    expect(await at({ priorityFeeLamports: 1_400_001n })).toBe(422);
    expect(await at({ priorityFeeLamports: 1_400_000n })).toBe(200);
    expect(await at({ heapSizeBytes: 262_144 })).toBe(422);
    expect(await at({ heapSizeBytes: 65_536 })).toBe(422);
    expect(await at({ loadedAccountsDataSizeLimit: 1 })).toBe(422);
    expect(await at({ loadedAccountsDataSizeLimit: 3 * 1024 * 1024 - 1 })).toBe(422);
    expect(await at({ loadedAccountsDataSizeLimit: 64 * 1024 * 1024 + 1 })).toBe(422);
    expect(await at({ loadedAccountsDataSizeLimit: 64 * 1024 * 1024 })).toBe(200);
  });

  it("L-2: a lifetime that is not a recent valid blockhash is refused (422) before signing", async () => {
    const d = decodeV1Message(good);
    const signs = vi.spyOn(ed25519, "sign");
    const r = await post(encodeV1Message({ ...d, recentBlockhash: new Uint8Array(32).fill(5) }));
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/not a recent valid blockhash/);
    expect(signs).not.toHaveBeenCalled();
    S.validBlockhashes.clear(); // the real blockhash expired
    expect((await post(good)).status).toBe(422);
  });

  it("L-3: per-deployer and per-IP limits on the v1 branch (429), legacy branch not counted", async () => {
    resetCosignV1RateLimits(); // beforeEach's launch already made one v1 request
    for (let k = 0; k < COSIGN_V1_LIMIT_PER_DEPLOYER; k++) expect((await postRaw(good)).status).toBe(200);
    const r = await postRaw(good);
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/per deployer/);
    // the legacy co-sign (the batch fallback) is not counted and still answers
    const legacy = await cosignPOST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(legacy.status).toBe(200);
    resetCosignV1RateLimits();
    // one IP rotating deployers: the IP limit bounds it (deployer limit never reached)
    const other = (k: number) => Keypair.fromSeed(seed(150 + k)).publicKey.toBase58();
    let last = 0;
    for (let k = 0; k <= COSIGN_V1_LIMIT_PER_IP; k++) {
      last = (await postRaw(good, { deployer: other(k) })).status;
      if (k < COSIGN_V1_LIMIT_PER_IP) expect(last).not.toBe(429);
    }
    expect(last).toBe(429);
  });

  it("L-4: the keeper signer signs ONLY a ValidatedLaunchMessage minted by the validator", async () => {
    const signer = requirePlaygroundKeeperSigner();
    expect(() => signer.signMessageBytes(good as unknown as ValidatedLaunchMessage)).toThrow(/not a validated launch message/);
    expect(() => signer.signMessageBytes(Object.create(ValidatedLaunchMessage.prototype) as ValidatedLaunchMessage)).toThrow(/not a validated launch message/);
    expect(() => signer.signMessageBytes({ bytes: () => good, nowSlot: 1n, blockhash: "x" } as unknown as ValidatedLaunchMessage)).toThrow(/not a validated launch message/);
    expect(() => new ValidatedLaunchMessage(Symbol("forged") as never, good, 1n, "x")).toThrow(/only be created by/);
    // the cosign route still works (positive control) and its signature verifies
    const r = await post(good);
    expect(r.status).toBe(200);
    expect(ed25519.verify(Buffer.from(r.json.keeperSignatureBase64!, "base64"), good, KEEPER.publicKey.toBytes())).toBe(true);
  });

  it("legacy (non-v1) co-sign behaviour is unchanged", async () => {
    const res = await cosignPOST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { partialTxBase64: string };
    const tx = Transaction.from(Buffer.from(j.partialTxBase64, "base64"));
    expect(tx.instructions.map((i) => i.data[0])).toEqual([IX_TAG.ConfigureAuthMark, IX_TAG.UpdateAssetAuthority]);
    expect(tx.feePayer!.equals(WALLET.publicKey)).toBe(true);
  });
});

// ---------------------------------------------------------------- keeper-register proof (v1 creation tx)
describe("keeper-register proof accepts a v1 creation tx (web3.js 1.99 MessageV1)", () => {
  it("the memo signer + InitMarket admin are read from a v1 message; a wrong binding is refused", async () => {
    const slab = Keypair.fromSeed(seed(77)).publicKey;
    const p = { slabAddress: slab.toBase58(), dexPoolAddress: POOL.toBase58(), mainnetCA: "", dexType: "raydium-clmm", payloadDigest: "" };
    const memo = await buildKeeperRegisterMemoIx(WALLET.publicKey, p);
    const init = new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: WALLET.publicKey, isSigner: true, isWritable: true }, { pubkey: slab, isSigner: false, isWritable: true }, { pubkey: MINT, isSigner: false, isWritable: false }], data: Buffer.from([IX_TAG.InitMarket, 1, 0]) });
    const c = compileV1Message({ payer: WALLET.publicKey, instructions: [init, memo], recentBlockhash: "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS", config: { computeUnitLimit: 200_000, heapSizeBytes: 131_072 } });
    const message = MessageV1.deserialize(c.message);
    const tx = { meta: { err: null }, transaction: { message, signatures: [] } } as unknown as Parameters<typeof verifyKeeperRegisterProofTx>[0];
    expect(await verifyKeeperRegisterProofTx(tx, p, PROGRAM.toBase58())).toEqual({ ok: true, creator: WALLET.publicKey.toBase58() });
    expect((await verifyKeeperRegisterProofTx(tx, { ...p, dexType: "pumpswap" }, PROGRAM.toBase58())).ok).toBe(false);
  });
});


// ---------------------------------------------------------------- each shape rule on its own
describe("launchBundleViolations: each rule is enforced by itself (not only by an overlapping one)", () => {
  let good: NeutralIx[];
  const ctx = () => ({ programs: { wrapper: PROGRAM.toBase58(), stake: STAKE.toBase58() }, payer: WALLET.publicKey.toBase58(), slab: Keypair.fromSeed(seed(77)).publicKey.toBase58(), keeper: KEEPER.publicKey.toBase58() });
  const idx = (pred: (ix: NeutralIx) => boolean) => good.findIndex(pred);
  const isW = (tag: number) => (ix: NeutralIx) => ix.programId === PROGRAM.toBase58() && ix.data[0] === tag;
  const isS = (tag: number) => (ix: NeutralIx) => ix.programId === STAKE.toBase58() && ix.data[0] === tag;
  const clone = () => good.map((ix) => ({ ...ix, accounts: ix.accounts.map((a) => ({ ...a })), data: new Uint8Array(ix.data) }));
  const stranger = Keypair.fromSeed(seed(55)).publicKey.toBase58();
  beforeEach(async () => {
    await launch({ singleTx: true });
    good = neutralFromV1(decodeV1Message(splitV1Wire(sent[0]!).message));
  });

  it("positive control: the real bundle has no violation", () => {
    expect(launchBundleViolations(good, ctx())).toEqual([]);
  });
  it("keeper in a second account slot", () => {
    const b = clone();
    b[idx(isW(IX_TAG.TopUpInsurance))]!.accounts.push({ key: KEEPER.publicKey.toBase58(), signer: true, writable: false });
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/keeper appears in 2 account slots/);
  });
  it("createAccount funded by someone else", () => {
    const b = clone();
    b[0]!.accounts[0]!.key = stranger;
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/funded by/);
  });
  it("an unexpected signer", () => {
    const b = clone();
    b[idx(isW(IX_TAG.TopUpInsurance))]!.accounts.push({ key: stranger, signer: true, writable: false });
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/unexpected signer/);
  });
  it("exact shape: two instructions swapped that no ordering rule names", () => {
    const b = clone();
    const a = idx((ix) => ix.programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" && ix.data[0] === 1);
    [b[a], b[a + 1]] = [b[a + 1]!, b[a]!];
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/not the launch shape/);
  });
  it("a foreign program", () => {
    const b = clone();
    b[idx(isS(STAKE_IX.BindInsuranceAuthority))]!.programId = stranger;
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/not allowed/);
  });
  it("TopUpInsurance after Bind", () => {
    const b = clone();
    const [t] = b.splice(idx(isW(IX_TAG.TopUpInsurance)), 1);
    b.push(t!);
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/TopUpInsurance must precede/);
  });
  it("a marketauth-gated instruction after InitPool", () => {
    const b = clone();
    const [g] = b.splice(idx(isW(IX_TAG_P3.InitVaultLp)), 1);
    b.push(g!);
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/after stake\.InitPool/);
  });
  it("Bind before InitPool", () => {
    const b = clone();
    const p = idx(isS(STAKE_IX.InitPool));
    [b[p], b[p + 1]] = [b[p + 1]!, b[p]!];
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/must follow stake\.InitPool/);
  });
  it("an account used before its createAccount", () => {
    const b = clone();
    const create = b.filter((ix) => ix.programId === SystemProgram.programId.toBase58())[1]!;
    b[idx(isW(IX_TAG.TopUpInsurance))]!.accounts.push({ ...create.accounts[1]!, signer: false });
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/before ix \d+ creates it/);
  });
  it("authority epoch: TopUpInsurance still on epoch 0 after the hand-off", () => {
    const b = clone();
    const t = b[idx(isW(IX_TAG.TopUpInsurance))]!;
    t.data.set(new Uint8Array(8), 17);
    expect(launchBundleViolations(b, ctx()).join("|")).toMatch(/authority epoch 0 \(expected 1\)/);
  });
  it("v1 limits, one by one", () => {
    expect(v1LimitViolations({ bytes: 4096, accounts: 64, instructions: 64, signers: 12 })).toEqual([]);
    expect(v1LimitViolations({ bytes: 4097, accounts: 64, instructions: 64, signers: 12 })).toHaveLength(1);
    expect(v1LimitViolations({ bytes: 1, accounts: 65, instructions: 1, signers: 1 })).toHaveLength(1);
    expect(v1LimitViolations({ bytes: 1, accounts: 1, instructions: 65, signers: 1 })).toHaveLength(1);
    expect(v1LimitViolations({ bytes: 1, accounts: 1, instructions: 1, signers: 13 })).toHaveLength(1);
  });
});
