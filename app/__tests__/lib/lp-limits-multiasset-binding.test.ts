// @vitest-environment node

import {
  beforeEach, afterEach, describe, expect, it, vi,
} from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { v22BlankMarket, v22BlankPortfolio } from "../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { decodeAssetVaultLp } from "@/lib/limits/decode";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import * as C from "@/lib/limits/constants";

const mocks = vi.hoisted(() => ({
  resolveMarketLp: vi.fn(),
}));

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: mocks.resolveMarketLp,
}));

import {
  resolveLpAccounts,
  type LpAccounts,
} from "@/lib/limits/lp-discovery";

function fixture(useAssetOneLp: boolean) {
  const program = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;

  const lp0 = Keypair.generate().publicKey;
  const lp1 = Keypair.generate().publicKey;

  const marketData = v22BlankMarket(2);
  const offsets = marketOffsets(marketData);

  for (const [index, lp] of [lp0, lp1].entries()) {
    const base =
      offsets.wrapperOff(index) + C.ASSET_VAULT_LP_OFF;

    marketData.set(
      lp.toBytes(),
      base + C.AV_VAULT_LP_PORTFOLIO,
    );
    marketData[base + C.AV_FLAGS] =
      C.ASSET_VAULT_LP_FLAG_BOUND;
  }

  const knownLp = useAssetOneLp ? lp1 : lp0;

  const portfolio = v22BlankPortfolio();
  portfolio.set(market.toBytes(), 16);
  portfolio.set(knownLp.toBytes(), 48);

  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) =>
      key.equals(market)
        ? { owner: program, data: marketData }
        : key.equals(knownLp)
          ? { owner: program, data: portfolio }
          : null
    ),
    getProgramAccounts: vi.fn(async () => []),
  };

  return {
    program, market, lp0, lp1,
    knownLp, marketData, connection,
  };
}

async function resolveForAssetOne(
  f: ReturnType<typeof fixture>,
): Promise<LpAccounts | null> {
  // Reflect.apply permits a fifth argument before the
  // production function signature has been updated.
  return await Reflect.apply(
    resolveLpAccounts,
    undefined,
    [
      f.connection,
      f.program,
      f.market,
      f.knownLp,
      1,
    ],
  ) as LpAccounts | null;
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  mocks.resolveMarketLp.mockReset();
  mocks.resolveMarketLp.mockResolvedValue(null);
});

afterEach(() => {
  __setDevnetV22ForTest(null);
});

describe("Asset-index isolation in bound vault fallback", () => {
  it("POSITIVE: resolves asset 1's own bound vault LP", async () => {
    const f = fixture(true);

    expect(decodeAssetVaultLp(f.marketData, 0)?.bound).toBe(true);
    expect(decodeAssetVaultLp(f.marketData, 1)?.bound).toBe(true);

    const result = await resolveForAssetOne(f);

    expect(result?.lpPortfolio.equals(f.lp1)).toBe(true);
    expect(result?.matcherCtx).toBeNull();
  });

  it("NEGATIVE: rejects asset 0's LP when reading asset 1", async () => {
    const f = fixture(false);

    expect(decodeAssetVaultLp(f.marketData, 1)?.bound).toBe(true);

    const result = await resolveForAssetOne(f);

    expect(result).toBeNull();
  });
});

describe("Multi-asset LP cache isolation", () => {
  it("NEGATIVE: asset 0 cached LP must not be reused for asset 1", async () => {
    const f = fixture(false);

    const first = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.lp0,
      0,
    );

    expect(first?.lpPortfolio.equals(f.lp0)).toBe(true);

    const second = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.lp0,
      1,
    );

    expect(second).toBeNull();
  });
});

describe("Canonical-first asset isolation", () => {
  it("POSITIVE: asset 0 accepts its own canonical LP", async () => {
    const f = fixture(false);
    const ctx = Keypair.generate().publicKey;

    mocks.resolveMarketLp.mockResolvedValue({
      pubkey: f.lp0,
      matcherCtx: ctx,
    });

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.lp0,
      0,
    );

    expect(result?.lpPortfolio.equals(f.lp0)).toBe(true);
    expect(result?.matcherCtx?.equals(ctx)).toBe(true);
  });

  it("NEGATIVE: asset 1 must not accept asset 0's canonical LP", async () => {
    const f = fixture(true);
    const ctx = Keypair.generate().publicKey;

    // Model the asset-0-only canonical resolver result.
    mocks.resolveMarketLp.mockResolvedValue({
      pubkey: f.lp0,
      matcherCtx: ctx,
    });

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      f.lp1,
      1,
    );

    // Asset 0 cannot displace asset 1's bound vault LP.
    expect(result?.lpPortfolio.equals(f.lp0)).toBe(false);
    expect(result?.lpPortfolio.equals(f.lp1)).toBe(true);
    expect(result?.matcherCtx).toBeNull();
  });
});

describe("Asset-specific fail-closed behavior", () => {
  it("NEGATIVE: asset 1 without bound vault fails closed", async () => {
    const f = fixture(true);

    mocks.resolveMarketLp.mockResolvedValue({
      pubkey: f.lp0,
      matcherCtx: Keypair.generate().publicKey,
    });

    const result = await resolveLpAccounts(
      f.connection as never,
      f.program,
      f.market,
      null,
      1,
    );

    expect(result).toBeNull();
    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();
  });
});
