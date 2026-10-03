/**
 * All-time claimed creator fees, summed from the market's tag-90 (WithdrawCreatorFee) history.
 * Claims are built with the SDK's own encoder and account list, so layout drift is caught.
 */
import { Keypair, PublicKey, TransactionMessage } from "@solana/web3.js";
import {
  ACCOUNTS_WITHDRAW_CREATOR_FEE,
  buildAccountMetas,
  buildIx,
  encodeWithdrawCreatorFee,
  encodeWithdrawInsuranceAsset,
} from "@percolatorct/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom's crypto can't derive PDAs here, and the connection below is a stub anyway. The ATA
// stub returns the owner itself so the stub connection can tell vault from claimant, and it
// records each derivation so the off-curve flag can be checked.
const VAULT_AUTH = vi.hoisted(() => new (require("@solana/web3.js").PublicKey)("SysvarRent111111111111111111111111111111111"));
const ataCalls = vi.hoisted(() => [] as { owner: string; offCurve: boolean | undefined }[]);
vi.mock("@percolatorct/sdk", async (io) => ({
  ...(await io<typeof import("@percolatorct/sdk")>()),
  deriveVaultAuthority: () => [VAULT_AUTH, 255],
}));
vi.mock("@solana/spl-token", async (io) => ({
  ...(await io<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: (_mint: PublicKey, owner: PublicKey, offCurve?: boolean) => {
    ataCalls.push({ owner: owner.toBase58(), offCurve });
    return owner;
  },
}));

import { claimsInTransaction, fetchCreatorFeesClaimed } from "@/lib/creator-fee-history";

const PROGRAM = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const MARKET = Keypair.generate().publicKey;
const OTHER_MARKET = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;
const any = () => Keypair.generate().publicKey;

function claimIx(market: PublicKey, amount: bigint, program = PROGRAM) {
  const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_CREATOR_FEE, [CREATOR, market, any(), any(), any(), any()]);
  return buildIx({ programId: program, keys, data: encodeWithdrawCreatorFee({ amount, assetIndex: 0, authorityEpoch: 3n }) });
}

function tx(ixs: ReturnType<typeof claimIx>[], err: unknown = null) {
  const message = new TransactionMessage({ payerKey: CREATOR, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message();
  return { meta: { err, loadedAddresses: { writable: [], readonly: [] } }, transaction: { message } } as never;
}

describe("claimsInTransaction", () => {
  it("reads the exact claimed amount", () => {
    expect(claimsInTransaction(tx([claimIx(MARKET, 92_104n)]), PROGRAM, MARKET)).toEqual({ claimedAtoms: 92_104n, claims: 1 });
  });

  it("decodes the full u128 amount", () => {
    const big = (1n << 64n) + 5n;
    expect(claimsInTransaction(tx([claimIx(MARKET, big)]), PROGRAM, MARKET).claimedAtoms).toBe(big);
  });

  it("ignores failed transactions, other markets, other programs and other instructions", () => {
    expect(claimsInTransaction(tx([claimIx(MARKET, 10n)], { InstructionError: [0, "x"] }), PROGRAM, MARKET).claims).toBe(0);
    expect(claimsInTransaction(tx([claimIx(OTHER_MARKET, 10n)]), PROGRAM, MARKET).claims).toBe(0);
    expect(claimsInTransaction(tx([claimIx(MARKET, 10n, any())]), PROGRAM, MARKET).claims).toBe(0);
    const insurance = buildIx({
      programId: PROGRAM,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_CREATOR_FEE, [CREATOR, MARKET, any(), any(), any(), any()]),
      data: encodeWithdrawInsuranceAsset({ assetIndex: 0, marketId: 1n, amount: 10n, authorityEpoch: 1n }),
    });
    expect(claimsInTransaction(tx([insurance]), PROGRAM, MARKET).claims).toBe(0);
    expect(claimsInTransaction(null, PROGRAM, MARKET).claims).toBe(0);
  });

  it("counts two claims in one transaction (claim-all batches markets)", () => {
    const both = tx([claimIx(MARKET, 3n), claimIx(OTHER_MARKET, 9n), claimIx(MARKET, 4n)]);
    expect(claimsInTransaction(both, PROGRAM, MARKET)).toEqual({ claimedAtoms: 7n, claims: 2 });
  });
});

describe("fetchCreatorFeesClaimed", () => {
  let TXS: Record<string, ReturnType<typeof tx>> = {};
  type Sig = { signature: string; slot: number; err: unknown };
  let vaultSigs: Sig[] = [];
  let mySigs: Sig[] = [];
  // Each list is served by a "node" at some height: like a real RPC it errors when asked for a
  // minContextSlot it hasn't reached, and pages 1000 at a time from `before`.
  let heights = { vault: Infinity, mine: Infinity };
  const conn = {
    getSignaturesForAddress: vi.fn(
      async (addr: PublicKey, opts: { until?: string; before?: string; limit?: number; minContextSlot?: number }) => {
        const isVault = addr.equals(VAULT_AUTH);
        const list = isVault ? vaultSigs : mySigs;
        const height = isVault ? heights.vault : heights.mine;
        if (opts.minContextSlot !== undefined && opts.minContextSlot > height) {
          throw new Error("Minimum context slot has not been reached");
        }
        const out: Sig[] = [];
        let started = opts.before === undefined;
        for (const s of list) {
          if (!started) {
            started = s.signature === opts.before;
            continue;
          }
          if (s.signature === opts.until || out.length === (opts.limit ?? 1000)) break;
          out.push(s);
        }
        return out;
      },
    ),
    getTransaction: vi.fn(async (sig: string) => TXS[sig] ?? null),
  };
  const fetch = (claimant = CREATOR) => fetchCreatorFeesClaimed(conn as never, PROGRAM, MARKET, MINT, claimant);
  const ok = (signature: string, slot: number): Sig => ({ signature, slot, err: null });
  const fetched = () => conn.getTransaction.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    localStorage.clear();
    TXS = {};
    heights = { vault: Infinity, mine: Infinity };
    ataCalls.length = 0;
    conn.getSignaturesForAddress.mockClear();
    conn.getTransaction.mockClear();
  });

  it("derives the vault's token account off-curve and the claimant's normally", async () => {
    vaultSigs = [];
    mySigs = [];
    await fetch();
    expect(ataCalls).toEqual([
      { owner: VAULT_AUTH.toBase58(), offCurve: true },
      { owner: CREATOR.toBase58(), offCurve: undefined },
    ]);
  });

  it("downloads only transactions on both the vault and the claimant's account", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]), b: tx([]), c: tx([claimIx(MARKET, 50n)]) };
    // t1/t2: other traders' deposits (vault only); f1: the creator's faucet (their account only).
    vaultSigs = [ok("c", 9), ok("t2", 8), { signature: "x", slot: 7, err: { e: 1 } }, ok("b", 6), ok("t1", 5), ok("a", 4)];
    mySigs = [ok("f1", 10), ok("c", 9), ok("b", 6), ok("a", 4)];
    expect(await fetch()).toEqual({ claimedAtoms: 150n, claims: 2 });
    expect(fetched()).toEqual(["c", "b", "a"]);
  });

  it("next time fetches only what landed since", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]), d: tx([claimIx(MARKET, 25n)]) };
    vaultSigs = [ok("a", 4)];
    mySigs = [ok("a", 4)];
    expect(await fetch()).toEqual({ claimedAtoms: 100n, claims: 1 });
    vaultSigs = [ok("d", 9), ok("t3", 8), ...vaultSigs];
    mySigs = [ok("d", 9), ...mySigs];
    conn.getTransaction.mockClear();
    expect(await fetch()).toEqual({ claimedAtoms: 125n, claims: 2 });
    expect(fetched()).toEqual(["d"]);
  });

  it("a claimant list from a node behind the vault's newest entry fails, then counts the claim", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]), n: tx([claimIx(MARKET, 40n)]) };
    vaultSigs = [ok("n", 12), ok("a", 4)];
    mySigs = [ok("a", 4)]; // a node one claim behind: it hasn't reached slot 12
    heights.mine = 11;
    await expect(fetch()).rejects.toThrow(/context slot/);
    expect(localStorage.length).toBe(0); // nothing half-read is saved
    mySigs = [ok("n", 12), ok("a", 4)]; // caught up
    heights.mine = 12;
    expect(await fetch()).toEqual({ claimedAtoms: 140n, claims: 2 });
  });

  const sigCalls = (addr: PublicKey) =>
    conn.getSignaturesForAddress.mock.calls.filter((c) => (c[0] as PublicKey).equals(addr)).map((c) => c[1]);

  it("moves past other traders' vault activity: the next scan reads only what landed after it", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]) };
    // The creator's last activity is "a" (slot 4); t1/t2 are other traders' deposits after it.
    vaultSigs = [ok("t2", 9), ok("t1", 8), ok("a", 4)];
    mySigs = [ok("a", 4)];
    expect(await fetch()).toEqual({ claimedAtoms: 100n, claims: 1 });
    conn.getSignaturesForAddress.mockClear();
    // A trade changes the claimable balance and the hook re-scans: nothing new on the vault.
    expect(await fetch()).toEqual({ claimedAtoms: 100n, claims: 1 });
    expect(sigCalls(VAULT_AUTH)).toEqual([expect.objectContaining({ until: "t2", minContextSlot: 9 })]);
    expect(sigCalls(CREATOR)).toEqual([]); // the claimant's history isn't re-read
    expect(conn.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("reads the claimant's list from a node at the vault's newest slot, and stops paging below the oldest", async () => {
    TXS = {};
    vaultSigs = [ok("a", 100), ok("z", 1)];
    mySigs = [];
    expect(await fetch()).toEqual({ claimedAtoms: 0n, claims: 0 }); // seeds the cursor at "a"
    // 4001 claimant entries; only those from the oldest new vault entry (slot 4000) can match.
    mySigs = Array.from({ length: 4000 }, (_, i) => ok(`m${i}`, 6000 - i));
    mySigs.splice(1000, 0, ok("c", 5000));
    TXS.c = tx([claimIx(MARKET, 7n)]);
    vaultSigs = [ok("new", 5999), ok("c", 5000), ok("old", 4000), ...vaultSigs];
    conn.getSignaturesForAddress.mockClear();
    expect(await fetch()).toEqual({ claimedAtoms: 7n, claims: 1 });
    const mine = sigCalls(CREATOR);
    expect(mine.every((o) => o?.minContextSlot === 5999)).toBe(true);
    expect(mine).toHaveLength(3); // page 3 reaches slot 3002 < 4000; a 4th isn't read
  });

  it("a node that hasn't seen the cached scan fails instead of counting history twice", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]), b: tx([claimIx(MARKET, 20n)]) };
    vaultSigs = [ok("b", 6), ok("a", 4)];
    mySigs = [ok("b", 6), ok("a", 4)];
    expect(await fetch()).toEqual({ claimedAtoms: 120n, claims: 2 });
    // A lagging node: it doesn't know "b", so `until` matches nothing and "a" comes back.
    vaultSigs = [ok("a", 4)];
    await expect(fetch()).rejects.toThrow();
    // Caught up: still 120, not 220.
    vaultSigs = [ok("b", 6), ok("a", 4)];
    expect(await fetch()).toEqual({ claimedAtoms: 120n, claims: 2 });
  });

  it("with nothing new on the vault, reads no transactions", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]) };
    vaultSigs = [ok("a", 4)];
    mySigs = [ok("a", 4)];
    await fetch();
    conn.getTransaction.mockClear();
    expect(await fetch()).toEqual({ claimedAtoms: 100n, claims: 1 });
    expect(conn.getTransaction).not.toHaveBeenCalled();
  });

  it("an empty vault is 0 claimed", async () => {
    vaultSigs = [];
    mySigs = [];
    expect(await fetch()).toEqual({ claimedAtoms: 0n, claims: 0 });
  });

  it("keeps a separate total per claimant", async () => {
    const other = any();
    TXS = { a: tx([claimIx(MARKET, 100n)]) };
    vaultSigs = [ok("a", 4)];
    mySigs = [ok("a", 4)];
    expect(await fetch()).toEqual({ claimedAtoms: 100n, claims: 1 });
    mySigs = []; // `other` never received that claim
    expect(await fetch(other)).toEqual({ claimedAtoms: 0n, claims: 0 });
  });

  it("throws and saves nothing when a transaction can't be read", async () => {
    TXS = { e: tx([claimIx(MARKET, 7n)]) };
    // The readable claim comes first, so a partial total of 7 would exist to leak.
    vaultSigs = [ok("e", 9), ok("missing", 8)];
    mySigs = [ok("e", 9), ok("missing", 8)];
    await expect(fetch()).rejects.toThrow();
    expect(localStorage.length).toBe(0);
    TXS.missing = tx([claimIx(MARKET, 3n)]);
    expect(await fetch()).toEqual({ claimedAtoms: 10n, claims: 2 });
  });

  it("a corrupt cache falls back to a full rescan", async () => {
    TXS = { a: tx([claimIx(MARKET, 100n)]) };
    vaultSigs = [ok("a", 4)];
    mySigs = [ok("a", 4)];
    localStorage.setItem(`percolator-creator-claimed:${MARKET.toBase58()}:${CREATOR.toBase58()}`, "{not json");
    expect(await fetch()).toEqual({ claimedAtoms: 100n, claims: 1 });
  });
});
