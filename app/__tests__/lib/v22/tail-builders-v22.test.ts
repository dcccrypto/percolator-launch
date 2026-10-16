// @vitest-environment node
/**
 * Review item 1c / 3: tags 78 (pre-resolve crank) and 97 (junior withdraw) on a market with a P2b ext and / or a bond
 * tranche are built with the SDK's tail-aware builders, against ACCOUNT_TAILS_V22; a mismatch is a calm error in EVERY environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, ACCOUNT_TAILS_V22, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, buildWithdrawJuniorTrancheIxV22, deriveBondTrancheV22 } from "@/lib/v22/sdk";
import { MARKET_TAIL_CALM_LINE, MarketTailMismatchError, __setTailsClockForTest, applyMarketTailsV22, withMarketTailsV22 } from "@/lib/v22/market-tails";
import { buildLpCrankIx } from "@/lib/pre-resolve";
import { buildWithdrawJuniorTrancheIx, type VaultLpMarket } from "@/lib/limits/p3-ix";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError } from "@/lib/errorMessages";

const k = () => Keypair.generate().publicKey;
const prog = k();
const market = k();
const lp = k();
const ext = k();
const tranche = deriveBondTrancheV22(prog, market)[0];

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setTailsClockForTest(null);
});
afterEach(() => __setDevnetV22ForTest(null));

describe("tag 78: pre-resolve crank", () => {
  it("bond market: 10 accounts = 6 base + state[6] + ext[7] + LP[8] (WRITABLE) + tranche[9]; completes against the tail index with no mismatch", () => {
    const ix = buildLpCrankIx(prog, k(), market, 0, true, { lpPortfolio: lp, vaultLpExt: ext, bond: true });
    expect(ix.data[0]).toBe(78);
    expect(ix.keys).toHaveLength(ACCOUNT_TAILS_V22[78].bondTranche + 1);
    expect(ix.keys[ACCOUNT_TAILS_V22[78].ext].pubkey.equals(ext)).toBe(true);
    expect(ix.keys[ACCOUNT_TAILS_V22[78].boundLp].pubkey.equals(lp)).toBe(true);
    expect(ix.keys[ACCOUNT_TAILS_V22[78].boundLp].isWritable).toBe(true);
    expect(ix.keys[ACCOUNT_TAILS_V22[78].bondTranche].pubkey.equals(tranche)).toBe(true);
    expect(applyMarketTailsV22(ix, { bondTranche: tranche, insuranceUnits: null })).toBe(ix); // nothing to add, nothing to complain about
  });
  it("ext only (no bond): 9 accounts", () => {
    const ix = buildLpCrankIx(prog, k(), market, 0, true, { lpPortfolio: lp, vaultLpExt: ext, bond: false });
    expect(ix.keys).toHaveLength(ACCOUNT_TAILS_V22[78].bondTranche);
  });
  it("flag OFF: byte-identical to the current 7-account bound crank, whatever v22 info is passed", () => {
    __setDevnetV22ForTest(false);
    const plain = buildLpCrankIx(prog, k(), market, 0, true);
    const withV22 = buildLpCrankIx(prog, plain.keys[0].pubkey, market, 0, true, { lpPortfolio: lp, vaultLpExt: ext, bond: true });
    expect(withV22.keys).toHaveLength(7);
    expect(withV22.keys.map((x) => [x.isSigner, x.isWritable])).toEqual(plain.keys.map((x) => [x.isSigner, x.isWritable]));
    expect([...withV22.data]).toEqual([...plain.data]);
  });
  it("NEGATIVE CONTROL: the old 7-account bound crank on a bond market is a mismatch (the bug this fixes)", () => {
    const old = buildLpCrankIx(prog, k(), market, 0, true);
    expect(() => applyMarketTailsV22(old, { bondTranche: tranche, insuranceUnits: null })).toThrow(MarketTailMismatchError);
  });
});

describe("tag 97: junior withdraw", () => {
  const m: VaultLpMarket = { programId: prog, market, registry: k(), vaultLpState: k(), lpPortfolio: lp, ledger: k(), siblingLedger: k(), ext };
  it("bond market via the SDK builder: ext at [11], tranche at [12]; the SDK builder equals the app builder on the ext market (keys + data)", () => {
    const [jo, dest, vault, auth] = [k(), k(), k(), k()];
    const app = buildWithdrawJuniorTrancheIx(m, jo, dest, vault, auth, 5n);
    const sdkNoBond = buildWithdrawJuniorTrancheIxV22({ programId: prog, market, registryDomain: 0, lpPortfolio: lp, vaultLpExt: ext }, jo, dest, vault, 5n);
    expect(sdkNoBond.keys).toHaveLength(app.keys.length);
    expect([...sdkNoBond.data]).toEqual([...app.data]);
    expect(sdkNoBond.keys[ACCOUNT_TAILS_V22[97].ext].pubkey.equals(ext)).toBe(true);
    const bond = buildWithdrawJuniorTrancheIxV22({ programId: prog, market, registryDomain: 0, lpPortfolio: lp, vaultLpExt: ext }, jo, dest, vault, 5n, { bond: true });
    expect(bond.keys).toHaveLength(ACCOUNT_TAILS_V22[97].bondTranche + 1);
    expect(bond.keys[ACCOUNT_TAILS_V22[97].bondTranche].pubkey.equals(tranche)).toBe(true);
    expect(applyMarketTailsV22(bond, { bondTranche: tranche, insuranceUnits: null })).toBe(bond);
  });
  it("NEGATIVE CONTROL: the app's 97 on a bond market gets the tranche appended by the choke point (12 -> 13), not silently skipped", () => {
    const app = buildWithdrawJuniorTrancheIx(m, k(), k(), k(), k(), 5n);
    expect(applyMarketTailsV22(app, { bondTranche: tranche, insuranceUnits: null }).keys).toHaveLength(13);
  });
});

describe("mismatch is loud in every environment, before the wallet prompt", () => {
  const bad = () => buildLpCrankIx(prog, k(), market, 0, true);
  const trancheAcct = () => {
    const d = new Uint8Array(200);
    new DataView(d.buffer).setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
    new DataView(d.buffer).setUint16(8, LAYOUT_V22.version, true);
    d[10] = ACCOUNT_KIND.BondTranche;
    return { owner: prog, data: d, lamports: 1, executable: false };
  };
  it.each(["development", "test", "production"])("NODE_ENV=%s: withMarketTailsV22 throws the calm error and logs it", async (env) => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = env;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      __setTailsClockForTest(null);
      const conn = { getMultipleAccountsInfo: async () => [trancheAcct(), null, null] };
      const err = await withMarketTailsV22(conn as never, prog, [bad()]).catch((e) => e);
      expect(err).toBeInstanceOf(MarketTailMismatchError);
      expect(err.message).toBe(MARKET_TAIL_CALM_LINE);
      expect(err.detail).toMatch(/tag 78 has 7 accounts/);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
  it("the user sees one calm line through both existing error paths", () => {
    const e = new MarketTailMismatchError(78, 7, "9");
    expect(resolveUserMessage(e, { surface: "any" }).body).toBe("This action isn't available for this market yet. Nothing was sent.");
    expect(humanizeError(e.message)).toBe(MARKET_TAIL_CALM_LINE);
  });
  it("no tail on chain: nothing to mismatch, the instruction passes through", async () => {
    const b = bad();
    const conn = { getMultipleAccountsInfo: async () => [null, null, null] };
    __setTailsClockForTest(null);
    await expect(withMarketTailsV22(conn as never, prog, [b])).resolves.toEqual([b]);
  });
});
