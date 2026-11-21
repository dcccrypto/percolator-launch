// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  resolveMarketLp: vi.fn(),
}));

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: mocks.resolveMarketLp,
}));

import {
  resolveLpAccounts,
  invalidateLpAccounts,
} from "@/lib/limits/lp-discovery";

const makeLp = () => ({
  pubkey: Keypair.generate().publicKey,
  matcherCtx: Keypair.generate().publicKey,
});

const makeConnection = () => ({
  getAccountInfo: vi.fn(async () => null),
  getProgramAccounts: vi.fn(async () => []),
});

beforeEach(() => {
  mocks.resolveMarketLp.mockReset();
});

describe("LP limits canonical resolver integration", () => {
  it("POSITIVE: returns the canonical LP and matcher context", async () => {
    const program = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const canonical = makeLp();
    const connection = makeConnection();

    mocks.resolveMarketLp.mockResolvedValue(canonical);

    const result = await resolveLpAccounts(
      connection as never, program, market,
    );

    expect(result?.lpPortfolio.equals(canonical.pubkey)).toBe(true);
    expect(result?.matcherCtx?.equals(canonical.matcherCtx)).toBe(true);
    expect(mocks.resolveMarketLp).toHaveBeenCalledOnce();
  });

  it("NEGATIVE: cannot independently select a foreign matcher", async () => {
    const program = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const attacker = makeLp();
    const canonical = makeLp();
    const connection = makeConnection();

    connection.getProgramAccounts.mockResolvedValue([
      { pubkey: attacker.pubkey, account: { data: new Uint8Array() } },
      { pubkey: canonical.pubkey, account: { data: new Uint8Array() } },
    ] as never);

    mocks.resolveMarketLp.mockResolvedValue(canonical);

    const result = await resolveLpAccounts(
      connection as never, program, market,
    );

    expect(result?.lpPortfolio.equals(canonical.pubkey)).toBe(true);
    expect(result?.lpPortfolio.equals(attacker.pubkey)).toBe(false);
    expect(mocks.resolveMarketLp).toHaveBeenCalledOnce();

    // The limits resolver must not perform its own unsafe first-match scan.
    expect(connection.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("NEGATIVE: invalidation forces fresh canonical resolution", async () => {
    const program = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const stale = makeLp();
    const current = makeLp();
    const connection = makeConnection();

    mocks.resolveMarketLp
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(current);

    const first = await resolveLpAccounts(
      connection as never, program, market,
    );

    invalidateLpAccounts(program, market);

    const second = await resolveLpAccounts(
      connection as never, program, market,
    );

    expect(first?.lpPortfolio.equals(stale.pubkey)).toBe(true);
    expect(second?.lpPortfolio.equals(current.pubkey)).toBe(true);
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2);
  });

  it("NEGATIVE: invalidation clears known-LP cache variants", async () => {
    const program = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const known = Keypair.generate().publicKey;
    const old = makeLp();
    const updated = makeLp();
    const connection = makeConnection();

    mocks.resolveMarketLp
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(updated);

    await resolveLpAccounts(
      connection as never, program, market, known,
    );

    invalidateLpAccounts(program, market);

    const result = await resolveLpAccounts(
      connection as never, program, market, known,
    );

    expect(result?.lpPortfolio.equals(updated.pubkey)).toBe(true);
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2);
    expect(mocks.resolveMarketLp).toHaveBeenLastCalledWith(
      connection, program, market, known,
    );
  });
});
