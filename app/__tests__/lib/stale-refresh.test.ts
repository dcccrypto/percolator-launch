/**
 * GH#2953: stale K/F cohort detection + the refresh crank (lib/stale-refresh.ts).
 * Live state 2026-10-02 (Percolator 9EPm8nB8, slot ~506769201): kf_epoch long = short =
 * 506769182, stale_account_count long 2 / short 0; the two stale legs were FebDwbxR
 * (kf_epoch_snap 506769019) and J43pWxNZ (506731982). Those numbers are the fixture.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNTS_PERMISSIONLESS_CRANK_BASE, encodePermissionlessCrank } from "@percolatorct/sdk";

const parse = vi.hoisted(() => ({ fn: null as null | ((d: Uint8Array) => unknown) }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  return { ...real, parsePortfolioV17: (d: Uint8Array) => (parse.fn ? parse.fn(d) : real.parsePortfolioV17(d)) };
});
import {
  MAX_STALE_REFRESHES,
  buildStaleRefreshIx,
  decodeStaleCohort,
  findStalePortfolios,
  hasStaleCohort,
  selectStalePortfolios,
  type LegView,
} from "@/lib/stale-refresh";

const ENGINE_ASSET0 = 592 + 758 + 1024;
const EPOCH = 506_769_182n;

function market(stale: [bigint, bigint], kf: [bigint, bigint] = [EPOCH, EPOCH]): Uint8Array {
  const d = new Uint8Array(ENGINE_ASSET0 + 2325);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(ENGINE_ASSET0 + 145, kf[0], true);
  dv.setBigUint64(ENGINE_ASSET0 + 153, kf[1], true);
  dv.setBigUint64(ENGINE_ASSET0 + 337, stale[0], true);
  dv.setBigUint64(ENGINE_ASSET0 + 345, stale[1], true);
  return d;
}
const leg = (side: 0 | 1, kfEpochSnap: bigint, over: Partial<LegView> = {}): LegView => ({ active: true, assetIndex: 0, side, kfEpochSnap, ...over });

describe("decodeStaleCohort", () => {
  it("reads kf_epoch and stale_account_count per side at the deployed offsets", () => {
    const c = decodeStaleCohort(market([2n, 0n]));
    expect(c).toEqual({ kfEpoch: [EPOCH, EPOCH], stale: [2n, 0n] });
    expect(hasStaleCohort(c)).toBe(true);
  });
  it("NEGATIVE CONTROL: a refreshed market (both counts 0) is not stale", () => {
    expect(hasStaleCohort(decodeStaleCohort(market([0n, 0n])))).toBe(false);
  });
  it("a truncated account decodes to null (never guesses)", () => {
    expect(decodeStaleCohort(new Uint8Array(100))).toBeNull();
    expect(hasStaleCohort(null)).toBe(false);
  });
});

describe("selectStalePortfolios (mirrors kernel_settle_kf_stale_cohort)", () => {
  const cohort = { kfEpoch: [EPOCH, EPOCH] as [bigint, bigint], stale: [2n, 0n] as [bigint, bigint] };
  const febd = Keypair.generate().publicKey;
  const j43p = Keypair.generate().publicKey;
  const current = Keypair.generate().publicKey;
  it("picks exactly the legs behind their side's epoch (the live FebDwbxR / J43pWxNZ case)", () => {
    const out = selectStalePortfolios(
      [
        { pubkey: current, legs: [leg(0, EPOCH)] },
        { pubkey: febd, legs: [leg(0, 506_769_019n)] },
        { pubkey: j43p, legs: [leg(0, 506_731_982n)] },
      ],
      cohort,
    );
    expect(out.map((p) => p.toBase58())).toEqual([febd.toBase58(), j43p.toBase58()]);
  });
  it("NEGATIVE CONTROL: inactive legs, other assets and current snaps are never refreshed", () => {
    const out = selectStalePortfolios(
      [
        { pubkey: febd, legs: [leg(0, 1n, { active: false })] },
        { pubkey: j43p, legs: [leg(1, 1n, { assetIndex: 1 })] },
        { pubkey: current, legs: [leg(1, EPOCH)] },
      ],
      cohort,
    );
    expect(out).toEqual([]);
  });
  it("uses the leg's own side epoch", () => {
    const c = { kfEpoch: [10n, 20n] as [bigint, bigint], stale: [0n, 1n] as [bigint, bigint] };
    expect(selectStalePortfolios([{ pubkey: febd, legs: [leg(0, 15n)] }], c)).toEqual([]);
    expect(selectStalePortfolios([{ pubkey: febd, legs: [leg(1, 15n)] }], c)).toEqual([febd]);
  });
});

describe("buildStaleRefreshIx", () => {
  it("is a PermissionlessCrank with NO observation: [cranker(s,w), market(w), portfolio(w)]", () => {
    const programId = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
    const [cranker, mkt, pf] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const ix = buildStaleRefreshIx(programId, cranker, mkt, pf);
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      ACCOUNTS_PERMISSIONLESS_CRANK_BASE.map((spec, i) => [[cranker, mkt, pf][i].toBase58(), spec.signer, spec.writable]),
    );
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: [] })));
  });
});

describe("findStalePortfolios", () => {
  const acct = (staleSnap: boolean) => ({ pubkey: Keypair.generate().publicKey, account: { data: Buffer.from([staleSnap ? 1 : 0]) } });
  const run = async (accounts: ReturnType<typeof acct>[]) => {
    parse.fn = (d) => {
      if (d.length !== 1) throw new Error("not a portfolio");
      return { legs: [leg(0, d[0] === 1 ? 1n : 5n)] };
    };
    const conn = { getProgramAccounts: vi.fn(async () => accounts) };
    const out = await findStalePortfolios(conn, Keypair.generate().publicKey, Keypair.generate().publicKey, { kfEpoch: [5n, 5n], stale: [1n, 0n] });
    parse.fn = null;
    return { out, conn };
  };
  it("returns the stale ones, base58-sorted, from one bounded scan", async () => {
    const a = [acct(true), acct(false), acct(true)];
    const { out, conn } = await run(a);
    expect(out.map((p) => p.toBase58())).toEqual([a[0], a[2]].map((x) => x.pubkey.toBase58()).sort());
    const filters = (conn.getProgramAccounts.mock.calls[0] as unknown as [PublicKey, { filters: unknown[] }])[1].filters;
    expect(filters).toHaveLength(3); // dataSize + magic + market: bounded, as /api/rpc requires
  });
  it("NEGATIVE CONTROL: more stale portfolios than one user tx can refresh returns [] (the keeper's job)", async () => {
    const { out } = await run(Array.from({ length: MAX_STALE_REFRESHES + 1 }, () => acct(true)));
    expect(out).toEqual([]);
  });
  it("NEGATIVE CONTROL: an undecodable account is never refreshed", async () => {
    const { out } = await run([{ pubkey: Keypair.generate().publicKey, account: { data: Buffer.alloc(10) } }]);
    expect(out).toEqual([]);
  });
});
