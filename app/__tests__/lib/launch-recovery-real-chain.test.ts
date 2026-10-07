/**
 * #3267: the recovery against two REAL devnet launches (creation transactions captured read-only from
 * the public RPC, 2026-10-07). The expected request bodies are the ones recovered earlier from the same
 * memos (percolator-ops ledger recover-registrations-2026-10-07/requests.json), so a fixture built with
 * the launch's own code can't be the only thing proving this.
 *
 *   5Mv9Ne5…  neet / NotInEmploymentEducationTraining, pumpswap, 7.5x, 5 bps, LP 1,200
 *   BpFCMYF…  CARDS / Collector Crypt, meteora-dlmm, 5x, 30 bps, LP 1,100 (2,204 signatures: paged)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  canResumeLaunch,
  readCreationFromChain,
  reconstructRegistration,
  recoverLaunchFromChain,
  type CreationFacts,
  type RecoveryDeps,
} from "@/lib/launch-recovery";
import type { DexPoolResult } from "@/hooks/useDexPoolSearch";

const WRAPPER = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const CRANK = "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x";
const CREATOR = "9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa";
const COLLATERAL = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

const CASES = [
  {
    file: "5Mv9Ne.launch.json",
    slab: "5Mv9Ne533LahB3Tw7F97UpSvfnj4wJiSoiQT6o1Udh5X",
    ca: "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump",
    pool: "5wNu5QhdpRGrL37ffcd6TMMqZugQgxwafgz477rShtHy",
    dexType: "pumpswap" as const,
    meta: { symbol: "neet", name: "NotInEmploymentEducationTraining" },
    proofTx: "4oxcvLigYFbHpF4dtt2JAD7snkMgBCcaCUd5uiV2LeFesW338frgWm6HDrUTzTekfVeuRyEGWEbhkMD38QXvSU5N",
    memo: "percolator:keeper-register:v2:r5Cg0jbEDZP1oIYW9FuQGbo_txd8tO5HC5EMRGg5RkA",
    lp: 1_200_000_000n,
    payload: { decimals: 6, initial_price_e6: "38650", lp_collateral: "1200000000", max_leverage: 7.5, mint_address: COLLATERAL, name: "NotInEmploymentEducationTraining", oracle_authority: CRANK, oracle_mode: "keeper", symbol: "neet", trading_fee_bps: 5 },
  },
  {
    file: "BpFCMY.launch.json",
    slab: "BpFCMYFzNEWMR8hYhGy8xvD9a4yCSn5DtUQwe9VBRVxQ",
    ca: "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp",
    pool: "DL3WhGJRCuKJPcE95YRJxHbRer5ofqc6QzxEC1rRajK3",
    dexType: "meteora-dlmm" as const,
    meta: { symbol: "CARDS", name: "Collector Crypt" },
    proofTx: "hFxFPxKrhnrWKsLS5CmMYcYEdNqab2WKXqnYdqYeXzAzQoWAhGBwMgXGu36GDjgk3whQxVznTy3rbvD6pzPV6tc",
    memo: "percolator:keeper-register:v2:XFOpJnQ6xBJwJHwNItKgB7VAu_MenvD7ffHHFXIr_cs",
    lp: 1_100_000_000n,
    payload: { decimals: 6, initial_price_e6: "305300", lp_collateral: "1100000000", max_leverage: 5, mint_address: COLLATERAL, name: "Collector Crypt", oracle_authority: CRANK, oracle_mode: "keeper", symbol: "CARDS", trading_fee_bps: 30 },
  },
];

type Fixture = { slab: string; allSignatures: [string, boolean][]; txs: Record<string, { txBase64: string; err: unknown }> };
const load = (file: string): Fixture => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "relaunch", file), "utf8"));

/** A connection that replays the captured chain: paged signature lists, real serialized transactions. */
type MsgView = { staticAccountKeys: VersionedTransaction["message"]["staticAccountKeys"]; header: VersionedTransaction["message"]["header"]; compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] };
function replay(fx: Fixture, mutate?: (sig: string, msg: MsgView) => MsgView, missing: string[] = []) {
  return {
    getSignaturesForAddress: async (_pk: unknown, o: { limit?: number; before?: string }) => {
      const all = fx.allSignatures.map(([signature, ok]) => ({ signature, err: ok ? null : {} }));
      const start = o.before ? all.findIndex((s) => s.signature === o.before) + 1 : 0;
      return all.slice(start, start + (o.limit ?? 1000));
    },
    getTransaction: async (sig: string) => {
      if (missing.includes(sig)) return null;
      const t = fx.txs[sig];
      if (!t) return null;
      const vtx = VersionedTransaction.deserialize(Buffer.from(t.txBase64, "base64"));
      const m = vtx.message;
      const view: MsgView = { staticAccountKeys: m.staticAccountKeys, header: m.header, compiledInstructions: m.compiledInstructions.map((i) => ({ ...i })) };
      return { meta: { err: t.err }, transaction: { message: mutate ? mutate(sig, view) : view, signatures: vtx.signatures } };
    },
  };
}

const pool = (address: string, dexType: DexPoolResult["dexType"], base: string): DexPoolResult => ({
  poolAddress: address, dexId: dexType === "pumpswap" ? "pumpswap" : "meteora", dexType, dexLabel: String(dexType),
  pairLabel: `${base} / SOL`, baseSymbol: base, quoteSymbol: "SOL", liquidityUsd: 80_000, priceUsd: 1,
});

const deps = (c: (typeof CASES)[number], conn: unknown, pools: DexPoolResult[], over: Partial<RecoveryDeps> = {}): RecoveryDeps =>
  ({ connection: conn, wrapperProgramId: WRAPPER, crankWallet: CRANK, isDevnetEnv: true, searchPools: async () => ({ pools }), fetchMeta: async () => c.meta, ...over }) as never;

describe.each(CASES)("real launch $slab", (c) => {
  const fx = load(c.file);
  const input = { slab: c.slab, wallet: CREATOR, mainnetCA: c.ca };
  const decoys = [pool("11111111111111111111111111111112", "pumpswap", "DECOY"), pool(c.pool, c.dexType, c.meta.symbol)];

  it("reads the creation transaction (paging to the oldest signatures) and finds the memo", async () => {
    const r = await readCreationFromChain(replay(fx) as never, c.slab, WRAPPER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toMatchObject({ proofTx: c.proofTx, creator: CREATOR, memo: c.memo, collateralMint: COLLATERAL });
    expect(r.facts.depositAmounts).toContain(c.lp);
  });

  it("rebuilds the request the launch signed: identical body to the one recovered from the memo", async () => {
    const r = await recoverLaunchFromChain(deps(c, replay(fx), decoys), input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.launch.request).toMatchObject({ slabAddress: c.slab, mainnetCA: c.ca, dexPoolAddress: c.pool, dexType: c.dexType, symbol: c.meta.symbol, proofTx: c.proofTx });
    expect(r.launch.request.payload).toMatchObject(c.payload);
    expect(canResumeLaunch(r.launch)).toEqual({ ok: true });
  });

  // ── negatives ──
  it("a wrong token address does not verify", async () => {
    expect(await recoverLaunchFromChain(deps(c, replay(fx), decoys), { ...input, mainnetCA: Keypair.generate().publicKey.toBase58() })).toEqual({ ok: false, reason: "no-match" });
  });
  it("a wrong pool (the right one absent) does not verify", async () => {
    expect(await recoverLaunchFromChain(deps(c, replay(fx), [decoys[0]]), input)).toEqual({ ok: false, reason: "no-match" });
  });
  it("another wallet is refused", async () => {
    expect(await recoverLaunchFromChain(deps(c, replay(fx), decoys), { ...input, wallet: Keypair.generate().publicKey.toBase58() })).toEqual({ ok: false, reason: "not-your-market" });
  });

  describe("on the facts read from chain", () => {
    const facts = async (): Promise<CreationFacts> => {
      const r = await readCreationFromChain(replay(fx) as never, c.slab, WRAPPER);
      if (!r.ok) throw new Error("fixture must read");
      return r.facts;
    };
    const run = (f: CreationFacts, extra: Partial<Parameters<typeof reconstructRegistration>[0]> = {}) =>
      reconstructRegistration({ facts: f, mainnetCA: c.ca, pools: decoys, tokenMeta: c.meta, wrapperProgramId: WRAPPER, crankWallet: CRANK, isDevnetEnv: true, ...extra });

    it("a wrong LP amount does not verify", async () => {
      expect(await run({ ...(await facts()), depositAmounts: [c.lp + 1n] })).toBeNull();
    });
    it("a tampered memo does not verify", async () => {
      const f = await facts();
      const flipped = f.memo.slice(0, -1) + (f.memo.endsWith("A") ? "B" : "A");
      expect(await run({ ...f, memo: flipped })).toBeNull();
    });
    it("an extra deposit candidate cannot change the answer; the memo still selects the signed amount", async () => {
      const f = await facts();
      const r = await run({ ...f, depositAmounts: [999_000_000n, ...f.depositAmounts, 5n] });
      expect(r?.lpCollateralAtoms).toBe(c.lp);
    });
    it("an extra DepositCollateral instruction planted in the creation tx is just another candidate", async () => {
      const planted = replay(fx, (sig, m) => {
        if (sig !== c.proofTx) return m;
        const keys = m.staticAccountKeys.map((k) => k.toBase58());
        const prog = keys.indexOf(WRAPPER);
        const data = Buffer.alloc(33);
        data[0] = 3; // DepositCollateral
        data.writeBigUInt64LE(777_000_000n, 17);
        return { ...m, compiledInstructions: [...m.compiledInstructions, { programIdIndex: prog, accountKeyIndexes: [0, keys.indexOf(c.slab)], data }] };
      });
      const read = await readCreationFromChain(planted as never, c.slab, WRAPPER);
      expect(read.ok && read.facts.depositAmounts).toContain(777_000_000n);
      const r = await recoverLaunchFromChain(deps(c, planted, decoys), input);
      expect(r.ok && r.launch.lpCollateralAtoms).toBe(c.lp);
      expect(r.ok && r.launch.request.payload).toMatchObject(c.payload);
    });
    it("a creation tx the RPC lists but cannot return is an RPC problem, not 'no registration'", async () => {
      const r = await readCreationFromChain(replay(fx, undefined, [c.proofTx]) as never, c.slab, WRAPPER);
      expect(r).toEqual({ ok: false, reason: "rpc" });
    });
  });
});
