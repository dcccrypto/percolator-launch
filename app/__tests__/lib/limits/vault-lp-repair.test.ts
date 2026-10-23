// @vitest-environment node
/**
 * P3-L2 self-repair: an Earn deposit/redeem on a vault-owned-LP market whose vault LP has a
 * stale health certificate reverts VaultLpValuationStale (P3 Custom(85)). sendTx({vaultLpRepair})
 * prepends the permissionless crank of THE VAULT LP into the user's own tx — only when the
 * unmodified tx fails on exactly that; kill switch NEXT_PUBLIC_VAULT_LP_SELF_HEAL=0.
 * Market bytes: the captured v2.2 one-slot market with a Rust-laid-out bound AssetVaultLpV18 written at 896.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { sendTx } from "@/lib/tx";
import * as C from "@/lib/limits/constants";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { isValuationStaleFailure, planVaultLpRepair, type VaultLpRepairResult } from "@/lib/limits/vault-lp-repair";
import { afterLegsShift, blankPortfolio, v22MarketBytes } from "../../helpers/v22-fixtures";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";


const FX = join(__dirname, "..", "..", "fixtures");
const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MARKET = new PublicKey("ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ");
const SIG = bs58.encode(new Uint8Array(64).fill(7));
const layouts = JSON.parse(readFileSync(join(FX, "limits", "rust-layouts.json"), "utf8"));
// Flag on: the captured v2.2 (VERSION 19) one-slot market (helpers/v22-fixtures.ts); flag off: live PENGU (v18.2). The vault-LP record is the rustc-laid-out AssetVaultLpV18 (its offsets
// are identical in v22-rust-layout-aca02ba6.json, e.g. vault_lp_max_lev_bps @92), written at the slot's wrapper prefix +896.
const PENGU = isDevnetV22Enabled() ? v22MarketBytes() : new Uint8Array(Buffer.from(readFileSync(join(FX, "v18-liveness", "pengu-market-v18-healthy.b64"), "utf8").trim(), "base64"));
const M = marketOffsets(PENGU);

/** PENGU with a bound vault LP (key 0xAB..0xCD, from the rustc-laid-out fixture). */
const BOUND_MARKET = (() => {
  const d = PENGU.slice();
  d.set(Buffer.from(layouts.assetVaultLpHex, "hex"), M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF);
  return d;
})();
const VAULT_LP = new PublicKey(BOUND_MARKET.slice(M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF, M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF + 32));
const E = decodeMarketEngineView(BOUND_MARKET)!;

function vaultLpPortfolio(current: boolean): Uint8Array {
  const d = new Uint8Array(blankPortfolio());
  const v = new DataView(d.buffer);
  v.setBigUint64(C.PF_ACTIVE_BITMAP, 1n, true); // holds inventory
  if (current) {
    const c = C.PF_HEALTH_CERT + afterLegsShift();
    v.setBigUint64(c + C.CERT_ORACLE_EPOCH, E.oracleEpoch, true);
    v.setBigUint64(c + C.CERT_FUNDING_EPOCH, E.fundingEpoch, true);
    v.setBigUint64(c + C.CERT_RISK_EPOCH, E.riskEpoch, true);
    v.setBigUint64(c + C.CERT_ASSET_SET_EPOCH, E.assetSetEpoch, true);
    v.setBigUint64(c + C.CERT_ACTIVE_BITMAP, 1n, true);
    d[c + C.CERT_VALID] = 1;
  } else {
    d[C.PF_STALE_STATE + afterLegsShift()] = 1;
  }
  return d;
}

const earnIx = () =>
  new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: MARKET, isSigner: false, isWritable: true }], data: Buffer.from([75, 1, 0]) });

const isCrankOf = (data: Uint8Array | Buffer, accountKeys: PublicKey[], keyIdx: number[], vault: PublicKey) =>
  data[0] === 5 && accountKeys[keyIdx[2]]?.equals(vault);

function makeConn(market: Uint8Array, portfolio: Uint8Array, failCode = C.P3_ERR.VaultLpValuationStale) {
  const simulateTransaction = vi.fn(async (vtx: VersionedTransaction) => {
    const keys = vtx.message.staticAccountKeys;
    const ixs = vtx.message.compiledInstructions;
    const cranked = ixs.some((ix) => isCrankOf(ix.data, keys, ix.accountKeyIndexes, VAULT_LP));
    return { value: { err: cranked ? null : { InstructionError: [ixs.length - 1, { Custom: failCode }] }, logs: [] } };
  });
  return {
    rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    getAccountInfoAndContext: vi.fn().mockResolvedValue({ context: { slot: 505580400 }, value: { data: Buffer.from(market), owner: PROGRAM, lamports: 1, executable: false } }),
    getAccountInfo: vi.fn(async (pk: PublicKey) => ({ data: Buffer.from(pk.equals(MARKET) ? market : portfolio), owner: PROGRAM, lamports: 1, executable: false })),
    simulateTransaction,
    sendRawTransaction: vi.fn().mockResolvedValue(SIG),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] }),
  };
}
function makeWallet() {
  const kp = Keypair.generate();
  const signed: Transaction[] = [];
  return {
    signed,
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx: Transaction) => {
      tx.partialSign(kp);
      signed.push(tx);
      return tx;
    }),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("sendTx({ vaultLpRepair }) — P3-L2", () => {
  it("stale vault LP + tx fails 85 => the signed tx carries the vault-LP crank BEFORE the Earn ix, and lands", async () => {
    const conn = makeConn(BOUND_MARKET, vaultLpPortfolio(false));
    const wallet = makeWallet();
    let r: VaultLpRepairResult | undefined;
    const sig = await sendTx({
      connection: conn as never,
      wallet,
      instructions: [earnIx()],
      vaultLpRepair: { programId: PROGRAM, market: MARKET, oracleTail: [] },
      onVaultLpRepair: (x) => { r = x; },
    });
    expect(sig).toBe(SIG);
    expect(r?.outcome).toBe("repaired");
    const ixs = wallet.signed[0].instructions; // [heap, cuLimit, cuPrice, crank, earn]
    expect(ixs).toHaveLength(5);
    expect(ixs[3].data[0]).toBe(5);
    expect(ixs[3].keys[0].pubkey.equals(wallet.publicKey)).toBe(true); // user is the cranker
    expect(ixs[3].keys[2].pubkey.equals(VAULT_LP)).toBe(true); // the VAULT LP is cranked
    expect(ixs[4].data[0]).toBe(75);
  });

  it("NEGATIVE CONTROL: without the option the same tx is never repaired and fails", async () => {
    const conn = makeConn(BOUND_MARKET, vaultLpPortfolio(false));
    await expect(sendTx({ connection: conn as never, wallet: makeWallet(), instructions: [earnIx()] })).rejects.toThrow();
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: kill switch NEXT_PUBLIC_VAULT_LP_SELF_HEAL=0 (and the P0b switch) disables it", async () => {
    for (const [k, v] of [["NEXT_PUBLIC_VAULT_LP_SELF_HEAL", "0"], ["NEXT_PUBLIC_SELF_HEAL", "0"]] as const) {
      vi.unstubAllEnvs();
      vi.stubEnv(k, v);
      const conn = makeConn(BOUND_MARKET, vaultLpPortfolio(false));
      await expect(
        sendTx({ connection: conn as never, wallet: makeWallet(), instructions: [earnIx()], vaultLpRepair: { programId: PROGRAM, market: MARKET } }),
      ).rejects.toThrow();
      expect(conn.getAccountInfo).not.toHaveBeenCalled();
    }
  });
});

describe("planVaultLpRepair — only when needed", () => {
  const params = (instructions = [earnIx()]) => ({ programId: PROGRAM, market: MARKET, cranker: Keypair.generate().publicKey, instructions, computeUnits: 200_000 });
  const deps = (market: Uint8Array, pf: Uint8Array | null, err: unknown) => {
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => ({ err: ixs.some((ix) => ix.data[0] === 5) ? null : err }));
    return { readMarket: vi.fn(async () => market), readPortfolio: vi.fn(async () => pf), simulate };
  };
  const stale85 = { InstructionError: [2, { Custom: 85 }] };

  it("current certificate => no simulation at all", async () => {
    const d = deps(BOUND_MARKET, vaultLpPortfolio(true), stale85);
    expect((await planVaultLpRepair(params(), d)).outcome).toBe("valuation-current");
    expect(d.simulate).not.toHaveBeenCalled();
  });
  it("no bound vault LP (plain v18.2 market) => not-bound", async () => {
    expect((await planVaultLpRepair(params(), deps(PENGU, null, stale85))).outcome).toBe("not-bound");
  });
  it("stale but the user tx passes => untouched", async () => {
    expect((await planVaultLpRepair(params(), deps(BOUND_MARKET, vaultLpPortfolio(false), null))).outcome).toBe("user-tx-ok");
  });
  it("stale and the failure is NOT 85 (e.g. 74 impaired) => not repairable", async () => {
    const r = await planVaultLpRepair(params(), deps(BOUND_MARKET, vaultLpPortfolio(false), { InstructionError: [2, { Custom: 74 }] }));
    expect(r.outcome).toBe("not-repairable");
  });
  it("85 raised by ANOTHER program is not ours", () => {
    const other = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
    expect(isValuationStaleFailure({ InstructionError: [0, { Custom: 85 }] }, [other], PROGRAM)).toBe(false);
    expect(isValuationStaleFailure({ InstructionError: [0, { Custom: 85 }] }, [earnIx()], PROGRAM)).toBe(true);
  });
  it("crank does not clear it => repair-did-not-help (instructions unchanged)", async () => {
    const d = deps(BOUND_MARKET, vaultLpPortfolio(false), stale85);
    d.simulate.mockImplementation(async () => ({ err: stale85 }));
    const r = await planVaultLpRepair(params(), d);
    expect(r.outcome).toBe("repair-did-not-help");
    expect(r.instructions).toHaveLength(1);
  });
  it("RPC failure => unchanged", async () => {
    const d = deps(BOUND_MARKET, vaultLpPortfolio(false), stale85);
    d.readMarket.mockRejectedValue(new Error("429"));
    expect((await planVaultLpRepair(params(), d)).outcome).toBe("rpc-error");
  });
});
