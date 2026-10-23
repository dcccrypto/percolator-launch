// @vitest-environment node
/**
 * UX WP-7 (WZ-1/WZ-2): the keeper-registration proof is a memo the creator signs INSIDE the
 * market-creation transaction (no signMessage prompt). SECURITY REVIEW REQUIRED before merge:
 * this replaces the H1v2 signed-message auth of /api/playground/keeper-register.
 *  - M1 (the heaviest config: keeper-priced P3 market, two signers, compute-budget prefix, the memo)
 *    fits a Solana packet (1232 B) — measured here on the exact builder the wizard sends.
 *  - AC3: the route's verifier accepts only (a) a successful tx, (b) exactly one registration
 *    memo, the one for THESE params incl. the payload digest (memo v2), (c) signed by the admin of
 *    the WRAPPER's InitMarket for this slab in the same tx (the P3 junior-owner path was removed,
 *    security review 2026-09-30 M-2); negative controls for each.
 */
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { deriveMarketParams } from "@/lib/market-params";
import { wizardP3Params } from "@/lib/limits/p3-wizard";
import { buildV17InitMarketArgs, slabSizeFor } from "@/lib/create-market-args";
import { buildM1Instructions } from "@/lib/create-market-m1";
import { buildBatchTx } from "@/lib/tx";
import {
  BOUND_PAYLOAD_FIELDS,
  KEEPER_REGISTER_MEMO_PREFIX,
  MEMO_PROGRAM_ID,
  boundPayloadSubset,
  buildKeeperRegisterMemoIx,
  isKeeperDexTypeOrEmpty,
  isTxSignature,
  keeperMemoParams,
  keeperRegisterMemoText,
  registrationPayloadDigest,
  validateRegistrationPayload,
  verifyKeeperRegisterProofTx,
} from "@/lib/keeper-register-memo";

const k = () => Keypair.generate().publicKey;
const PARAMS = {
  slabAddress: k().toBase58(),
  dexPoolAddress: k().toBase58(),
  mainnetCA: k().toBase58(),
  dexType: "meteora-dlmm",
  symbol: "LONGSYMBOL",
  label: "A very long human label for the market, as long as the wizard allows it to be",
};

async function m1(memo: boolean, wallet = Keypair.generate(), slab = Keypair.generate()) {
  const derived = deriveMarketParams(10, 1_000_000_000_000n, 1_000_000n);
  const params = { initialPriceE6: 1_000_000n, tradingFeeBps: 30, p3: wizardP3Params(true, 1_000_000_000n, 1000) };
  const programId = k();
  const ixs = buildM1Instructions({
    programId, wallet: wallet.publicKey, slab: slab.publicKey, mint: k(), vaultAta: k(), vaultPda: k(), nftRegistry: k(),
    slabRent: 1_000_000, slabSize: slabSizeFor(params as never), initArgs: buildV17InitMarketArgs(params, derived),
    memo: memo ? await buildKeeperRegisterMemoIx(wallet.publicKey, await keeperMemoParams({ ...PARAMS, slabAddress: slab.publicKey.toBase58() })) : null,
  });
  const tx = buildBatchTx({ instructions: ixs, computeUnits: 400_000, priorityFeeMicroLamports: 100_000, blockhash: "11111111111111111111111111111111", feePayer: wallet.publicKey });
  tx.sign(wallet, slab);
  return { tx, ixs, programId, wallet, slab };
}

describe("M1 with the memo fits one packet (heaviest wizard config)", () => {
  it("serialized size <= 1232 B", async () => {
    const without = (await m1(false)).tx.serialize().length;
    const withMemo = (await m1(true)).tx.serialize().length;
    if (process.env.MEASURE_OUT) (await import("node:fs")).writeFileSync(process.env.MEASURE_OUT, `M1 bytes: ${without} without the memo, ${withMemo} with it (limit 1232, headroom ${1232 - withMemo})\n`);
    expect(withMemo).toBeGreaterThan(without);
    expect(withMemo).toBeLessThanOrEqual(1232);
  });
  it("the memo is fixed-length whatever the label / symbol (a hash, not the fields)", async () => {
    const a = await keeperRegisterMemoText(PARAMS);
    const b = await keeperRegisterMemoText({ ...PARAMS, label: "x" });
    expect(a.startsWith(KEEPER_REGISTER_MEMO_PREFIX)).toBe(true);
    expect(a.length).toBe(b.length);
    expect(a).not.toBe(b);
  });
});

/** A landed-tx shape (what connection.getTransaction returns) from a signed legacy tx. */
function landed(tx: Transaction, err: unknown = null) {
  const msg = tx.compileMessage();
  return {
    meta: { err } as never,
    transaction: {
      message: {
        staticAccountKeys: msg.accountKeys,
        header: msg.header,
        compiledInstructions: msg.instructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: ix.accounts,
          data: Buffer.from(bs58.decode(ix.data)),
        })),
      },
    } as never,
  };
}

const WRAPPER = (programId: PublicKey) => programId.toBase58();

describe("AC3: the route's verifier (security review 2026-09-30 fixes applied)", () => {
  it("accepts a legacy null-payload creation memo but rejects a substituted payload", async () => {
    const { tx, programId, wallet, slab } = await m1(true);
    const request = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    const legacy = await keeperMemoParams({ ...request, payload: null });
    expect(validateRegistrationPayload(null)).toEqual({ ok: true, payload: null });
    expect(legacy.payloadDigest).toBe("");
    expect(await verifyKeeperRegisterProofTx(landed(tx), legacy, WRAPPER(programId)))
      .toEqual({ ok: true, creator: wallet.publicKey.toBase58() });
    const substituted = await keeperMemoParams({ ...request, payload: { name: "Late payload" } });
    expect((await verifyKeeperRegisterProofTx(landed(tx), substituted, WRAPPER(programId))).ok).toBe(false);
  });

  it("accepts the creator's M1 (wrapper InitMarket admin == memo signer) for exactly these params", async () => {
    const { tx, programId, wallet, slab } = await m1(true);
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    const v = await verifyKeeperRegisterProofTx(landed(tx), p, WRAPPER(programId));
    expect(v).toEqual({ ok: true, creator: wallet.publicKey.toBase58() });
  });
  it("NEGATIVE: a different pool (repointing) is refused", async () => {
    const { tx, programId, slab } = await m1(true);
    const v = await verifyKeeperRegisterProofTx(landed(tx), { ...PARAMS, slabAddress: slab.publicKey.toBase58(), dexPoolAddress: k().toBase58() }, WRAPPER(programId));
    expect(v.ok).toBe(false);
  });
  it("M-1: a different markets-row payload (digest) is refused", async () => {
    const { tx, programId, slab } = await m1(true);
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    const other = await keeperMemoParams({ ...p, payload: { name: "Official SOL Perp" } });
    expect((await verifyKeeperRegisterProofTx(landed(tx), other, WRAPPER(programId))).ok).toBe(false);
    expect(other.payloadDigest).not.toBe("");
  });
  it("NEGATIVE: a failed tx, a missing memo, a missing tx are refused", async () => {
    const { tx, programId, slab } = await m1(true);
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    expect((await verifyKeeperRegisterProofTx(landed(tx, { InstructionError: [3, { Custom: 1 }] }), p, WRAPPER(programId))).ok).toBe(false);
    const bare = await m1(false);
    expect((await verifyKeeperRegisterProofTx(landed(bare.tx), { ...PARAMS, slabAddress: bare.slab.publicKey.toBase58() }, WRAPPER(bare.programId))).ok).toBe(false);
    expect((await verifyKeeperRegisterProofTx(null, p, WRAPPER(programId))).ok).toBe(false);
  });
  it("L-1: an InitMarket-shaped tag 0 of any OTHER program (a sibling) is not the market's creation", async () => {
    const { tx, slab } = await m1(true);
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    const v = await verifyKeeperRegisterProofTx(landed(tx), p, k().toBase58());
    expect(v).toEqual({ ok: false, reason: "the proof transaction does not create this market" });
  });
  it("M-2: a memo signed in ANY other tx (e.g. by the P3 junior owner) is refused: no creation instruction", async () => {
    const junior = Keypair.generate();
    const slab = k();
    const p = { ...PARAMS, slabAddress: slab.toBase58() };
    const tx = new Transaction({ feePayer: junior.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(await buildKeeperRegisterMemoIx(junior.publicKey, p));
    tx.sign(junior);
    expect(await verifyKeeperRegisterProofTx(landed(tx), p, k().toBase58())).toEqual({ ok: false, reason: "the proof transaction does not create this market" });
  });
  it("M-2: at most ONE registration memo per creation tx (a creator cannot pre-sign alternative pools)", async () => {
    const wallet = Keypair.generate();
    const slab = Keypair.generate();
    const p = { ...PARAMS, slabAddress: slab.publicKey.toBase58() };
    const { ixs, programId } = await m1(true, wallet, slab);
    const alt = await buildKeeperRegisterMemoIx(wallet.publicKey, { ...p, dexPoolAddress: k().toBase58() });
    const tx = buildBatchTx({ instructions: [...ixs, alt], computeUnits: 400_000, priorityFeeMicroLamports: 1, blockhash: "11111111111111111111111111111111", feePayer: wallet.publicKey });
    tx.sign(wallet, slab);
    expect(await verifyKeeperRegisterProofTx(landed(tx), p, WRAPPER(programId))).toEqual({ ok: false, reason: "more than one registration memo in the proof transaction" });
  });
  it("NEGATIVE: the memo listing a non-signer account is refused", async () => {
    const a = Keypair.generate();
    const b = k();
    const p = { ...PARAMS, slabAddress: k().toBase58() };
    const memo = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: b, isSigner: false, isWritable: false }], data: Buffer.from(await keeperRegisterMemoText(p)) });
    const tx = new Transaction({ feePayer: a.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(memo);
    tx.sign(a);
    expect((await verifyKeeperRegisterProofTx(landed(tx), p, k().toBase58())).ok).toBe(false);
  });
});

describe("M-1 payload binding and L-2 / I-1 input checks", () => {
  const PAYLOAD = {
    mint_address: k().toBase58(), symbol: "TEST", name: "Test Token", decimals: 6, oracle_mode: "keeper",
    oracle_authority: k().toBase58(), initial_price_e6: "1000000", lp_collateral: "5000000000", max_leverage: 6.666666666666667, trading_fee_bps: 30,
    // not bound (the route never reads them from the payload)
    slab_address: k().toBase58(), deployer: k().toBase58(), dex_pool_address: k().toBase58(), mainnet_ca: null,
  };
  it("the digest covers every field the route writes, and only those", async () => {
    const base = await registrationPayloadDigest(boundPayloadSubset(PAYLOAD));
    for (const f of BOUND_PAYLOAD_FIELDS) {
      const changed = { ...PAYLOAD, [f]: typeof PAYLOAD[f] === "number" ? (PAYLOAD[f] as number) + 1 : f === "name" || f === "symbol" ? "OTHER" : k().toBase58() };
      expect(await registrationPayloadDigest(boundPayloadSubset(changed)), f).not.toBe(base);
    }
    expect(await registrationPayloadDigest(boundPayloadSubset({ ...PAYLOAD, deployer: k().toBase58() }))).toBe(base);
    expect(await registrationPayloadDigest(null)).toBe("");
  });
  it("the digest survives the JSON round trip the request makes (client == route)", async () => {
    const wire = JSON.parse(JSON.stringify(PAYLOAD)) as Record<string, unknown>;
    const v = validateRegistrationPayload(wire);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(await registrationPayloadDigest(v.payload)).toBe(await registrationPayloadDigest(boundPayloadSubset(PAYLOAD)));
  });
  it("payload fields are shape-checked", () => {
    expect(validateRegistrationPayload(PAYLOAD).ok).toBe(true);
    for (const bad of [
      { mint_address: "not-a-key" }, { oracle_authority: 7 }, { decimals: 6.5 }, { decimals: "6" }, { max_leverage: 0 }, { max_leverage: "10" },
      { trading_fee_bps: 10_001 }, { initial_price_e6: "1e6" }, { lp_collateral: -1 }, { oracle_mode: "chainlink" }, { symbol: "$WIF" }, { name: "a\u0000b" },
    ]) {
      expect(validateRegistrationPayload({ ...PAYLOAD, ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateRegistrationPayload([]).ok).toBe(false);
    expect(validateRegistrationPayload(null)).toEqual({ ok: true, payload: null });
  });
  it("L-2: proofTx must be a base58 64-byte signature", () => {
    expect(isTxSignature(bs58.encode(new Uint8Array(64).fill(9)))).toBe(true);
    for (const v of ["sig", "", 42, null, bs58.encode(new Uint8Array(32).fill(9)), "0OIl".repeat(22)]) expect(isTxSignature(v), String(v)).toBe(false);
  });
  it("I-1: only the keeper's dex vocabulary", () => {
    for (const v of [null, undefined, "", "meteora-dlmm", "pumpswap", "raydium-clmm"]) expect(isKeeperDexTypeOrEmpty(v)).toBe(true);
    for (const v of ["meteora", "raydium", "x\u001Fy", 5]) expect(isKeeperDexTypeOrEmpty(v)).toBe(false);
  });
});

void PublicKey;
