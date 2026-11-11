// @vitest-environment node
/**
 * Council r5 #2: the whole USD-stable class is not a perp underlying on v2.2.
 *  - every verified mint is refused (and the list is well-formed);
 *  - the exact-ticker symbol / name rule (hard block) vs the looser lookalike pattern (warning only);
 *  - server-side resolution (checkStablecoinUnderlying): pool-only registration is resolved to the pool's base mint and checked,
 *    an unresolvable pool-only request is refused, the on-chain symbol is read from Metaplex / Token-2022 metadata.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST, STABLECOIN_PERP_MINTS, isStablecoinPerpBlocked, stablecoinIdentityVerdict } from "@/lib/v22/stablecoin-perps";
import { checkStablecoinUnderlying, parseMetaplexNameSymbol, parseToken2022NameSymbol } from "@/lib/v22/stablecoin-resolve";
import { METEORA, PUMPSWAP, RAYDIUM, USDC, WSOL } from "./pool-quote-gate-fixtures";

const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";

describe("the verified mint list", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterAll(() => __setDevnetV22ForTest(null));

  it("covers every required stable (symbol -> address)", () => {
    const by = Object.fromEntries(STABLECOIN_MINT_LIST.map((m) => [m.symbol, m.address]));
    const required: Record<string, string> = {
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      PYUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      USDS: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
      FDUSD: "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u",
      USDe: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT",
      sUSDe: "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN",
      USDG: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
      USD1: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
      AUSD: "AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9",
      USDY: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
      USDH: "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",
      UXD: "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT",
      DAI: "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o",
      USDCet: "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM",
      USDTet: "Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1",
    };
    for (const [sym, addr] of Object.entries(required)) expect(by[sym], sym).toBe(addr);
  });

  it("is well-formed: unique, valid 32-byte keys, canonical base58, a source on every entry", () => {
    expect(new Set(STABLECOIN_MINT_LIST.map((m) => m.address)).size).toBe(STABLECOIN_MINT_LIST.length);
    expect(STABLECOIN_PERP_MINTS.size).toBe(STABLECOIN_MINT_LIST.length);
    for (const m of STABLECOIN_MINT_LIST) {
      expect(new PublicKey(m.address).toBase58(), m.symbol).toBe(m.address);
      expect(m.source.length, m.symbol).toBeGreaterThan(8);
      expect(m.symbol.length).toBeGreaterThan(0);
    }
  });

  it.each(STABLECOIN_MINT_LIST.map((m) => [m.symbol, m.address] as const))("%s is blocked on v2.2 (and trimmed input too)", (_s, addr) => {
    expect(isStablecoinPerpBlocked(addr)).toBe(true);
    expect(isStablecoinPerpBlocked(`  ${addr}\n`)).toBe(true);
  });

  it("blocks nothing off v2.2; does not block a normal token or WSOL; EURC (not USD) stays unblocked", () => {
    for (const m of STABLECOIN_MINT_LIST) {
      __setDevnetV22ForTest(false);
      expect(isStablecoinPerpBlocked(m.address)).toBe(false);
    }
    __setDevnetV22ForTest(true);
    for (const ok of [CONTROL, WSOL, "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr" /* EURC */]) expect(isStablecoinPerpBlocked(ok)).toBe(false);
  });
});

describe("symbol / name rule", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterAll(() => __setDevnetV22ForTest(null));

  it.each(["USDC", "usdc", "$USDC", "USDT", "USD₮", "PYUSD", "USDS", "FDUSD", "USDe", "sUSDe", "USDG", "DAI", "sDAI", "USD1", "AUSD", "USDY", "USDH", "UXD", "hyUSD", "frxUSD", "UST", "USDC.e", "USDCet", "USDTbs", "wUSDC", "aeUSDC", "apUSDT", "jlUSDC", "USDCpo"])(
    "symbol %s is a hard block",
    (symbol) => {
      expect(stablecoinIdentityVerdict({ symbol })).toBe("block");
      expect(isStablecoinPerpBlocked(CONTROL, { symbol })).toBe(true);
    },
  );

  it.each(["USD Coin", "Tether USD", "Tether USD (Portal from Ethereum)", "PayPal USD", "First Digital USD", "Global Dollar", "Dai Stablecoin", "Wrapped USDC (Allbridge from Ethereum)", "USDe", "World Liberty Financial USD"])(
    "name %s is a hard block",
    (name) => expect(stablecoinIdentityVerdict({ symbol: "XYZ", name })).toBe("block"),
  );

  it.each(["SOL", "BONK", "WIF", "JUP", "DAIKO", "DAISY", "DAINU", "USDUC", "USDP", "USDARK", "EURC", "XAUT", "PUMP", "e/acc", "USDT0X", "JUST", "BUST", "SUST", "AUST", "XUST", "WUST", "STUST", "JLUST", "USTET", "TRUST"])(
    "symbol %s is NOT a hard block (memecoins / non-USD / non-stable)",
    (symbol) => expect(stablecoinIdentityVerdict({ symbol })).not.toBe("block"),
  );

  it.each(["Tether Gold", "Daily Dive", "USD Coin Maxi", "Euro Coin", "Wrapped SOL"])("name %s is NOT a hard block", (name) =>
    expect(stablecoinIdentityVerdict({ symbol: "ZZZ", name })).not.toBe("block"),
  );

  it("a USD-ish lookalike (USDUC, 'Unstable Coin') is only a warning, never a refusal", () => {
    expect(stablecoinIdentityVerdict({ symbol: "USDUC", name: "Unstable Coin" })).toBe("suspect");
    expect(isStablecoinPerpBlocked(CONTROL, { symbol: "USDUC", name: "Unstable Coin" })).toBe(false);
    expect(stablecoinIdentityVerdict({ symbol: "SOL", name: "Solana" })).toBeNull();
  });

  it("changes nothing off v2.2", () => {
    __setDevnetV22ForTest(false);
    expect(isStablecoinPerpBlocked(CONTROL, { symbol: "USDC" })).toBe(false);
  });
});

// ---- server-side resolution ----------------------------------------------------------------------------------------------
type Acct = { owner: PublicKey; data: Buffer } | null;
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const pda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];
const bstr = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
function metaplexAccount(name: string, symbol: string): Acct {
  return { owner: METAPLEX, data: Buffer.concat([Buffer.alloc(65), bstr(name), bstr(symbol), Buffer.alloc(40)]) };
}
function token2022Mint(name: string, symbol: string): Acct {
  const tlvValue = Buffer.concat([Buffer.alloc(64), bstr(name), bstr(symbol), bstr("")]);
  const hdr = Buffer.alloc(4); hdr.writeUInt16LE(19, 0); hdr.writeUInt16LE(tlvValue.length, 2);
  const base = Buffer.alloc(166); // 82-byte mint + padding to 165 + account-type byte
  return { owner: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), data: Buffer.concat([base, hdr, tlvValue]) };
}
function pumpPool(base: string, quote: string): Acct {
  const d = Buffer.alloc(301);
  new PublicKey(base).toBuffer().copy(d, 43);
  new PublicKey(quote).toBuffer().copy(d, 75);
  return { owner: new PublicKey(PUMPSWAP), data: d };
}
function dlmmPool(base: string, quote: string): Acct {
  const d = Buffer.alloc(904);
  new PublicKey(base).toBuffer().copy(d, 88);
  new PublicKey(quote).toBuffer().copy(d, 120);
  return { owner: new PublicKey(METEORA), data: d };
}
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/**
 * Fake mainnet. Mint accounts the check reads (a key followed by its Metaplex PDA) are synthesised as SPL mints when the map has none,
 * unless `missingMints` is set (then an absent mint account stays absent).
 */
function fakeConn(accounts: Map<string, Acct>, opts: { fail?: boolean; missingMints?: boolean } = {}) {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (opts.fail) throw new Error("rpc down");
      return keys.map((k, i) => {
        const a = accounts.get(k.toBase58());
        if (a) return a;
        const isMintSlot = i + 1 < keys.length && keys[i + 1].equals(pda(k));
        return isMintSlot && !opts.missingMints ? ({ owner: SPL_TOKEN, data: Buffer.alloc(82) } as Acct) : null;
      });
    },
  } as unknown as Parameters<typeof checkStablecoinUnderlying>[0]["conn"];
}
const USDS = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
const FDUSD = "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u";
const pool = () => Keypair.generate().publicKey.toBase58();

describe("metadata parsers", () => {
  it("reads name / symbol from Metaplex and Token-2022 metadata", () => {
    expect(parseMetaplexNameSymbol(new Uint8Array(metaplexAccount("USD Coin", "USDC")!.data))).toEqual({ name: "USD Coin", symbol: "USDC" });
    expect(parseToken2022NameSymbol(new Uint8Array(token2022Mint("PayPal USD", "PYUSD")!.data))).toEqual({ name: "PayPal USD", symbol: "PYUSD" });
    expect(parseMetaplexNameSymbol(new Uint8Array(10))).toBeNull();
    expect(parseToken2022NameSymbol(new Uint8Array(82))).toBeNull();
  });
});

describe("checkStablecoinUnderlying", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterAll(() => __setDevnetV22ForTest(null));

  it("flag off: always ok, no chain read", async () => {
    __setDevnetV22ForTest(false);
    const r = await checkStablecoinUnderlying({ pool: pool(), mainnetCa: USDS, symbol: "USDC", conn: fakeConn(new Map(), { fail: true }) });
    expect(r).toEqual({ ok: true });
  });

  it("address on mainnet_ca / client symbol are refused without any chain read", async () => {
    const conn = fakeConn(new Map(), { fail: true });
    expect(await checkStablecoinUnderlying({ mainnetCa: USDS, conn })).toEqual({ ok: false, kind: "stablecoin" });
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, symbol: "FDUSD", conn })).toEqual({ ok: false, kind: "stablecoin" });
  });

  it.each([
    ["PumpSwap", pumpPool],
    ["Meteora DLMM", dlmmPool],
  ] as const)("POOL-ONLY (%s): a pool whose base mint is USDS / FDUSD is refused", async (_n, build) => {
    for (const base of [USDS, FDUSD]) {
      const p = pool();
      const r = await checkStablecoinUnderlying({ pool: p, conn: fakeConn(new Map([[p, build(base, USDC)]])) });
      expect(r, base).toEqual({ ok: false, kind: "stablecoin" });
    }
  });

  it("POOL-ONLY: a stable on the quote side outside the keeper's USD set is refused too", async () => {
    const p = pool();
    expect(await checkStablecoinUnderlying({ pool: p, conn: fakeConn(new Map([[p, pumpPool(CONTROL, USDS)]])) })).toEqual({ ok: false, kind: "stablecoin" });
  });

  it("POOL-ONLY: a normal token / USDC-quoted pool passes; a SOL/USDC pool (base WSOL) passes", async () => {
    const a = pool(), b = pool();
    const conn = fakeConn(new Map([[a, pumpPool(CONTROL, USDC)], [b, dlmmPool(WSOL, USDC)]]));
    expect(await checkStablecoinUnderlying({ pool: a, conn })).toEqual({ ok: true });
    expect(await checkStablecoinUnderlying({ pool: b, conn })).toEqual({ ok: true });
  });

  it("POOL-ONLY: an unreadable pool is refused, never waved through (rpc failure = retryable; missing / unsupported / truncated = not)", async () => {
    const missing = pool(), raydium = pool(), trunc = pool();
    const conn = fakeConn(new Map([[raydium, { owner: new PublicKey(RAYDIUM), data: Buffer.alloc(1544) }], [trunc, { owner: new PublicKey(PUMPSWAP), data: Buffer.alloc(40) }]]));
    expect(await checkStablecoinUnderlying({ pool: pool(), conn: fakeConn(new Map(), { fail: true }) })).toEqual({ ok: false, kind: "unverifiable", retryable: true });
    expect(await checkStablecoinUnderlying({ pool: missing, conn })).toEqual({ ok: false, kind: "unverifiable", retryable: false });
    expect(await checkStablecoinUnderlying({ pool: trunc, conn })).toEqual({ ok: false, kind: "unverifiable", retryable: false });
  });

  it("an unreadable pool is refused EVEN with a mainnet_ca (the pool is what gets priced)", async () => {
    const missing = pool();
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, pool: missing, conn: fakeConn(new Map()) })).toEqual({ ok: false, kind: "unverifiable", retryable: false });
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, pool: pool(), conn: fakeConn(new Map(), { fail: true }) })).toEqual({ ok: false, kind: "unverifiable", retryable: true });
  });

  it("a mainnet_ca must equal the pool's base mint: match passes, mismatch is refused; a stable base is still a stablecoin refusal", async () => {
    const p = pool();
    const conn = fakeConn(new Map([[p, pumpPool(CONTROL, USDC)]]));
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, pool: p, conn })).toEqual({ ok: true });
    expect(await checkStablecoinUnderlying({ mainnetCa: Keypair.generate().publicKey.toBase58(), pool: p, conn })).toEqual({ ok: false, kind: "mismatch" });
    const q = pool();
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, pool: q, conn: fakeConn(new Map([[q, pumpPool(FDUSD, USDC)]])) })).toEqual({ ok: false, kind: "stablecoin" });
  });

  it("Token-2022 metadata is used when a Metaplex account exists but does not parse", async () => {
    const m = Keypair.generate().publicKey;
    const accts = new Map<string, Acct>([
      [pda(m).toBase58(), { owner: METAPLEX, data: Buffer.alloc(10) }],
      [m.toBase58(), token2022Mint("Some Dollar", "USDS")],
    ]);
    expect(await checkStablecoinUnderlying({ mainnetCa: m.toBase58(), conn: fakeConn(accts) })).toEqual({ ok: false, kind: "stablecoin" });
  });

  it("ON-CHAIN symbol: an unlisted mint whose Metaplex / Token-2022 metadata is a stable identity is refused; a memecoin lookalike only warns", async () => {
    const m1 = Keypair.generate().publicKey, m2 = Keypair.generate().publicKey, m3 = Keypair.generate().publicKey;
    const accts = new Map<string, Acct>([
      [pda(m1).toBase58(), metaplexAccount("Brand New Dollar", "USDC")],
      [m2.toBase58(), token2022Mint("Some Dollar", "FDUSD")],
      [pda(m3).toBase58(), metaplexAccount("Unstable Coin", "USDUC")],
    ]);
    const conn = fakeConn(accts);
    expect(await checkStablecoinUnderlying({ mainnetCa: m1.toBase58(), conn })).toEqual({ ok: false, kind: "stablecoin" });
    expect(await checkStablecoinUnderlying({ mainnetCa: m2.toBase58(), conn })).toEqual({ ok: false, kind: "stablecoin" });
    const warn = await checkStablecoinUnderlying({ mainnetCa: m3.toBase58(), conn });
    expect(warn.ok).toBe(true);
    expect((warn as { suspect?: string }).suspect).toMatch(/USDUC/);
  });

  it("a failed metadata READ (RPC error) fails closed as retryable; an absent metadata account does not block a clean mint", async () => {
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, conn: fakeConn(new Map(), { fail: true }) })).toEqual({ ok: false, kind: "unverifiable", retryable: true });
    expect(await checkStablecoinUnderlying({ mainnetCa: CONTROL, conn: fakeConn(new Map()) })).toEqual({ ok: true });
  });

  it("r7: a mainnet_ca whose mint account is missing, or not owned by SPL Token / Token-2022, is refused (not retryable)", async () => {
    const refused = { ok: false, kind: "unverifiable", retryable: false };
    expect(await checkStablecoinUnderlying({ mainnetCa: Keypair.generate().publicKey.toBase58(), conn: fakeConn(new Map(), { missingMints: true }) })).toEqual(refused);
    const sys = new PublicKey("11111111111111111111111111111111");
    const wallet = Keypair.generate().publicKey;
    const conn = fakeConn(new Map<string, Acct>([[wallet.toBase58(), { owner: sys, data: Buffer.alloc(0) }], [sys.toBase58(), { owner: new PublicKey("NativeLoader1111111111111111111111111111111"), data: Buffer.alloc(0) }]]));
    expect(await checkStablecoinUnderlying({ mainnetCa: wallet.toBase58(), conn })).toEqual(refused);
    expect(await checkStablecoinUnderlying({ mainnetCa: sys.toBase58(), conn })).toEqual(refused);
    // Token-2022 mints are fine
    const t22 = Keypair.generate().publicKey;
    expect(await checkStablecoinUnderlying({ mainnetCa: t22.toBase58(), conn: fakeConn(new Map<string, Acct>([[t22.toBase58(), token2022Mint("Okay", "OKAY")]])) })).toEqual({ ok: true });
  });
});
