// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { v22BlankMarket, v22BlankPortfolio } from "../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { decodeAssetVaultLp } from "@/lib/limits/decode";
import { isPortfolioAccount } from "@/lib/portfolio-account";
import * as C from "@/lib/limits/constants";

const mocks = vi.hoisted(() => ({
  resolveMarketLp: vi.fn(),
}));

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: mocks.resolveMarketLp,
}));

import { resolveLpAccounts } from "@/lib/limits/lp-discovery";

function fixture() {
  const program = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const knownLp = Keypair.generate().publicKey;

  const marketData = v22BlankMarket();
  const base =
    marketOffsets(marketData).wrapperOff(0) +
    C.ASSET_VAULT_LP_OFF;

  marketData.set(
    knownLp.toBytes(),
    base + C.AV_VAULT_LP_PORTFOLIO,
  );
  marketData[base + C.AV_FLAGS] =
    C.ASSET_VAULT_LP_FLAG_BOUND;

  const data = v22BlankPortfolio();
  data.set(market.toBytes(), 16);
  data.set(knownLp.toBytes(), 48);

  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) =>
      key.equals(market)
        ? { owner: program, data: marketData }
        : key.equals(knownLp)
          ? { owner: program, data }
          : null
    ),
    getProgramAccounts: vi.fn(async () => []),
  };

  return {
    program, market, knownLp,
    marketData, data, base, connection,
  };
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  mocks.resolveMarketLp.mockReset();
});

afterEach(() => {
  __setDevnetV22ForTest(null);
});

describe("Verified bound vault LP compatibility", () => {
  it("POSITIVE: preserves a valid bound vault portfolio with disabled matcher", async () => {
    const f = fixture();

    const binding = decodeAssetVaultLp(f.marketData, 0);

    expect(binding?.bound).toBe(true);
    expect(
      new PublicKey(binding!.vaultLpPortfolio).equals(f.knownLp),
    ).toBe(true);
    expect(isPortfolioAccount(f.data)).toBe(true);

    mocks.resolveMarketLp.mockResolvedValue(null);

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.knownLp,
    );

    expect(result?.lpPortfolio.equals(f.knownLp)).toBe(true);
    expect(result?.matcherCtx).toBeNull();
  });

  it("POSITIVE: preserves the verified bound vault during canonical resolver RPC failure", async () => {
    const f = fixture();

    mocks.resolveMarketLp.mockRejectedValue(
      new Error("getProgramAccounts: RPC 429"),
    );

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.knownLp,
    );

    expect(result?.lpPortfolio.equals(f.knownLp)).toBe(true);
    expect(result?.matcherCtx).toBeNull();
  });

  it("NEGATIVE: rejects an unbound vault portfolio", async () => {
    const f = fixture();

    f.marketData.fill(
      0,
      f.base + C.AV_VAULT_LP_PORTFOLIO,
      f.base + C.AV_VAULT_LP_PORTFOLIO + 32,
    );
    f.marketData[f.base + C.AV_FLAGS] = 0;

    mocks.resolveMarketLp.mockResolvedValue(null);

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.knownLp,
    );

    expect(result).toBeNull();
  });

  it("NEGATIVE: rejects a portfolio belonging to another market", async () => {
    const f = fixture();

    f.data.set(Keypair.generate().publicKey.toBytes(), 16);

    mocks.resolveMarketLp.mockResolvedValue(null);

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.knownLp,
    );

    expect(result).toBeNull();
  });
});

describe("Bound vault fallback security controls", () => {
  it("rejects a market not owned by the wrapper program", async () => {
    const f = fixture();
    const foreignOwner = Keypair.generate().publicKey;

    mocks.resolveMarketLp.mockResolvedValue(null);

    f.connection.getAccountInfo.mockImplementation(async (key: PublicKey) =>
      key.equals(f.market)
        ? { owner: foreignOwner, data: f.marketData }
        : key.equals(f.knownLp)
          ? { owner: f.program, data: f.data }
          : null
    );

    expect(await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    )).toBeNull();
  });

  it("rejects a portfolio owned by a foreign program", async () => {
    const f = fixture();
    const foreignOwner = Keypair.generate().publicKey;

    mocks.resolveMarketLp.mockResolvedValue(null);

    f.connection.getAccountInfo.mockImplementation(async (key: PublicKey) =>
      key.equals(f.market)
        ? { owner: f.program, data: f.marketData }
        : key.equals(f.knownLp)
          ? { owner: foreignOwner, data: f.data }
          : null
    );

    expect(await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    )).toBeNull();
  });

  it("rejects an incorrect immutable portfolio account ID", async () => {
    const f = fixture();

    f.data.set(Keypair.generate().publicKey.toBytes(), 48);
    mocks.resolveMarketLp.mockResolvedValue(null);

    expect(await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    )).toBeNull();
  });

  it("rejects a non-portfolio account kind", async () => {
    const f = fixture();

    f.data[10] = 5;
    mocks.resolveMarketLp.mockResolvedValue(null);

    expect(await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    )).toBeNull();
  });

  it("rejects a market bound to a different LP", async () => {
    const f = fixture();

    f.marketData.set(
      Keypair.generate().publicKey.toBytes(),
      f.base + C.AV_VAULT_LP_PORTFOLIO,
    );

    mocks.resolveMarketLp.mockResolvedValue(null);

    expect(await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    )).toBeNull();
  });

  it("does not reuse a fallback after vault binding is revoked", async () => {
    const f = fixture();

    mocks.resolveMarketLp.mockResolvedValue(null);

    const before = await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    );

    expect(before?.lpPortfolio.equals(f.knownLp)).toBe(true);

    f.marketData.fill(
      0,
      f.base + C.AV_VAULT_LP_PORTFOLIO,
      f.base + C.AV_VAULT_LP_PORTFOLIO + 32,
    );
    f.marketData[f.base + C.AV_FLAGS] = 0;

    const after = await resolveLpAccounts(
      f.connection as never, f.program, f.market, f.knownLp,
    );

    expect(after).toBeNull();
  });
});
