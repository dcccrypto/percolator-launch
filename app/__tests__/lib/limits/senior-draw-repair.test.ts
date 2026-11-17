// @vitest-environment node
/**
 * senior-draw-repair.ts: the 87 "crank first" path, the refusal outcomes of planSeniorDrawRepair,
 * recallCandidates / recallCu, and the real-connection deps. (The 88 recall happy path and the
 * pure builders are in senior-draw-39b138c8.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { decodeVaultLpState } from "@/lib/limits/decode";
import { REPAIR_CU } from "@/lib/self-heal";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { deriveVaultLpExt } from "@/lib/v21/sdk";
import { NAV_FLOW_COMPUTE_UNITS_V22 } from "@/lib/v22/sdk/v22-nav-flow";
import { marketOffsets } from "@/lib/v22/market-offsets";
import {
  connectionSeniorDrawRepairDeps,
  planSeniorDrawRepair,
  RECALL_CU,
  recallCandidates,
  recallCu,
} from "@/lib/limits/senior-draw-repair";
import { v22MarketBytes } from "../../helpers/v22-fixtures";

const k = () => Keypair.generate().publicKey;
const PROG = k();
const FX = join(__dirname, "..", "..", "fixtures");
const layouts = JSON.parse(readFileSync(join(FX, "limits", "rust-layouts.json"), "utf8"));
const BASE = isDevnetV22Enabled()
  ? v22MarketBytes()
  : new Uint8Array(Buffer.from(readFileSync(join(FX, "v18-liveness", "pengu-market-v18-healthy.b64"), "utf8").trim(), "base64"));
const M = marketOffsets(BASE);
/** The market with a bound (rustc-laid-out) AssetVaultLp record: the vault LP key is its first 32 bytes. */
const BOUND = (() => {
  const d = BASE.slice();
  d.set(Buffer.from(layouts.assetVaultLpHex, "hex"), M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF);
  return d;
})();
/** The same market with the AssetVaultLp record zeroed: explicitly unbound whatever the fixture holds. */
const UNBOUND = (() => {
  const d = BASE.slice();
  d.fill(0, M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF, M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF + C.ASSET_VAULT_LP_LEN);
  return d;
})();
const VAULT_LP = new PublicKey(BOUND.slice(M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF, M.wrapperOff(0) + C.ASSET_VAULT_LP_OFF + 32));

const vaultLpState = (claim: bigint): Uint8Array => {
  const vs = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
  vs[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
  vs[C.VS.version] = C.VAULT_LP_STATE_VERSION;
  new DataView(vs.buffer).setUint16(C.VS.juniorFloorBps, 1_000, true);
  new DataView(vs.buffer).setBigUint64(C.VS.seniorClaimAtoms, claim, true);
  return vs;
};

const err = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });
const op = (b: number[]) => new TransactionInstruction({ programId: PROG, keys: [], data: Buffer.from(b) });
const keys15 = () => Array.from({ length: 15 }, () => ({ pubkey: k(), isSigner: false, isWritable: true }));
const user = op([75, 0, 0]);

afterEach(() => {
  __setDevnetV21ForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("planSeniorDrawRepair: 87 draw-required", () => {
  const market = k();
  const cranker = k();
  const base = { programId: PROG, market, cranker, instructions: [user], computeUnits: 300_000 };
  // computeBudgetPrefix adds 2 ixs, so the user's ix is at list index 2.
  const fail87 = (n: number) => err(n - 1, 87);

  it("prepends the vault-LP crank, adds REPAIR_CU, and keeps it when the 87 is gone", async () => {
    const tail = [{ pubkey: k(), isSigner: false, isWritable: false }];
    const read = vi.fn(async () => BOUND);
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => ({ err: ixs.some((i) => i.data[0] === 5) ? null : fail87(ixs.length) }));
    const r = await planSeniorDrawRepair({ ...base, oracleTail: tail }, { read, simulate });
    expect(r.outcome).toBe("cranked");
    expect(r.computeUnits).toBe(300_000 + REPAIR_CU);
    expect(r.instructions).toHaveLength(2);
    expect(r.instructions[1]).toBe(user);
    const crank = r.instructions[0];
    expect(crank.data[0]).toBe(5);
    expect(crank.programId.equals(PROG)).toBe(true);
    const pks = crank.keys.map((m) => m.pubkey.toBase58());
    expect(pks.slice(0, 3)).toEqual([cranker, market, VAULT_LP].map((p) => p.toBase58()));
    expect(pks[pks.length - 1]).toBe(tail[0].pubkey.toBase58());
    expect(read).toHaveBeenCalledWith(market);
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("caps the repaired compute units at 1.4M", async () => {
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => ({ err: ixs.some((i) => i.data[0] === 5) ? null : fail87(ixs.length) }));
    const r = await planSeniorDrawRepair({ ...base, computeUnits: 1_399_000 }, { read: async () => BOUND, simulate });
    expect(r.computeUnits).toBe(1_400_000);
    expect(r.outcome).toBe("cranked");
  });

  it("a crank that still gets 87 => unchanged, repair-did-not-help", async () => {
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => ({ err: fail87(ixs.length) }));
    const r = await planSeniorDrawRepair(base, { read: async () => BOUND, simulate });
    expect(r).toEqual({ instructions: [user], computeUnits: 300_000, outcome: "repair-did-not-help" });
  });

  it("a crank that fails for another reason is still kept (the user sees the real error)", async () => {
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => ({ err: ixs.some((i) => i.data[0] === 5) ? err(2, 21) : fail87(ixs.length) }));
    const r = await planSeniorDrawRepair(base, { read: async () => BOUND, simulate });
    expect(r.outcome).toBe("cranked");
  });

  it("not-repairable when the market is unreadable or has no bound vault LP", async () => {
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => ({ err: fail87(ixs.length) }));
    expect((await planSeniorDrawRepair(base, { read: async () => null, simulate })).outcome).toBe("not-repairable");
    expect((await planSeniorDrawRepair(base, { read: async () => UNBOUND, simulate })).outcome).toBe("not-repairable");
    expect((await planSeniorDrawRepair(base, { read: async () => new Uint8Array(8), simulate })).outcome).toBe("not-repairable");
    expect(simulate).toHaveBeenCalledTimes(3); // only the original sim ran each time
  });
});

describe("planSeniorDrawRepair: early outcomes", () => {
  const p = { programId: PROG, market: k(), cranker: k(), instructions: [user], computeUnits: 200_000 };
  const read = async () => null;

  it("disabled by the kill switches: no simulation at all", async () => {
    const simulate = vi.fn();
    for (const [name, val] of [["NEXT_PUBLIC_VAULT_LP_SELF_HEAL", "off"], ["NEXT_PUBLIC_SELF_HEAL", "0"]] as const) {
      vi.stubEnv(name, val);
      const r = await planSeniorDrawRepair(p, { read, simulate });
      expect(r).toEqual({ instructions: p.instructions, computeUnits: 200_000, outcome: "disabled" });
      vi.unstubAllEnvs();
    }
    expect(simulate).not.toHaveBeenCalled();
  });

  it("a failure that is not 87/88/25, or comes from another program, is not-repairable", async () => {
    expect((await planSeniorDrawRepair(p, { read, simulate: async () => ({ err: err(2, 21) }) })).outcome).toBe("not-repairable");
    expect((await planSeniorDrawRepair(p, { read, simulate: async () => ({ err: "BlockhashNotFound" }) })).outcome).toBe("not-repairable");
    const foreign = { ...p, instructions: [new TransactionInstruction({ programId: k(), keys: [], data: Buffer.from([75]) })] };
    expect((await planSeniorDrawRepair(foreign, { read, simulate: async () => ({ err: err(2, 87) }) })).outcome).toBe("not-repairable");
  });

  it("88 on something that is not a bound 77 => not-repairable, no state read", async () => {
    const rd = vi.fn(async () => null);
    const sim = async () => ({ err: err(2, 88) });
    expect((await planSeniorDrawRepair(p, { read: rd, simulate: sim })).outcome).toBe("not-repairable"); // tag 75
    const unbound = { ...p, instructions: [new TransactionInstruction({ programId: PROG, keys: keys15().slice(0, 13), data: Buffer.from([77, 0, 0]) })] };
    expect((await planSeniorDrawRepair(unbound, { read: rd, simulate: sim })).outcome).toBe("not-repairable");
    expect(rd).not.toHaveBeenCalled();
  });

  it("an RPC/simulate failure never throws: rpc-error, unchanged, warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await planSeniorDrawRepair(p, { read, simulate: async () => { throw new Error("429"); } });
    expect(r).toEqual({ instructions: p.instructions, computeUnits: 200_000, outcome: "rpc-error" });
    expect(warn).toHaveBeenCalledOnce();
    const rd = async () => { throw new Error("down"); };
    const r2 = await planSeniorDrawRepair(p, { read: rd, simulate: async () => ({ err: err(2, 87) }) });
    expect(r2.outcome).toBe("rpc-error");
  });
});

describe("planSeniorDrawRepair: 88 redeem variants", () => {
  const ks = keys15();
  const market = k();
  ks[1] = { ...ks[1], pubkey: market }; // a real 77 carries the market at [1]
  const ix77 = new TransactionInstruction({ programId: PROG, keys: ks, data: Buffer.from([77, 0, 0]) });
  const p = { programId: PROG, market, cranker: k(), instructions: [ix77], computeUnits: 250_000 };
  const state = new Map<string, Uint8Array>([[ks[13].pubkey.toBase58(), vaultLpState(1n << 62n)]]);
  const read = async (pk: PublicKey) => (pk.equals(market) ? BASE : state.get(pk.toBase58()) ?? null);
  const has = (ixs: TransactionInstruction[], tag: number) => ixs.some((i) => i.data[0] === tag);

  it("the first variant, paying from the other pot, wins with no recall", async () => {
    // other-pot = the 77 with domain bit flipped (data [77,1,0]); fail everything else with 88.
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => {
      const i77 = ixs.find((i) => i.data[0] === 77)!;
      return { err: i77.data[1] === 1 && !has(ixs, 98) ? null : err(ixs.length - 1, 88) };
    });
    const r = await planSeniorDrawRepair(p, { read, simulate });
    expect(r.outcome).toBe("other-pot");
    expect(r.recallAtoms).toBeUndefined();
    expect(Array.from(r.instructions[0].data)).toEqual([77, 1, 0]);
    expect(r.instructions[0].keys).toBe(ks);
    expect(r.computeUnits).toBe(250_000 + recallCu());
  });

  it("recalls into the other pot when only that variant lands, reporting its amount", async () => {
    let amount = 0n;
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => {
      const rc = ixs.find((i) => i.data[0] === 98);
      const i77 = ixs.find((i) => i.data[0] === 77)!;
      if (rc && i77.data[1] === 1) {
        amount = Buffer.from(rc.data).readBigUInt64LE(1);
        return { err: null };
      }
      return { err: err(ixs.length - 1, 88) };
    });
    const r = await planSeniorDrawRepair(p, { read, simulate });
    expect(r.outcome).toBe("recalled");
    expect(r.recallAtoms).toBe(amount);
    expect(amount > 0n).toBe(true);
    expect(r.instructions.map((i) => i.data[0])).toEqual([98, 77]);
    expect(Buffer.from(r.instructions[0].data).readUInt16LE(17)).toBe(1);
  });

  it("v2.1: the 98 carries the P2b ext at [8] only when that account exists", async () => {
    __setDevnetV21ForTest(true);
    const ext = deriveVaultLpExt(PROG, market);
    const simulate = async (ixs: TransactionInstruction[]) => ({ err: has(ixs, 98) ? null : err(ixs.length - 1, 88) });
    const withExt = await planSeniorDrawRepair(p, {
      read: async (pk) => (pk.equals(ext) ? new Uint8Array(4) : read(pk)),
      simulate,
    });
    expect(withExt.outcome).toBe("recalled");
    const rc = withExt.instructions.find((i) => i.data[0] === 98)!;
    expect(rc.keys.some((m) => m.pubkey.equals(ext))).toBe(true);
    // v2.2 requires the ext at [8] (withNavFlowTailV22 throws without it => rpc-error), so the no-ext path is v2.1-only.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const noExt = await planSeniorDrawRepair(p, { read, simulate });
    if (isDevnetV22Enabled()) return expect(noExt.outcome).toBe("rpc-error");
    expect(noExt.outcome).toBe("recalled");
    expect(noExt.instructions.find((i) => i.data[0] === 98)!.keys.some((m) => m.pubkey.equals(ext))).toBe(false);
  });

  it("a missing vault-LP state account => not-repairable", async () => {
    const simulate = async (ixs: TransactionInstruction[]) => ({ err: err(ixs.length - 1, 88) });
    expect((await planSeniorDrawRepair(p, { read: async (pk) => (pk.equals(market) ? BASE : null), simulate })).outcome).toBe("not-repairable");
    expect((await planSeniorDrawRepair(p, { read: async () => null, simulate })).outcome).toBe("not-repairable");
  });

  it("no candidate amount (zero senior claim) still tries the other-pot variant, then gives up", async () => {
    const zero = new Map([[ks[13].pubkey.toBase58(), vaultLpState(0n)]]);
    const sims: number[] = [];
    const simulate = vi.fn(async (ixs: TransactionInstruction[]) => {
      sims.push(ixs.length);
      return { err: err(ixs.length - 1, 88) };
    });
    const r = await planSeniorDrawRepair(p, { read: async (pk) => (pk.equals(market) ? BASE : zero.get(pk.toBase58()) ?? null), simulate });
    expect(r).toEqual({ instructions: [ix77], computeUnits: 250_000, outcome: "repair-did-not-help" });
    expect(simulate).toHaveBeenCalledTimes(2); // original + other-pot only
  });
});

describe("recallCandidates", () => {
  const vs = decodeVaultLpState(vaultLpState(1n << 62n))!;

  it("is descending: the estimate, then 3/4, 1/2 and 1/4 of it, without duplicates", () => {
    const c = recallCandidates(BASE, vs, 0);
    expect(c.length).toBeGreaterThan(0);
    const est = c[0];
    expect(c).toEqual([est, (est * 3n) / 4n, est / 2n, est / 4n].filter((a, i, all) => a > 0n && all.indexOf(a) === i));
    for (let i = 1; i < c.length; i++) expect(c[i] < c[i - 1]).toBe(true);
  });

  it("caps at the vault LP's value (D-P3-30), and a zero value leaves no candidates", () => {
    const est = recallCandidates(BASE, vs, 0)[0];
    expect(recallCandidates(BASE, vs, 0, est + 1_000n)[0]).toBe(est);
    const capped = recallCandidates(BASE, vs, 0, 100n);
    expect(capped).toEqual([100n, 75n, 50n, 25n]);
    expect(recallCandidates(BASE, vs, 0, 0n)).toEqual([]);
    expect(recallCandidates(BASE, vs, 0, 3n)).toEqual([3n, 2n, 1n]); // 3n*3/4=2, 3/2=1, 3/4=0 dropped
  });

  it("an undecodable market yields no candidates", () => {
    expect(recallCandidates(new Uint8Array(16), vs, 0)).toEqual([]);
  });
});

describe("recallCu", () => {
  it("is the v2.2 NAV-flow budget on a v2.2 build, else the 120k margin", () => {
    expect(RECALL_CU).toBe(120_000);
    expect(recallCu()).toBe(isDevnetV22Enabled() ? NAV_FLOW_COMPUTE_UNITS_V22[98].units : 120_000);
  });
});

describe("connectionSeniorDrawRepairDeps", () => {
  const payer = k();

  it("read returns a copy of the account data, or null when the account is missing", async () => {
    const data = Buffer.from([1, 2, 3]);
    const getAccountInfo = vi.fn(async (pk: PublicKey) => (pk.equals(PROG) ? { data } : null));
    const deps = connectionSeniorDrawRepairDeps({ getAccountInfo } as never, payer);
    const got = await deps.read(PROG);
    expect(Array.from(got!)).toEqual([1, 2, 3]);
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(got)).toBe(false);
    expect(getAccountInfo).toHaveBeenCalledWith(PROG, "confirmed");
    expect(await deps.read(k())).toBeNull();
  });

  it("simulate compiles an unsigned tx for the payer and returns only { err }", async () => {
    const simulateTransaction = vi.fn(async () => ({ value: { err: err(0, 88), logs: ["x"] } }));
    const deps = connectionSeniorDrawRepairDeps({ simulateTransaction } as never, payer);
    const ix = new TransactionInstruction({ programId: PROG, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([77]) });
    const r = await deps.simulate([ix]);
    expect(r).toEqual({ err: err(0, 88) });
    const [vtx, opts] = simulateTransaction.mock.calls[0] as unknown as [{ message: { staticAccountKeys: PublicKey[]; compiledInstructions: { data: Uint8Array }[] } }, unknown];
    expect(vtx.message.staticAccountKeys[0].equals(payer)).toBe(true);
    expect(vtx.message.compiledInstructions).toHaveLength(1);
    expect(Array.from(vtx.message.compiledInstructions[0].data)).toEqual([77]);
    expect(opts).toEqual({ replaceRecentBlockhash: true, sigVerify: false, commitment: "confirmed" });
    simulateTransaction.mockResolvedValueOnce({ value: { err: null, logs: [] } });
    expect(await deps.simulate([ix])).toEqual({ err: null });
  });
});
