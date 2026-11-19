// @vitest-environment node
/**
 * loadResolvedExitSnapshot / readViewerTopupIxs / readEmptyCloseIxs driven by REAL decoded market, registry,
 * vault-LP-state and portfolio bytes (no decoder mocks). Asserts the plan (what a user can exit with), the ctx and
 * the "never throws" fallbacks. The v2.2 tails read (flag on) failing must leave NO tails: the step is then refused
 * by the instruction builder rather than sent with a guess (no amount is ever computed from the tails).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { blankMarket, blankPortfolio } from "../../helpers/v22-fixtures";

const h = vi.hoisted(() => ({ fetchTails: vi.fn(), identityThrows: new Set<number>(), call: 0 }));
vi.mock("@/lib/v22/market-tails", async (orig) => ({ ...(await orig<object>()), fetchMarketTailsV22: (...a: unknown[]) => h.fetchTails(...a) }));
vi.mock("@/lib/v18-wire", async (orig) => {
  const o = await orig<typeof import("@/lib/v18-wire")>();
  return {
    ...o,
    readPortfolioIdentity: (d: Uint8Array) => {
      if (d[0x20] === 0xee && d[0x21] === 0xee) throw new Error("bad identity");
      return o.readPortfolioIdentity(d);
    },
  };
});

import {
  emptyCloseSteps,
  loadResolvedExitSnapshot,
  readEmptyCloseIxs,
  readViewerTopupIxs,
} from "@/lib/limits/resolved-exit-load";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { deriveLpVaultRegistryPda, deriveVaultLpState } from "@/lib/limits/p3-ix";
import { deriveVaultLpExt } from "@/lib/v21/sdk";

const k = () => Keypair.generate().publicKey;
const PROG = k();
const MARKET = k();
const MINT = k();
const REGISTRY = deriveLpVaultRegistryPda(PROG, MARKET);
const VLP_STATE = deriveVaultLpState(PROG, MARKET);
const EXT = deriveVaultLpExt(PROG, MARKET);
const [OFF_CURVE] = PublicKey.findProgramAddressSync([Buffer.from("escrow")], PROG);

function marketBytes(mode: number, o: { count?: bigint; cTot?: bigint; delay?: bigint } = {}): Uint8Array {
  const d = blankMarket();
  const v = new DataView(d.buffer);
  const M = marketOffsets(d);
  d[M.hdr(C.H_MODE)] = mode;
  v.setBigUint64(M.hdr(C.H_C_TOT), o.cTot ?? 0n, true);
  v.setBigUint64(M.hdr(C.H_MATERIALIZED_PORTFOLIO_COUNT), o.count ?? 0n, true);
  v.setBigUint64(M.hdr(C.H_RESOLVED_SLOT), 100n, true);
  v.setBigUint64(C.HEADER_LEN + C.WCFG_FORCE_CLOSE_DELAY_SLOTS, o.delay ?? 0n, true);
  return d;
}
function portfolioBytes(owner: PublicKey, capital: bigint): Uint8Array {
  const d = new Uint8Array(blankPortfolio());
  d[C.HEADER_KIND_OFF] = C.KIND_PORTFOLIO;
  d.set(owner.toBytes(), C.PF_OWNER);
  if (capital > 0n) new DataView(d.buffer).setBigUint64(C.PF_CAPITAL, capital, true);
  return d;
}
function registryBytes(bound: boolean, domain = 0): Uint8Array {
  const d = new Uint8Array(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
  d[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
  d[C.REG_VAULT_LP_BOUND_FLAG] = bound ? 1 : 0;
  new DataView(d.buffer).setUint16(C.REG_DOMAIN, domain, true);
  return d;
}
function vaultStateBytes(lp: PublicKey, junior: PublicKey): Uint8Array {
  const d = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
  const v = new DataView(d.buffer);
  d[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
  v.setUint16(C.VS.version, C.VAULT_LP_STATE_VERSION, true);
  v.setUint16(C.VS.juniorFloorBps, C.VAULT_LP_MIN_JUNIOR_FLOOR_BPS, true);
  d.set(lp.toBytes(), C.VS.lpPortfolio);
  d.set(junior.toBytes(), C.VS.juniorOwner);
  return d;
}

interface World {
  market?: Uint8Array | null;
  registry?: Uint8Array | null;
  state?: Uint8Array | null;
  ext?: boolean;
  pfs?: { pubkey: PublicKey; data: Uint8Array }[];
}
function conn(w: World): Connection {
  const info = (data: Uint8Array | null | undefined, owner: PublicKey = PROG) => (data ? { data: Buffer.from(data), owner, lamports: 1, executable: false } : null);
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => {
      if (key.equals(MARKET)) return info(w.market);
      if (key.equals(REGISTRY)) return info(w.registry);
      if (key.equals(VLP_STATE)) return info(w.state);
      if (key.equals(EXT)) return w.ext ? info(Buffer.alloc(8)) : null;
      return null;
    }),
    getSlot: vi.fn(async () => 1_000),
    getProgramAccounts: vi.fn(async () => (w.pfs ?? []).map((p) => ({ pubkey: p.pubkey, account: info(p.data)! }))),
  } as unknown as Connection;
}
const load = (c: Connection, payer: PublicKey | null = k()) => loadResolvedExitSnapshot({ connection: c, programId: PROG, market: MARKET, collateralMint: MINT, payer });

const TAILS = { bondTranche: k(), insuranceUnits: k(), vaultLpExt: null };
beforeEach(() => {
  __setDevnetV22ForTest(true);
  h.fetchTails.mockReset();
  h.fetchTails.mockResolvedValue(TAILS);
});
afterEach(() => {
  __setDevnetV22ForTest(null);
  __setDevnetV21ForTest(null);
});

describe("loadResolvedExitSnapshot: early exits", () => {
  it("no market account: null", async () => {
    expect(await load(conn({ market: null }))).toBeNull();
  });
  it("undecodable market bytes: not-resolved, no ctx", async () => {
    const s = await load(conn({ market: new Uint8Array(32) }));
    expect(s).toEqual({ plan: { phase: "not-resolved" }, ctx: null, portfolios: [], bound: false, nowSlot: 0n });
  });
  it("live (non-resolved) market: not-resolved, no ctx", async () => {
    const s = await load(conn({ market: marketBytes(0) }));
    expect(s?.plan).toEqual({ phase: "not-resolved" });
    expect(s?.ctx).toBeNull();
  });
});

describe("loadResolvedExitSnapshot: resolved, unbound", () => {
  it("terminal-flat market with no portfolios: ready, ctx carries tails, no vault", async () => {
    const s = await load(conn({ market: marketBytes(C.MARKET_MODE_RESOLVED), registry: registryBytes(false) }));
    expect(s?.plan).toEqual({ phase: "ready", blockers: [] });
    expect(s?.bound).toBe(false);
    expect(s?.nowSlot).toBe(1_000n);
    expect(s?.ctx?.vault).toBeNull();
    expect(s?.ctx?.tails).toBe(TAILS);
    expect(s?.ctx?.payer).toBeDefined();
  });
  it("no payer (read-only): the market key pays", async () => {
    const s = await load(conn({ market: marketBytes(C.MARKET_MODE_RESOLVED) }), null);
    expect(s?.ctx?.payer.equals(MARKET)).toBe(true);
  });
  it("registry owned by another program is ignored (not bound)", async () => {
    const c = conn({ market: marketBytes(C.MARKET_MODE_RESOLVED), registry: registryBytes(true) });
    (c.getAccountInfo as ReturnType<typeof vi.fn>).mockImplementation(async (key: PublicKey) =>
      key.equals(MARKET)
        ? { data: Buffer.from(marketBytes(C.MARKET_MODE_RESOLVED)), owner: PROG, lamports: 1, executable: false }
        : key.equals(REGISTRY)
          ? { data: Buffer.from(registryBytes(true)), owner: k(), lamports: 1, executable: false }
          : null,
    );
    const s = await load(c);
    expect(s?.bound).toBe(false);
    expect(s?.ctx?.vault).toBeNull();
  });
  it("trader with capital, an empty portfolio, an escrowed (off-curve) one: steps and blockers", async () => {
    const trader = k();
    const emptyOwner = k();
    const [pT, pE, pX] = [k(), k(), k()];
    const s = await load(
      conn({
        market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 3n, cTot: 500n }),
        registry: registryBytes(false),
        pfs: [
          { pubkey: pT, data: portfolioBytes(trader, 500n) },
          { pubkey: pE, data: portfolioBytes(emptyOwner, 0n) },
          { pubkey: pX, data: portfolioBytes(OFF_CURVE, 7n) },
        ],
      }),
    );
    expect(s?.plan).toEqual({
      phase: "sweep",
      steps: [
        { kind: "close-resolved", portfolio: pT.toBase58() },
        { kind: "close-empty", portfolio: pE.toBase58(), isVaultLp: false },
      ],
      blockers: [{ kind: "escrowed", portfolio: pX.toBase58() }],
    });
    expect(s?.portfolios.map((p) => [p.key, p.escrowed])).toEqual([
      [pT.toBase58(), false],
      [pE.toBase58(), false],
      [pX.toBase58(), true],
    ]);
    expect(s?.ctx?.portfolios.size).toBe(3);
    expect(s?.ctx?.portfolios.get(pT.toBase58())?.owner.equals(trader)).toBe(true);
  });
  it("owner window: the trader waits (ownersPending), empties still close", async () => {
    const [pT, pE] = [k(), k()];
    const s = await load(
      conn({
        market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 2n, cTot: 500n, delay: 100_000n }),
        pfs: [
          { pubkey: pT, data: portfolioBytes(k(), 500n) },
          { pubkey: pE, data: portfolioBytes(k(), 0n) },
        ],
      }),
    );
    expect(s?.plan).toMatchObject({ phase: "owner-window", untilSlot: 100_100n, ownersPending: 1, blockers: [] });
    expect(s?.plan.phase === "owner-window" && s.plan.steps).toEqual([{ kind: "close-empty", portfolio: pE.toBase58(), isVaultLp: false }]);
  });
  it("skips non-portfolio kinds, undecodable and identity-less accounts", async () => {
    const wrongKind = portfolioBytes(k(), 5n);
    wrongKind[10] = 99;
    const short = new Uint8Array(40);
    short[10] = C.KIND_PORTFOLIO;
    const badIdentity = portfolioBytes(k(), 5n);
    badIdentity[0x20] = 0xee;
    badIdentity[0x21] = 0xee;
    const good = k();
    const s = await load(
      conn({
        market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 1n, cTot: 5n }),
        pfs: [
          { pubkey: k(), data: wrongKind },
          { pubkey: k(), data: short },
          { pubkey: k(), data: badIdentity },
          { pubkey: good, data: portfolioBytes(k(), 5n) },
        ],
      }),
    );
    expect(s?.portfolios.map((p) => p.key)).toEqual([good.toBase58()]);
  });
});

describe("loadResolvedExitSnapshot: bound vault", () => {
  const vlp = k();
  const junior = k();
  const base = (extra: Partial<World> = {}): World => ({
    market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 1n, cTot: 900n }),
    registry: registryBytes(true, 1),
    state: vaultStateBytes(vlp, junior),
    pfs: [{ pubkey: vlp, data: portfolioBytes(REGISTRY, 900n) }],
    ...extra,
  });
  it("vault LP is flagged, not escrowed; its 101 settle is planned; ctx.vault has both ledgers and no ext", async () => {
    const s = await load(conn(base()), k());
    expect(s?.bound).toBe(true);
    expect(s?.portfolios).toHaveLength(1);
    expect(s?.portfolios[0]).toMatchObject({ key: vlp.toBase58(), isVaultLp: true, escrowed: false });
    expect(s?.plan).toEqual({ phase: "sweep", steps: [{ kind: "settle-vault-lp", topup: 0, portfolio: vlp.toBase58() }], blockers: [] });
    expect(s?.ctx?.vault).toMatchObject({ domain: 1, juniorOwner: junior, lpPortfolio: vlp, registry: REGISTRY, vaultLpState: VLP_STATE });
    expect(s?.ctx?.vault?.ledger.equals(s.ctx.vault.siblingLedger)).toBe(false);
    expect(s?.ctx?.vault && "ext" in s.ctx.vault).toBe(false);
  });
  it("v2.1 flag on and the ext exists: ctx.vault.ext is set; flag on but ext absent / foreign: not set", async () => {
    __setDevnetV21ForTest(true);
    const present = await load(conn(base({ ext: true })));
    expect(present?.ctx?.vault?.ext?.equals(EXT)).toBe(true);
    const absent = await load(conn(base({ ext: false })));
    expect(absent?.ctx?.vault && "ext" in absent.ctx.vault).toBe(false);
  });
  it("junior owner pays inside the owner window: the early 101 is planned", async () => {
    const w = base({ market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 1n, cTot: 900n, delay: 100_000n }) });
    expect((await load(conn(w), junior))?.plan).toMatchObject({ phase: "owner-window", steps: [{ kind: "settle-vault-lp", topup: 0 }] });
    expect((await load(conn(w), k()))?.plan).toMatchObject({ phase: "owner-window", steps: [] });
  });
  it("bound registry but unreadable vault state: not bound to a vault ctx", async () => {
    const s = await load(conn(base({ state: null })));
    expect(s?.bound).toBe(true);
    expect(s?.ctx?.vault).toBeNull();
    expect(s?.portfolios[0].isVaultLp).toBe(false);
  });
});

describe("loadResolvedExitSnapshot: v2.2 tails (the :72 read)", () => {
  const w = () => ({ market: marketBytes(C.MARKET_MODE_RESOLVED) });
  it("flag off: no read, no tails key", async () => {
    __setDevnetV22ForTest(false); // blankMarket follows the flag: the world is built in the v2.1 layout
    const s = await load(conn(w()));
    expect(h.fetchTails).not.toHaveBeenCalled();
    expect(s?.ctx && "tails" in s.ctx).toBe(false);
  });
  it("flag on, read succeeds: tails on ctx", async () => {
    expect((await load(conn(w())))?.ctx?.tails).toBe(TAILS);
  });
  it("flag on, read fails: ctx loads WITHOUT tails and the plan is unchanged (no guessed value)", async () => {
    const ok = await load(conn(w()));
    h.fetchTails.mockRejectedValue(new Error("429"));
    const s = await load(conn(w()));
    expect(s?.ctx && "tails" in s.ctx).toBe(false);
    expect(s?.plan).toEqual(ok?.plan);
  });
});

describe("readViewerTopupIxs / readEmptyCloseIxs", () => {
  const sim = (r: unknown) => vi.fn(async (_: TransactionInstruction[]) => r);
  const emptyWorld = (): { world: World; keys: PublicKey[] } => {
    const keys = [k(), k(), k(), k(), k(), k()];
    return {
      keys,
      world: {
        market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 6n, cTot: 0n }),
        registry: registryBytes(false),
        pfs: keys.map((pubkey) => ({ pubkey, data: portfolioBytes(k(), 0n) })),
      },
    };
  };
  it("empty closes: capped at the default 4, each simulated, a clean sim (null) keeps the ixs", async () => {
    const { world, keys } = emptyWorld();
    const simulate = sim(null);
    const ixs = await readEmptyCloseIxs({ connection: conn(world), programId: PROG, market: MARKET, collateralMint: MINT, payer: k(), simulate });
    expect(simulate).toHaveBeenCalledTimes(4);
    expect(ixs).toHaveLength(4);
    const touched = ixs.map((i) => i.keys.map((x) => x.pubkey.toBase58()));
    keys.slice(0, 4).forEach((key, i) => expect(touched[i]).toContain(key.toBase58()));
    expect(touched.flat()).not.toContain(keys[4].toBase58());
  });
  it("empty closes: explicit max, and a refused sim leaves that close out", async () => {
    const { world } = emptyWorld();
    const refused = sim({ err: 21 });
    expect(await readEmptyCloseIxs({ connection: conn(world), programId: PROG, market: MARKET, collateralMint: MINT, payer: k(), simulate: refused, max: 2 })).toEqual([]);
    expect(refused).toHaveBeenCalledTimes(2);
  });
  it("empty closes: unresolved market or missing market -> [], and a thrown RPC -> []", async () => {
    const args = { programId: PROG, market: MARKET, collateralMint: MINT, payer: k(), simulate: sim(null) };
    expect(await readEmptyCloseIxs({ ...args, connection: conn({ market: marketBytes(0) }) })).toEqual([]);
    expect(await readEmptyCloseIxs({ ...args, connection: conn({ market: null }) })).toEqual([]);
    const boom = { getAccountInfo: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as Connection;
    expect(await readEmptyCloseIxs({ ...args, connection: boom })).toEqual([]);
  });
  it("viewer top-up: nothing when the viewer holds no open receipt; unresolved / missing / thrown -> []", async () => {
    const { world } = emptyWorld();
    const args = { programId: PROG, market: MARKET, collateralMint: MINT, viewer: k(), simulate: sim(null) };
    expect(await readViewerTopupIxs({ ...args, connection: conn(world) })).toEqual([]);
    expect(await readViewerTopupIxs({ ...args, connection: conn({ market: marketBytes(0) }) })).toEqual([]);
    expect(await readViewerTopupIxs({ ...args, connection: conn({ market: null }) })).toEqual([]);
    const boom = { getAccountInfo: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as Connection;
    expect(await readViewerTopupIxs({ ...args, connection: boom })).toEqual([]);
  });
  it("viewer top-up: an open receipt owned by the viewer yields a simulated 46 (kept when clean, dropped when refused)", async () => {
    const viewer = k();
    const pv = k();
    const data = portfolioBytes(viewer, 0n);
    // open receipt: present=1, finalized=0 at the active layout's receipt offset
    const geoShift = (await import("../../helpers/v22-fixtures")).afterLegsShift();
    data[C.PF_RESOLVED_PAYOUT_RECEIPT + geoShift + C.RECEIPT_PRESENT] = 1;
    data[C.PF_RESOLVED_PAYOUT_RECEIPT + geoShift + C.RECEIPT_FINALIZED] = 0;
    const world: World = { market: marketBytes(C.MARKET_MODE_RESOLVED, { count: 1n, cTot: 1n }), registry: registryBytes(false), pfs: [{ pubkey: pv, data }] };
    const args = { programId: PROG, market: MARKET, collateralMint: MINT, viewer };
    const clean = sim(null);
    const kept = await readViewerTopupIxs({ ...args, connection: conn(world), simulate: clean });
    expect(clean).toHaveBeenCalledTimes(1);
    expect(kept.length).toBeGreaterThan(0);
    expect(await readViewerTopupIxs({ ...args, connection: conn(world), simulate: sim({ err: 1 }) })).toEqual([]);
  });
});

describe("emptyCloseSteps (max 0)", () => {
  it("max 0 returns no steps", () => {
    expect(emptyCloseSteps({ phase: "sweep", steps: [{ kind: "close-empty", portfolio: "A", isVaultLp: false }], blockers: [] }, 0)).toEqual([]);
  });
});
