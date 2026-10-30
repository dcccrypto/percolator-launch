// @vitest-environment node
/**
 * #3637: the creator's own markets found on chain, with no registry, and "was a price ever pushed" read from the transaction at
 * last_good_oracle_slot. Real LP portfolio + market bytes (CHILLHOUSE-T). The fake connection checks the exact filters/slices sent
 * (percolator-prog aca02ba6: portfolio market id +16, owner +116, matcher control = config +96, market kind byte +10 = 1,
 * marketauth +16) and that the RPC budget holds.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { __setDevnetV22ForTest } from '@/lib/v22/flag';
import { LAYOUT_V22 } from '@/lib/v22/sdk/layout';
import {
  MAX_HISTORY_LOOKUPS,
  __clearHistoryCache,
  findCreatorSlabKeys,
  lookupCreatorMarkets,
  readCreatorSlabs,
  readNeverPushed,
  readSlabHistory,
} from '@/lib/v22/creator-onchain';

const fx = (n: string): { owner: string; data: Uint8Array } => {
  const j = JSON.parse(
    readFileSync(path.join(__dirname, `../../fixtures/v22-growth/${n}.json`), 'utf8'),
  ) as { owner: string; data: string };
  return { owner: j.owner, data: new Uint8Array(Buffer.from(j.data, 'base64')) };
};
const LP = fx('chillhouse-t.lp');
const MKT = fx('chillhouse-t.market');
const PROGRAM = new PublicKey(LP.owner);
const SLAB = new PublicKey('56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y');
const WALLET = new PublicKey(LP.data.subarray(116, 148));
const CONTROL_OFF = LAYOUT_V22.portfolio.matcherConfigOff + 96;

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __clearHistoryCache();
});
afterEach(() => __setDevnetV22ForTest(null));

const acct = (data: Uint8Array) => ({
  data: Buffer.from(data),
  owner: PROGRAM,
  lamports: 1,
  executable: false,
});
const slice = (d: Uint8Array, o: number, l: number): Uint8Array => d.slice(o, o + l);

describe('fixture sanity (the offsets are real)', () => {
  it('the LP carries the market id at +16, the creator at +116, an enabled matcher control word at config +96', () => {
    expect(new PublicKey(LP.data.subarray(16, 48)).toBase58()).toBe(SLAB.toBase58());
    expect(LP.data[10]).toBe(2);
    expect(MKT.data[10]).toBe(1);
    expect(CONTROL_OFF).toBe(LP.data.length - 104 - 24 + 96);
    expect(LP.data[CONTROL_OFF] & 1).toBe(1);
  });
});

describe('findCreatorSlabKeys', () => {
  const portfolioScan = (data: Uint8Array) =>
    vi.fn(async (_p: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) => {
      if (cfg?.dataSlice?.length === 0) return [];
      return [
        {
          pubkey: PublicKey.unique(),
          account: acct(slice(data, cfg!.dataSlice!.offset, cfg!.dataSlice!.length)),
        },
      ];
    });
  const multi = vi.fn(
    async (ks: PublicKey[], cfg?: { dataSlice?: { offset: number; length: number } }) =>
      ks.map(() => acct(slice(LP.data, cfg!.dataSlice!.offset, cfg!.dataSlice!.length))),
  );

  it('scans owner-scoped portfolios returning ONLY the 8-byte control word, then fetches the 32-byte market id of the LP ones', async () => {
    multi.mockClear();
    const getProgramAccounts = portfolioScan(LP.data);
    const keys = await findCreatorSlabKeys(
      { getProgramAccounts, getMultipleAccountsInfo: multi } as never,
      PROGRAM,
      WALLET,
    );
    expect(keys.map((k) => k.toBase58())).toEqual([SLAB.toBase58()]);
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
    const [pCall, aCall] = getProgramAccounts.mock.calls as unknown as Array<
      [PublicKey, { filters: Array<Record<string, unknown>>; dataSlice: unknown }]
    >;
    expect(pCall[1].dataSlice).toEqual({ offset: CONTROL_OFF, length: 8 });
    expect(pCall[1].filters).toContainEqual({ memcmp: { offset: 116, bytes: WALLET.toBase58() } });
    expect(pCall[1].filters.some((f) => 'dataSize' in f && f.dataSize === LP.data.length)).toBe(
      true,
    );
    expect(aCall[1].dataSlice).toEqual({ offset: 0, length: 0 });
    expect(aCall[1].filters).toEqual([
      { memcmp: { offset: 10, bytes: bs58.encode(Uint8Array.of(1)) } },
      { memcmp: { offset: 16, bytes: WALLET.toBase58() } },
    ]);
    expect(multi).toHaveBeenCalledTimes(1);
    expect((multi.mock.calls[0] as unknown[])[1]).toEqual({
      dataSlice: { offset: 16, length: 32 },
    });
  });
  it('a trading portfolio (matcher not enabled) is not a creator marker and costs no second fetch', async () => {
    multi.mockClear();
    const trader = LP.data.slice();
    trader.fill(0, CONTROL_OFF, CONTROL_OFF + 8);
    const keys = await findCreatorSlabKeys(
      { getProgramAccounts: portfolioScan(trader), getMultipleAccountsInfo: multi } as never,
      PROGRAM,
      WALLET,
    );
    expect(keys).toEqual([]);
    expect(multi).not.toHaveBeenCalled();
  });
  it('an unfinished launch (marketauth still the wallet) is found by key, and de-duplicated with the LP marker', async () => {
    const getProgramAccounts = vi.fn(
      async (_p: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) =>
        cfg?.dataSlice?.length === 0
          ? [{ pubkey: SLAB, account: acct(new Uint8Array()) }]
          : [{ pubkey: PublicKey.unique(), account: acct(slice(LP.data, CONTROL_OFF, 8)) }],
    );
    expect(
      (
        await findCreatorSlabKeys(
          { getProgramAccounts, getMultipleAccountsInfo: multi } as never,
          PROGRAM,
          WALLET,
        )
      ).length,
    ).toBe(1);
  });
});

describe('readCreatorSlabs', () => {
  it('keeps program-owned v2.2 markets; drops foreign owners, missing and non-market accounts; batches by 100', async () => {
    const other = new PublicKey('11111111111111111111111111111112');
    const keys = Array.from({ length: 103 }, () => PublicKey.unique());
    const getMultipleAccountsInfo = vi.fn(async (ks: PublicKey[]) =>
      ks.map((_, i) =>
        i === 0
          ? acct(MKT.data)
          : i === 1
            ? { ...acct(MKT.data), owner: other }
            : i === 2
              ? null
              : acct(new Uint8Array(40)),
      ),
    );
    const out = await readCreatorSlabs({ getMultipleAccountsInfo } as never, PROGRAM, keys);
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(out.length).toBe(2);
  });
});

// ── history: was a price ever pushed? ───────────────────────────────────────────────────────────
/** A transaction whose wrapper instructions have these tags, all touching the slab (index 1). */
function txWith(tags: number[], opts: { err?: unknown } = {}) {
  const keys = [WALLET, SLAB, PROGRAM];
  return {
    meta: { err: opts.err ?? null, loadedAddresses: undefined },
    transaction: {
      message: {
        getAccountKeys: () => ({ get: (i: number) => keys[i] }),
        compiledInstructions: tags.map((t) => ({
          programIdIndex: 2,
          accountKeyIndexes: [0, 1],
          data: Uint8Array.of(t, 0, 0),
        })),
      },
    },
  };
}
const sig = (signature: string, slot: number, err: unknown = null) => ({
  signature,
  slot,
  err,
  memo: null,
  blockTime: null,
});

describe('readNeverPushed: only a tag that can advance last_good_oracle_slot as a PRICE counts (tags from v16_program.rs aca02ba6)', () => {
  const C = 1_000_000;
  const never = (tags: number[], mode = 0, at = C) =>
    readNeverPushed(
      { getTransaction: vi.fn(async () => txWith(tags)) } as never,
      PROGRAM,
      SLAB,
      BigInt(at),
      [sig('t', at)],
      mode,
    );
  for (const gap of [37, 60, 516]) {
    it(`gap ${gap}: ConfigureAuthMark (62) at C+${gap} is the last good write -> never pushed, and only that tx is read`, async () => {
      const getTransaction = vi.fn(async (sg: string) =>
        sg === 'cfg' ? txWith([62]) : txWith([0]),
      );
      const r = await readNeverPushed(
        { getTransaction } as never,
        PROGRAM,
        SLAB,
        BigInt(C + gap),
        [sig('init', C), sig('cfg', C + gap)],
        0,
      );
      expect(r).toBe(true);
      expect(getTransaction).toHaveBeenCalledTimes(1);
    });
  }
  it('the keeper co-sign tx [62, 65] (ConfigureAuthMark + UpdateAssetAuthority): never pushed', async () => {
    expect(await never([62, 65])).toBe(true);
  });
  it('InitMarket sharing a tx with SetNftProgramId [0, 73]: never pushed', async () => {
    expect(await never([0, 73])).toBe(true);
  });
  it('a single-tx launch tag set (InitMarket, SetNftProgramId, more setup, ConfigureAuthMark): never pushed', async () => {
    expect(await never([0, 73, 74, 9, 62, 65])).toBe(true);
  });
  it('PushAuthMark (63) and PushEwmaMark (36): a price, alone or inside a batched launch tx', async () => {
    expect(await never([63])).toBe(false);
    expect(await never([36])).toBe(false);
    expect(await never([0, 62, 65, 63])).toBe(false);
  });
  it('the crank family is a price only on a non-manual oracle market', async () => {
    for (const t of [5, 77, 104, 106, 119]) {
      expect(await never([62, t], 0)).toBe(true); // manual: cannot write the slot
      expect(await never([62, t], 1)).toBe(false); // hybrid / pyth: can
    }
  });
  it('RestartAssetOracle (69) and UpdateAssetLifecycle (40) write the slot without a price', async () => {
    expect(await never([69])).toBe(true);
    expect(await never([40])).toBe(true);
  });
  it("a rotation / restart long after creation (62, 69, 40 with no InitMarket, beyond the creation window) is inconclusive, not 'no price ever'", async () => {
    const read = (tags: number[], gap: number) =>
      readNeverPushed(
        { getTransaction: vi.fn(async () => txWith(tags)) } as never,
        PROGRAM,
        SLAB,
        BigInt(C + gap),
        [sig('t', C + gap)],
        0,
        BigInt(C),
      );
    expect(await read([62, 65], 516)).toBe(true); // inside the creation window
    expect(await read([62, 65], 1000)).toBe(true); // window edge
    for (const t of [62, 69, 40, 34, 35]) expect(await read([t], 1001)).toBeNull();
    expect(await read([62, 65], 50_000)).toBeNull(); // keeper rotation after the market had prices
    expect(await read([0, 73], 50_000)).toBe(true); // InitMarket in the tx: it IS the creation tx
    expect(await read([62, 63], 50_000)).toBe(false); // a push is still a push
  });
  it("nothing in the tx explains the write (e.g. only [65, 73]): inconclusive, not 'pushed' and not 'never'", async () => {
    expect(await never([65, 73])).toBeNull();
  });
  it('unreadable: no tx at that slot, a null transaction, or no wrapper instruction -> null', async () => {
    expect(
      await readNeverPushed(
        { getTransaction: vi.fn() } as never,
        PROGRAM,
        SLAB,
        BigInt(C),
        [sig('a', C + 1)],
        0,
      ),
    ).toBeNull();
    expect(
      await readNeverPushed(
        { getTransaction: async () => null } as never,
        PROGRAM,
        SLAB,
        BigInt(C),
        [sig('a', C)],
        0,
      ),
    ).toBeNull();
    expect(await never([])).toBeNull();
  });
  it('a failed transaction at that slot is ignored', async () => {
    expect(
      await readNeverPushed(
        { getTransaction: vi.fn() } as never,
        PROGRAM,
        SLAB,
        BigInt(C),
        [sig('a', C, { InstructionError: [0, 'x'] })],
        0,
      ),
    ).toBeNull();
  });
});

describe('readSlabHistory', () => {
  it('creation slot = oldest successful tx; a failed earlier attempt does not count', async () => {
    const getSignaturesForAddress = vi.fn(async () => [
      sig('c', 30),
      sig('b', 20),
      sig('a', 10, { InstructionError: [0, 'x'] }),
    ]);
    const h = await readSlabHistory(
      { getSignaturesForAddress, getTransaction: async () => txWith([62]) } as never,
      PROGRAM,
      SLAB,
      30n,
    );
    expect(h).toEqual({ creationSlot: 20n, neverPushed: true });
  });
  it('a full page is an old busy market: unknown, and cached per (slab, last good)', async () => {
    const getSignaturesForAddress = vi.fn(async () =>
      Array.from({ length: 1000 }, (_, i) => sig(`s${i}`, i + 1)),
    );
    const c = { getSignaturesForAddress, getTransaction: vi.fn() } as never;
    expect(await readSlabHistory(c, PROGRAM, SLAB, 5n)).toEqual({
      creationSlot: null,
      neverPushed: null,
    });
    await readSlabHistory(c, PROGRAM, SLAB, 5n);
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });
  it('an RPC failure is unknown and NOT cached (the next scan retries)', async () => {
    const getSignaturesForAddress = vi
      .fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce([sig('a', 5)]);
    const c = { getSignaturesForAddress, getTransaction: async () => txWith([0]) } as never;
    expect(await readSlabHistory(c, PROGRAM, SLAB, 5n)).toEqual({
      creationSlot: null,
      neverPushed: null,
    });
    expect((await readSlabHistory(c, PROGRAM, SLAB, 5n)).creationSlot).toBe(5n);
  });
});

describe('lookupCreatorMarkets budget', () => {
  const setup = (n: number, lastGoodFor: (i: number) => bigint, clusterSlot: number) => {
    const lps = Array.from({ length: n }, () => PublicKey.unique());
    const slabIds = Array.from({ length: n }, () => PublicKey.unique());
    const markets = slabIds.map((_, i) => {
      const d = MKT.data.slice();
      new DataView(d.buffer).setBigUint64(16 + 152, lastGoodFor(i), true);
      return d;
    });
    const getProgramAccounts = vi.fn(
      async (_p: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) =>
        cfg?.dataSlice?.length === 0
          ? []
          : lps.map((k) => ({ pubkey: k, account: acct(slice(LP.data, CONTROL_OFF, 8)) })),
    );
    const getMultipleAccountsInfo = vi.fn(
      async (ks: PublicKey[], cfg?: { dataSlice?: { offset: number; length: number } }) =>
        cfg?.dataSlice
          ? ks.map((k) => acct(slabIds[lps.findIndex((l) => l.equals(k))].toBytes()))
          : ks.map((k) => acct(markets[slabIds.findIndex((s) => s.equals(k))])),
    );
    // each slab has one successful tx, at its last-good slot (launch-time config only)
    const getSignaturesForAddress = vi.fn(async (k: PublicKey) => [
      sig('t', Number(lastGoodFor(slabIds.findIndex((s) => s.equals(k))))),
    ]);
    const getTransaction = vi.fn(async () => txWith([62]));
    return {
      slabIds,
      conn: {
        getProgramAccounts,
        getMultipleAccountsInfo,
        getSignaturesForAddress,
        getTransaction,
        getSlot: vi.fn(async () => clusterSlot),
      } as never,
      getSignaturesForAddress,
      getTransaction,
    };
  };

  it('healthy markets (pushed within the launch wait) cost no history call', async () => {
    const t = setup(8, () => 999_900n, 1_000_000);
    const out = await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);
    expect(out.length).toBe(8);
    expect(t.getSignaturesForAddress).not.toHaveBeenCalled();
    expect(out.every((o) => o.neverPushed === null && o.creationSlot === null)).toBe(true);
  });
  it('silent markets: at most MAX_HISTORY_LOOKUPS history reads, newest last-good first; the rest keep unknown history', async () => {
    const n = MAX_HISTORY_LOOKUPS + 5;
    const t = setup(n, (i) => BigInt(100 + i), 1_000_000); // higher i = went silent more recently
    const out = await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);
    expect(out.length).toBe(n);
    expect(t.getSignaturesForAddress).toHaveBeenCalledTimes(MAX_HISTORY_LOOKUPS);
    const unread = out
      .filter((o) => o.creationSlot === null)
      .map((o) => Number(o.lastGoodOracleSlot));
    expect(unread.length).toBe(5);
    expect(Math.max(...unread)).toBeLessThan(100 + 5); // the 5 oldest were the ones skipped
  });
  it('expired unknown histories respect the per-lookup RPC budget', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      const n = MAX_HISTORY_LOOKUPS + 5;
      const t = setup(n, (i) => BigInt(100 + i), 1_000_000);

      // Simulate inconclusive empty history for every market.
      t.getSignaturesForAddress.mockResolvedValue([]);

      // First lookup: only the first 12 markets may query RPC.
      await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);

      expect(t.getSignaturesForAddress).toHaveBeenCalledTimes(MAX_HISTORY_LOOKUPS);

      // Second lookup: 12 cached, 5 remaining markets queried.
      await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);

      expect(t.getSignaturesForAddress).toHaveBeenCalledTimes(n);

      // Within TTL: all 17 are cached; no additional RPC calls.
      await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);

      expect(t.getSignaturesForAddress).toHaveBeenCalledTimes(n);

      // Expire every temporary entry simultaneously.
      clock.mockReturnValue(61_001);

      // Even with 17 expired entries, this lookup may read only 12.
      await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);

      expect(t.getSignaturesForAddress).toHaveBeenCalledTimes(n + MAX_HISTORY_LOOKUPS);

      // Next lookup can recover the remaining 5.
      await lookupCreatorMarkets(t.conn, PROGRAM, WALLET);

      expect(t.getSignaturesForAddress).toHaveBeenCalledTimes(n * 2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('Creator history transaction recovery', () => {
  it('recovers unavailable transaction details after TTL', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      const getSignaturesForAddress = vi.fn().mockResolvedValue([sig('launch', 42)]);

      const getTransaction = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(txWith([0, 62]));

      const conn = {
        getSignaturesForAddress,
        getTransaction,
      };

      const first = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(first.creationSlot).toBe(42n);
      expect(first.neverPushed).toBeNull();

      clock.mockReturnValue(5_000);

      const cached = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(cached.neverPushed).toBeNull();
      expect(getTransaction).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(61_001);

      const recovered = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(recovered.creationSlot).toBe(42n);
      expect(recovered.neverPushed).toBe(true);
      expect(getSignaturesForAddress).toHaveBeenCalledTimes(2);
      expect(getTransaction).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});
