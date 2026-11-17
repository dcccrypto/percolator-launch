// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";
const PROXY = "http://localhost:3000/api/rpc";
const PLAIN = "https://api.devnet.solana.com";

type Mod = typeof import("@/lib/tokenMeta");

/** Metaplex metadata account: 65-byte header, then u32-len name, u32-len symbol. */
function metaplexBuf(name: string, symbol: string, opts: { nameLen?: number; symLen?: number; trunc?: number } = {}) {
  const n = Buffer.from(name, "utf8");
  const s = Buffer.from(symbol, "utf8");
  const head = Buffer.alloc(69);
  head.writeUInt32LE(opts.nameLen ?? n.length, 65);
  const symLenBuf = Buffer.alloc(4);
  symLenBuf.writeUInt32LE(opts.symLen ?? s.length, 0);
  const full = Buffer.concat([head, n, symLenBuf, s]);
  return opts.trunc !== undefined ? full.subarray(0, opts.trunc) : full;
}

function conn(endpoint: string, over: Record<string, unknown> = {}) {
  return {
    rpcEndpoint: endpoint,
    getParsedAccountInfo: vi.fn().mockResolvedValue({ value: { data: { parsed: { info: { decimals: 9 } } } } }),
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getMultipleAccountsInfo: vi.fn().mockImplementation(async (keys: unknown[]) => keys.map(() => null)),
    getMultipleParsedAccounts: vi.fn().mockImplementation(async (keys: unknown[]) => ({
      value: keys.map(() => ({ data: { parsed: { info: { decimals: 4 } } } })),
    })),
    ...over,
  } as any;
}

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as any;

const newMint = () => Keypair.generate().publicKey;

let mod: Mod;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn().mockResolvedValue(jsonRes({}, 500));
  vi.stubGlobal("fetch", fetchMock);
  mod = await import("@/lib/tokenMeta");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchTokenMeta: Helius DAS branches", () => {
  it("retries a 503 then returns the DAS metadata with its decimals", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({}, 503))
      .mockResolvedValueOnce(
        jsonRes({ result: { content: { metadata: { symbol: "AAA", name: "Alpha" } }, token_info: { decimals: 2 } } }),
      );
    const meta = await mod.fetchTokenMeta(conn(HELIUS), newMint());
    expect(meta).toEqual({ symbol: "AAA", name: "Alpha", decimals: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 rate-limited attempts and falls through to DexScreener", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("dexscreener")
        ? jsonRes({ pairs: [{ baseToken: { symbol: "DEX", name: "Dexcoin" } }] })
        : jsonRes({}, 429),
    );
    const meta = await mod.fetchTokenMeta(conn(HELIUS), newMint());
    expect(meta).toEqual({ symbol: "DEX", name: "Dexcoin", decimals: 9 });
    const dasCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).includes("dexscreener"));
    expect(dasCalls).toHaveLength(3);
  });

  it("retries a network TypeError and then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonRes({ result: { token_info: { symbol: "TT", decimals: 0 }, content: { metadata: { name: "Tee" } } } }));
    const meta = await mod.fetchTokenMeta(conn(HELIUS), newMint());
    expect(meta).toEqual({ symbol: "TT", name: "Tee", decimals: 0 });
  });

  it("does not retry non-network errors (e.g. bad JSON) and falls back to a placeholder", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("dexscreener")
        ? jsonRes({}, 404)
        : ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }) as any,
    );
    const mint = newMint();
    const meta = await mod.fetchTokenMeta(conn(HELIUS), mint);
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
    expect(meta.symbol).toBe(`${mint.toBase58().slice(0, 4)}...${mint.toBase58().slice(-4)}`);
    expect(fetchMock.mock.calls.filter((c) => !String(c[0]).includes("dexscreener"))).toHaveLength(1);
  });

  it("does not retry a 404 (not ok) response", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, 404));
    const meta = await mod.fetchTokenMeta(conn(HELIUS), newMint());
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
    // 1 DAS + 1 DexScreener
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a partial DAS match (symbol only) and shortens the mint for the missing name", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ result: { content: { metadata: { symbol: "SOLO" } } } }));
    const mint = newMint();
    const b = mint.toBase58();
    const meta = await mod.fetchTokenMeta(conn(HELIUS), mint);
    expect(meta.symbol).toBe("SOLO");
    expect(meta.name).toBe(`${b.slice(0, 4)}...${b.slice(-4)}`);
    expect(meta.decimals).toBe(6);
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(false);
  });

  it("uses a partial DAS match (name only) and shortens the mint for the missing symbol", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ result: { content: { metadata: { name: "Only Name" } } } }));
    const mint = newMint();
    const b = mint.toBase58();
    const meta = await mod.fetchTokenMeta(conn(HELIUS), mint);
    expect(meta.name).toBe("Only Name");
    expect(meta.symbol).toBe(`${b.slice(0, 4)}...${b.slice(-4)}`);
  });

  it("falls through when DAS returns an asset with neither symbol nor name", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("dexscreener") ? jsonRes({}, 500) : jsonRes({ result: { content: { metadata: {} } } }),
    );
    const meta = await mod.fetchTokenMeta(conn(HELIUS), newMint());
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
  });
});

describe("fetchTokenMeta: DexScreener branches", () => {
  it("name-only DexScreener result fills symbol with the shortened mint", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ pairs: [{ baseToken: { name: "Namey" } }] }));
    const mint = newMint();
    const b = mint.toBase58();
    const meta = await mod.fetchTokenMeta(conn(PLAIN), mint);
    expect(meta.name).toBe("Namey");
    expect(meta.symbol).toBe(`${b.slice(0, 4)}...${b.slice(-4)}`);
    expect(meta.decimals).toBe(9);
  });

  it("symbol-only DexScreener result fills name with the shortened mint", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ pairs: [{ baseToken: { symbol: "SYMX" } }] }));
    const mint = newMint();
    const b = mint.toBase58();
    const meta = await mod.fetchTokenMeta(conn(PLAIN), mint);
    expect(meta.symbol).toBe("SYMX");
    expect(meta.name).toBe(`${b.slice(0, 4)}...${b.slice(-4)}`);
  });

  it("DexScreener network failure falls through to Metaplex", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const c = conn(PLAIN, { getAccountInfo: vi.fn().mockResolvedValue({ data: metaplexBuf("Chain Coin", "CHN") }) });
    const meta = await mod.fetchTokenMeta(c, newMint());
    expect(meta).toEqual({ symbol: "CHN", name: "Chain Coin", decimals: 9 });
  });
});

describe("fetchTokenMeta: on-chain Metaplex fallback", () => {
  const run = async (data: Buffer | null | undefined) => {
    const c = conn(PLAIN, { getAccountInfo: vi.fn().mockResolvedValue(data === undefined ? null : { data }) });
    const mint = newMint();
    return { meta: await mod.fetchTokenMeta(c, mint), mint };
  };

  it("parses name and symbol, stripping NUL padding", async () => {
    const { meta } = await run(metaplexBuf("Padded\0\0\0", "PAD\0\0"));
    expect(meta).toEqual({ symbol: "PAD", name: "Padded", decimals: 9 });
  });

  it.each([
    ["buffer shorter than the header", Buffer.alloc(40)],
    ["name length over 256", metaplexBuf("x", "Y", { nameLen: 300 })],
    ["name length past the end of the buffer", metaplexBuf("abc", "Y", { nameLen: 50 })],
    ["buffer ending before the symbol length", metaplexBuf("abc", "Y", { trunc: 69 + 3 + 2 })],
    ["symbol length over 32", metaplexBuf("abc", "Y", { symLen: 99 })],
    ["symbol length past the end of the buffer", metaplexBuf("abc", "Y", { symLen: 10 })],
    ["empty name", metaplexBuf("", "SYM")],
    ["empty symbol", metaplexBuf("Name", "")],
  ])("malformed metadata (%s) yields a placeholder, not a throw", async (_label, buf) => {
    const { meta, mint } = await run(buf);
    const b = mint.toBase58();
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
    expect(meta.symbol).toBe(`${b.slice(0, 4)}...${b.slice(-4)}`);
    expect(meta.decimals).toBe(9);
  });

  it("getAccountInfo throwing yields a placeholder", async () => {
    const c = conn(PLAIN, { getAccountInfo: vi.fn().mockRejectedValue(new Error("rpc down")) });
    const meta = await mod.fetchTokenMeta(c, newMint());
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
  });

  it("a missing metadata account yields a placeholder with default decimals when mint info is absent", async () => {
    const c = conn(PLAIN, { getParsedAccountInfo: vi.fn().mockResolvedValue({ value: null }) });
    const meta = await mod.fetchTokenMeta(c, newMint());
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
    expect(meta.decimals).toBe(6);
  });
});

describe("fetchTokenMeta: cache", () => {
  it("serves a resolved result from cache without any further RPC or fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ pairs: [{ baseToken: { symbol: "C", name: "Cached" } }] }));
    const c = conn(PLAIN);
    const mint = newMint();
    const a = await mod.fetchTokenMeta(c, mint);
    const b = await mod.fetchTokenMeta(c, mint);
    expect(b).toBe(a);
    expect(a.name).toBe("Cached");
    expect(c.getParsedAccountInfo).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("known sim-USDC mint resolves with the real mint's on-chain decimals and no network fetch", async () => {
    const c = conn(PLAIN);
    const meta = await mod.fetchTokenMeta(c, new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC"));
    expect(meta).toEqual({ symbol: "USDC", name: "Sim USDC (devnet)", decimals: 9 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchTokenMetaBatch", () => {
  const dasAsset = (id: string, symbol: string, name: string, decimals?: number) => ({
    id,
    content: { metadata: { symbol, name } },
    ...(decimals === undefined ? {} : { token_info: { decimals } }),
  });

  it("returns an empty map for no mints", async () => {
    const r = await mod.fetchTokenMetaBatch(conn(PLAIN), []);
    expect(r.size).toBe(0);
  });

  it("resolves well-known mints and caches them, deduplicating input", async () => {
    const c = conn(PLAIN);
    const perc = new PublicKey("A16Gd8AfaPnG6rohE6iPFDf6mr9gk519d6aMUJAperc");
    const r = await mod.fetchTokenMetaBatch(c, [perc, perc]);
    expect(r.size).toBe(1);
    expect(r.get(perc.toBase58())).toEqual({ symbol: "PERC", name: "Percolator", decimals: 6 });
    // second call is a cache hit
    const r2 = await mod.fetchTokenMetaBatch(c, [perc]);
    expect(r2.get(perc.toBase58())).toBe(r.get(perc.toBase58()));
    expect(c.getMultipleParsedAccounts).not.toHaveBeenCalled();
  });

  it("resolves via DAS getAssetBatch, sanitises, and skips the on-chain fallbacks", async () => {
    const m1 = newMint();
    const m2 = newMint();
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        result: [
          dasAsset(m1.toBase58(), "A<b>C", "Alpha", 3),
          dasAsset(m2.toBase58(), "ONLY", ""), // symbol only -> name shortened
          { id: undefined }, // ignored
          null, // ignored
        ],
      }),
    );
    const c = conn(HELIUS);
    const r = await mod.fetchTokenMetaBatch(c, [m1, m2]);
    expect(r.get(m1.toBase58())).toEqual({ symbol: "AbC", name: "Alpha", decimals: 3 });
    const b2 = m2.toBase58();
    expect(r.get(b2)?.symbol).toBe("ONLY");
    expect(r.get(b2)?.name).toBe(`${b2.slice(0, 4)}...${b2.slice(-4)}`);
    expect(r.get(b2)?.decimals).toBe(6);
    expect(c.getMultipleAccountsInfo).not.toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.method).toBe("getAssetBatch");
    expect(body.params.ids).toEqual([m1.toBase58(), m2.toBase58()]);
  });

  it("splits more than 100 mints into multiple DAS calls", async () => {
    const mints = Array.from({ length: 101 }, newMint);
    fetchMock.mockImplementation(async (_u: string, init: any) => {
      const ids: string[] = JSON.parse(init.body).params.ids;
      return jsonRes({ result: ids.map((id) => dasAsset(id, "T", "Tok", 5)) });
    });
    const r = await mod.fetchTokenMetaBatch(conn(PROXY), mints);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.size).toBe(101);
    expect(r.get(mints[100].toBase58())).toEqual({ symbol: "T", name: "Tok", decimals: 5 });
  });

  it.each([
    ["HTTP error", () => jsonRes({}, 500)],
    ["non-array result", () => jsonRes({ result: { nope: true } })],
  ])("DAS batch %s falls back to on-chain decimals + placeholder", async (_l, make) => {
    fetchMock.mockResolvedValue(make());
    const m = newMint();
    const r = await mod.fetchTokenMetaBatch(conn(HELIUS), [m]);
    const meta = r.get(m.toBase58())!;
    expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
    expect(meta.decimals).toBe(4);
  });

  it("a DAS batch network error is swallowed and falls back", async () => {
    fetchMock.mockRejectedValue(new TypeError("boom"));
    const m = newMint();
    const r = await mod.fetchTokenMetaBatch(conn(HELIUS), [m]);
    expect(mod.isPlaceholderTokenMeta(r.get(m.toBase58()))).toBe(true);
  });

  it("parses Metaplex PDAs for unresolved mints and applies on-chain decimals", async () => {
    const good = newMint();
    const bad = newMint();
    const c = conn(PLAIN, {
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([
        { data: metaplexBuf("Meta Good", "MGD") },
        { data: Buffer.alloc(10) }, // malformed -> skipped
      ]),
    });
    const r = await mod.fetchTokenMetaBatch(c, [good, bad]);
    expect(r.get(good.toBase58())).toEqual({ symbol: "MGD", name: "Meta Good", decimals: 4 });
    expect(mod.isPlaceholderTokenMeta(r.get(good.toBase58()))).toBe(false);
    expect(mod.isPlaceholderTokenMeta(r.get(bad.toBase58()))).toBe(true);
    expect(r.get(bad.toBase58())?.decimals).toBe(4);
  });

  it.each([
    ["name length over limit", metaplexBuf("x", "Y", { nameLen: 999 })],
    ["name length past buffer", metaplexBuf("x", "Y", { nameLen: 80 })],
    ["buffer ends before symbol length", metaplexBuf("abc", "Y", { trunc: 69 + 3 + 1 })],
    ["symbol length over limit", metaplexBuf("abc", "Y", { symLen: 99 })],
    ["symbol length past buffer", metaplexBuf("abc", "Y", { symLen: 9 })],
    ["empty name", metaplexBuf("", "SYM")],
  ])("batch Metaplex malformed (%s) is skipped", async (_l, buf) => {
    const m = newMint();
    const c = conn(PLAIN, { getMultipleAccountsInfo: vi.fn().mockResolvedValue([{ data: buf }]) });
    const r = await mod.fetchTokenMetaBatch(c, [m]);
    expect(mod.isPlaceholderTokenMeta(r.get(m.toBase58()))).toBe(true);
  });

  it("Metaplex batch RPC failure still yields placeholders using on-chain decimals", async () => {
    const m = newMint();
    const c = conn(PLAIN, { getMultipleAccountsInfo: vi.fn().mockRejectedValue(new Error("rpc")) });
    const r = await mod.fetchTokenMetaBatch(c, [m]);
    expect(mod.isPlaceholderTokenMeta(r.get(m.toBase58()))).toBe(true);
    expect(r.get(m.toBase58())?.decimals).toBe(4);
  });

  it("chunks Metaplex and mint-account RPC calls at 100 keys", async () => {
    const mints = Array.from({ length: 150 }, newMint);
    const c = conn(PLAIN);
    const r = await mod.fetchTokenMetaBatch(c, mints);
    expect(r.size).toBe(150);
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(c.getMultipleParsedAccounts).toHaveBeenCalledTimes(2);
  });

  it("unparseable mint accounts fall back to placeholder with decimals 6", async () => {
    const m = newMint();
    const c = conn(PLAIN, {
      getMultipleParsedAccounts: vi.fn().mockResolvedValue({ value: [{ data: Buffer.alloc(82) }] }),
    });
    const r = await mod.fetchTokenMetaBatch(c, [m]);
    expect(mod.isPlaceholderTokenMeta(r.get(m.toBase58()))).toBe(true);
    expect(r.get(m.toBase58())?.decimals).toBe(6);
  });

  it("parsed mint with no decimals field defaults to 6", async () => {
    const m = newMint();
    const c = conn(PLAIN, {
      getMultipleParsedAccounts: vi.fn().mockResolvedValue({ value: [{ data: { parsed: { info: {} } } }] }),
    });
    const r = await mod.fetchTokenMetaBatch(c, [m]);
    expect(r.get(m.toBase58())?.decimals).toBe(6);
  });

  it("decimals RPC failure fills defaults for every unresolved mint", async () => {
    const m1 = newMint();
    const m2 = newMint();
    const c = conn(PLAIN, { getMultipleParsedAccounts: vi.fn().mockRejectedValue(new Error("rpc")) });
    const r = await mod.fetchTokenMetaBatch(c, [m1, m2]);
    for (const m of [m1, m2]) {
      const meta = r.get(m.toBase58())!;
      expect(mod.isPlaceholderTokenMeta(meta)).toBe(true);
      expect(meta.decimals).toBe(6);
    }
  });

  it("decimals RPC failure keeps a Metaplex-resolved entry intact", async () => {
    const m = newMint();
    const c = conn(PLAIN, {
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([{ data: metaplexBuf("Kept", "KPT") }]),
      getMultipleParsedAccounts: vi.fn().mockRejectedValue(new Error("rpc")),
    });
    const r = await mod.fetchTokenMetaBatch(c, [m]);
    expect(r.get(m.toBase58())).toEqual({ symbol: "KPT", name: "Kept", decimals: 6 });
  });

  it("unparseable mint info with a Metaplex hit leaves the resolved entry alone", async () => {
    const m = newMint();
    const c = conn(PLAIN, {
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([{ data: metaplexBuf("Kept", "KPT") }]),
      getMultipleParsedAccounts: vi.fn().mockResolvedValue({ value: [null] }),
    });
    const r = await mod.fetchTokenMetaBatch(c, [m]);
    expect(mod.isPlaceholderTokenMeta(r.get(m.toBase58()))).toBe(false);
    expect(r.get(m.toBase58())?.symbol).toBe("KPT");
  });

  it("placeholders are cached for the TTL then retried", async () => {
    vi.useFakeTimers();
    const m = newMint();
    const c = conn(PLAIN);
    await mod.fetchTokenMetaBatch(c, [m]);
    await mod.fetchTokenMetaBatch(c, [m]);
    expect(c.getMultipleParsedAccounts).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(mod.PLACEHOLDER_TTL_MS + 1);
    await mod.fetchTokenMetaBatch(c, [m]);
    expect(c.getMultipleParsedAccounts).toHaveBeenCalledTimes(2);
  });
});

describe("isPlaceholderTokenMeta", () => {
  it("is false for null, undefined and ordinary objects", () => {
    expect(mod.isPlaceholderTokenMeta(null)).toBe(false);
    expect(mod.isPlaceholderTokenMeta(undefined)).toBe(false);
    expect(mod.isPlaceholderTokenMeta({ symbol: "A", name: "B", decimals: 1 })).toBe(false);
  });
});

describe("env override: NEXT_PUBLIC_TEST_USDC_MINT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a custom sim-USDC mint resolves as USDC without any fetch", async () => {
    const custom = newMint();
    vi.stubEnv("NEXT_PUBLIC_TEST_USDC_MINT", `  ${custom.toBase58()}  `);
    vi.resetModules();
    const m = await import("@/lib/tokenMeta");
    const meta = await m.fetchTokenMeta(conn(PLAIN), custom);
    expect(meta.symbol).toBe("USDC");
    expect(meta.name).toBe("Sim USDC (devnet)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

describe("fetchTokenMeta: Unicode names and placeholder retry", () => {
  it("keeps a non-ASCII token name (same as the batch path does)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ pairs: [{ baseToken: { symbol: "CHII", name: "ちいかわ" } }] }));
    const meta = await mod.fetchTokenMeta(conn(PLAIN), newMint());
    expect(meta.name).toBe("ちいかわ");
    expect(meta.symbol).toBe("CHII");
  });

  it("ignores a cached placeholder and looks the mint up again", async () => {
    const mint = newMint();
    const c = conn(PLAIN);
    const first = await mod.fetchTokenMeta(c, mint);
    expect(mod.isPlaceholderTokenMeta(first)).toBe(true);
    fetchMock.mockResolvedValueOnce(jsonRes({ pairs: [{ baseToken: { symbol: "REAL", name: "Real Coin" } }] }));
    const second = await mod.fetchTokenMeta(c, mint);
    expect(second).toEqual({ symbol: "REAL", name: "Real Coin", decimals: 9 });
    expect(c.getParsedAccountInfo).toHaveBeenCalledTimes(2);
  });
});
