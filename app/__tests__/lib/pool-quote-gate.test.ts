import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { classifyPoolAccount, classifyPoolsByOwner, isOfferable } from "@/lib/dex-pool-owner";
import { USD_PRICEABLE_QUOTE_MINTS } from "@/lib/dex-constants";
import { CARDS, DAMM_V1, METEORA, MM, PUMPSWAP, RAYDIUM, USDC, USDT, WSOL, meteoraPool, pumpswapPool } from "./pool-quote-gate-fixtures";

const pk = () => Keypair.generate().publicKey;

describe("classifyPoolAccount: the quote mint gate", () => {
  it.each([
    ["PumpSwap", PUMPSWAP, pumpswapPool, "pumpswap"],
    ["Meteora DLMM", METEORA, meteoraPool, "meteora-dlmm"],
  ] as const)("%s: WSOL / USDC / USDT quotes pass, anything else is non-usd-quote", (_n, owner, build, type) => {
    for (const q of [WSOL, USDC, USDT]) expect(classifyPoolAccount(pk(), owner, build(q))).toEqual({ cls: type });
    for (const q of [MM, CARDS]) {
      const r = classifyPoolAccount(pk(), owner, build(q));
      expect(r).toEqual({ cls: "non-usd-quote", quoteMint: q });
      expect(isOfferable(r.cls)).toBe(false);
    }
  });

  it("a truncated or garbage pool account is unsupported, never waved through", () => {
    expect(classifyPoolAccount(pk(), PUMPSWAP, new Uint8Array(100)).cls).toBe("unsupported");
    expect(classifyPoolAccount(pk(), METEORA, new Uint8Array(10)).cls).toBe("unsupported");
  });

  it("owner rules are unchanged: DAMM unsupported, Raydium CLMM keeps its own class", () => {
    expect(classifyPoolAccount(pk(), DAMM_V1, meteoraPool(MM)).cls).toBe("unsupported");
    expect(classifyPoolAccount(pk(), RAYDIUM, new Uint8Array(1544)).cls).toBe("raydium-clmm");
  });

  it("the allow-list is exactly WSOL + the two USD stables (mirrors the keeper's quoteIsNotUsdOrWsol)", () => {
    expect([...USD_PRICEABLE_QUOTE_MINTS].sort()).toEqual([WSOL, USDC, USDT].sort());
  });
});

describe("classifyPoolsByOwner carries the quote verdict through one RPC call", () => {
  it("mixed batch", async () => {
    const [a, b, c] = [pk(), pk(), pk()];
    const accts = new Map([
      [a.toBase58(), { owner: new PublicKey(METEORA), data: meteoraPool(MM) }],
      [b.toBase58(), { owner: new PublicKey(METEORA), data: meteoraPool(WSOL) }],
      [c.toBase58(), { owner: new PublicKey(PUMPSWAP), data: pumpswapPool(CARDS) }],
    ]);
    const conn = { getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map((k) => accts.get(k.toBase58()) ?? null)) };
    const r = await classifyPoolsByOwner([a.toBase58(), b.toBase58(), c.toBase58()], conn as never);
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ [a.toBase58()]: "non-usd-quote", [b.toBase58()]: "meteora-dlmm", [c.toBase58()]: "non-usd-quote" });
  });
});
