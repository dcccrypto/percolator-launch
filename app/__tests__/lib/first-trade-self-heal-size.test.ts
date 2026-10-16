// @vitest-environment node
/**
 * Review follow-up to #3445: the self-heal size guard against the REAL first-trade list.
 *
 * tx-self-heal-size-guard.test.ts mocks planSelfHeal and uses a synthetic user ix. Here nothing about the heal is mocked:
 * the user list is the real [CreateAccount, InitPortfolio, Deposit, TradeCpi] (lib/first-trade.ts builders, the largest
 * transaction the app signs, two signers), the market bytes are a captured fixture with its engine clock pushed `k`
 * accrual windows behind, and lib/self-heal.ts planSelfHeal plans the catch-up cranks + liveness repairs itself. sendTx
 * then applies the 1232-byte guard. Asserted on the transaction the wallet is actually asked to sign (serialized, both
 * signatures). Runs under both flag modes: each case pins its own flag (the v2.1 fixture with the flag off, the v2.2
 * fixture with it on), so NEXT_PUBLIC_DEVNET_V22 in the environment does not matter (branch convention, 02e50adc).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { SimulationRefusal, sendTx } from "@/lib/tx";
import { buildFirstTradeInitIxs, buildFundAndTradeIxs } from "@/lib/first-trade";
import { FIRST_TRADE_CU_CAP } from "@/hooks/useFirstTrade";
import { buildCatchUpCrankIx, planCatchUp, planSelfHeal, connectionSelfHealDeps, EXPIRE_BACKING_BUCKET_TAG, FINALIZE_RESET_SIDE_TAG } from "@/lib/self-heal";
import type { SelfHealResult } from "@/lib/self-heal";
import { finalTxWireSize, PACKET_DATA_SIZE } from "@/lib/limits/resolved-topup";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";

const SIG = bs58.encode(new Uint8Array(64).fill(5));
const CRANK_TAG = 5;
const pk = () => Keypair.generate().publicKey;
const readB64 = (p: string): Uint8Array => new Uint8Array(Buffer.from(readFileSync(join(__dirname, "..", p), "utf8").trim(), "base64"));

/** One captured market per flag mode (v2.1 bytes only decode with the flag off; v2.2 bytes only with it on). */
const FLAVOURS = [
  { name: "v2.1 market fixture, flag off", v22: false, load: () => readB64("fixtures/v18-liveness/paid-market-v18-lapsed.b64") },
  {
    name: "v2.2 market fixture, flag on",
    v22: true,
    load: () => new Uint8Array(Buffer.from((JSON.parse(readFileSync(join(__dirname, "..", "fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: { SOL: { marketB64: string } } }).markets.SOL.marketB64, "base64")),
  },
] as const;

const NOW = 600_000_000n;

/** Push asset 0's engine clock behind `NOW` by exactly `k` accrual windows (planCatchUp then plans k cranks). */
function lagged(base: Uint8Array, k: number): Uint8Array {
  const d = new Uint8Array(base);
  const dt = planCatchUp(d, NOW, 0).dtSlots;
  if (dt === null) throw new Error("fixture has no max_accrual_dt_slots");
  const M = marketOffsets(d);
  new DataView(d.buffer).setBigUint64(M.engineOff(0) + 41, NOW - BigInt(k) * dt, true);
  const planned = planCatchUp(d, NOW, 0);
  if (planned.k !== k) throw new Error(`fixture lag helper: wanted k=${k}, planCatchUp says ${planned.k}`);
  return d;
}

const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const market = pk();
const lpPortfolio = pk();
const oracle = pk();

function setup(marketData: Uint8Array, opts: { engineOkUnhealed?: boolean } = {}) {
  const kp = Keypair.generate();
  const portfolioKp = Keypair.generate();
  const signed: Transaction[] = [];
  const conn = {
    rpcEndpoint: "https://api.devnet.solana.com",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1e7 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
    getAccountInfoAndContext: vi.fn().mockResolvedValue({ context: { slot: Number(NOW) }, value: { data: Buffer.from(marketData), owner: PROGRAM, lamports: 1, executable: false } }),
    // The engine refuses (Custom 21 at the last wrapper ix) until a catch-up crank (tag 5) is in the list.
    simulateTransaction: vi.fn(async (vtx: VersionedTransaction) => {
      const ixs = vtx.message.compiledInstructions;
      const healed = opts.engineOkUnhealed === true || ixs.some((ix) => ix.data[0] === CRANK_TAG);
      return { value: { err: healed ? null : { InstructionError: [ixs.length - 1, { Custom: 21 }] }, logs: [], unitsConsumed: 300_000 } };
    }),
    sendRawTransaction: vi.fn(async () => SIG),
    getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map((s) => (s === SIG ? { confirmationStatus: "confirmed", err: null } : null)) })),
  };
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx: Transaction) => {
      signed.push(tx);
      tx.partialSign(kp);
      return tx;
    }),
  };
  /** The REAL first-trade list, with extreme (largest-encoding) values like first-trade-single-tx-size.test.ts. */
  const userIxs = (): TransactionInstruction[] => {
    const p = {
      programId: PROGRAM, owner: kp.publicKey, market, portfolio: portfolioKp.publicKey, userAta: pk(), vaultTokenAta: pk(), depositAtoms: 123_456_789_012n,
      lp: { accountB: lpPortfolio, matcherProg: pk(), matcherCtx: pk(), matcherDelegate: pk() },
      lpId: { portfolioId: 2n ** 40n, positionEpoch: 2n ** 40n, matcherSequence: 2n ** 40n },
      marketId: 2n ** 40n, size: -(2n ** 60n), limitPriceE6: 2n ** 50n, feeBps: 50n, marketTradeFeeBps: 5n,
    };
    return [...buildFirstTradeInitIxs(p, 10_000_000), ...buildFundAndTradeIxs(p, { portfolioId: 2n ** 40n, sequence: 0n, positionEpoch: 0n })];
  };
  const send = async () => {
    let heal: SelfHealResult | undefined;
    const ixs = userIxs();
    let error: unknown = null;
    try {
      await sendTx({
        connection: conn as never, wallet, instructions: ixs, signers: [portfolioKp], computeUnitsFromSim: { cap: FIRST_TRADE_CU_CAP },
        selfHeal: { programId: PROGRAM, market, catchUp: { portfolio: lpPortfolio, oracleTail: [{ pubkey: oracle, isSigner: false, isWritable: false }] } },
        onSelfHeal: (r) => { heal = r; },
      });
    } catch (e) {
      error = e;
    }
    const tx = signed[signed.length - 1];
    return { heal, tx, error, wireBytes: tx ? tx.serialize().length : 0, userIxs: ixs };
  };
  return { conn, wallet, signed, send, feePayer: kp.publicKey, userIxs };
}

const tagsOf = (tx: Transaction): number[] => tx.instructions.filter((ix) => ix.programId.equals(PROGRAM)).map((ix) => ix.data[0]);

describe.each(FLAVOURS)("first-trade self-heal size guard ($name)", (fl) => {
  beforeEach(() => __setDevnetV22ForTest(fl.v22));
  afterEach(() => __setDevnetV22ForTest(null));

  /** Largest k whose healed list is still <= 1232 B, and the first k that is not (by the real planner + size function). */
  async function boundary(): Promise<{ maxFit: number; firstOver: number | null }> {
    let maxFit = 0;
    for (let k = 1; k <= 40; k++) {
      const data = lagged(fl.load(), k);
      const s = setup(data);
      const heal = await planSelfHeal(
        { programId: PROGRAM, market, instructions: s.userIxs(), computeUnits: FIRST_TRADE_CU_CAP, catchUp: { cranker: s.feePayer, portfolio: lpPortfolio, oracleTail: [{ pubkey: oracle, isSigner: false, isWritable: false }] } },
        connectionSelfHealDeps(s.conn as never, market, s.feePayer),
      );
      if (heal.outcome !== "repaired") return { maxFit, firstOver: null }; // beyond the CU cap: planner declines before the size question
      expect(heal.catchUpCranks).toBe(k);
      // finalTxWireSize counts the portfolio keypair as a signer (the init ix lists it as one), as the real send does.
      if (finalTxWireSize(heal.instructions, s.feePayer) > PACKET_DATA_SIZE) return { maxFit, firstOver: k };
      maxFit = k;
    }
    return { maxFit, firstOver: null };
  }

  it("heal applied: the real first-trade list plus k catch-up cranks (every k that fits) is signed at <= 1232 B, cranks + repairs first", async () => {
    const { maxFit } = await boundary();
    expect(maxFit).toBeGreaterThanOrEqual(1);
    for (const k of new Set([1, 2, maxFit])) {
      const s = setup(lagged(fl.load(), k));
      const { heal, tx, wireBytes, userIxs } = await s.send();
      expect(heal?.outcome).toBe("repaired");
      expect(heal?.catchUpCranks).toBe(k);
      expect(wireBytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const tags = tagsOf(tx);
      // [crank x k][ExpireBackingBucket / FinalizeResetSide repairs][CreateAccount is system][InitPortfolio][Deposit][TradeCpi]
      expect(tags.slice(0, k)).toEqual(Array(k).fill(CRANK_TAG));
      const userTagsSigned = tags.slice(tags.length - userIxs.filter((i) => i.programId.equals(PROGRAM)).length);
      expect(userTagsSigned).toEqual(userIxs.filter((i) => i.programId.equals(PROGRAM)).map((i) => i.data[0]));
      for (const t of tags.slice(k, tags.length - userTagsSigned.length)) expect([EXPIRE_BACKING_BUCKET_TAG, FINALIZE_RESET_SIDE_TAG]).toContain(t);
    }
  });

  it("heal oversize, engine still refusing: the repairs are dropped, the UNCHANGED list is re-simulated and refused before the wallet opens", async () => {
    const { maxFit, firstOver } = await boundary();
    // The planner's CU cap must not stop it before the packet does, else no oversize heal is reachable for this fixture.
    expect(firstOver, `no oversize k found (maxFit=${maxFit})`).not.toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup(lagged(fl.load(), firstOver!));
    const { heal, error, userIxs } = await s.send();
    expect(heal?.outcome).toBe("oversize");
    expect(heal?.repairs).toEqual([]);
    expect(heal?.catchUpCranks).toBe(0);
    expect(heal?.instructions).toEqual(userIxs);
    expect(error).toBeInstanceOf(SimulationRefusal);
    expect(s.wallet.signTransaction).not.toHaveBeenCalled();
    const lastSim = s.conn.simulateTransaction.mock.calls.at(-1)![0] as VersionedTransaction;
    expect(lastSim.message.compiledInstructions.some((ix) => ix.data[0] === CRANK_TAG)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/do not fit one transaction/));
    warn.mockRestore();
  });

  it("heal oversize, engine caught up meanwhile: the wallet is asked to sign exactly the user's own list (<= 1232 B, no cranks)", async () => {
    const { firstOver } = await boundary();
    expect(firstOver).not.toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The first-pass simulation of the unchanged list must fail for planSelfHeal to build a heal at all, so refuse once, then accept.
    const s = setup(lagged(fl.load(), firstOver!));
    let first = true;
    const refuse = s.conn.simulateTransaction.getMockImplementation()!;
    s.conn.simulateTransaction.mockImplementation(async (vtx: VersionedTransaction) => {
      if (first) { first = false; return refuse(vtx); }
      return { value: { err: null, logs: [], unitsConsumed: 300_000 } };
    });
    const { heal, tx, error, wireBytes, userIxs } = await s.send();
    expect(error).toBeNull();
    expect(heal?.outcome).toBe("oversize");
    expect(tagsOf(tx)).toEqual(userIxs.filter((i) => i.programId.equals(PROGRAM)).map((i) => i.data[0]));
    expect(wireBytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    warn.mockRestore();
  });

  it("the boundary is real: the planner's own healed list at firstOver is over the packet, at maxFit it is not", async () => {
    const { maxFit, firstOver } = await boundary();
    const data = lagged(fl.load(), maxFit);
    const s = setup(data);
    const base = s.userIxs();
    const cranks = Array.from({ length: maxFit }, () => buildCatchUpCrankIx(PROGRAM, s.feePayer, market, lpPortfolio, [{ pubkey: oracle, isSigner: false, isWritable: false }]));
    expect(finalTxWireSize([...cranks, ...base], s.feePayer)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    if (firstOver !== null) {
      const more = [...cranks, buildCatchUpCrankIx(PROGRAM, s.feePayer, market, lpPortfolio, [{ pubkey: oracle, isSigner: false, isWritable: false }])];
      expect(finalTxWireSize([...more, ...base], s.feePayer)).toBeGreaterThan(PACKET_DATA_SIZE);
    }
  });
});
