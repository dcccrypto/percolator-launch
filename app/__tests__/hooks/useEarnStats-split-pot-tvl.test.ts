// @vitest-environment node
/**
 * The Earn table valued every vault at shares + distributed fees. On a two-pot vault that is not
 * what it is worth: the vault page (useInsuranceLP) and instruction 77 use the program's combined
 * NAV over both pots. Live 2026-10-01, OTC read $2,000.35 in the table and $487.74 on its page.
 */
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ parseThrows: false }));
const mocks = vi.hoisted(() => ({
  chunked: vi.fn(),
  ledgerKeys: vi.fn(),
  fromAccounts: vi.fn(),
  upgrade: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ programId: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB" }),
  getRpcEndpoint: () => "http://localhost:8899",
}));
vi.mock("@/lib/program-upgrade-detect", () => ({
  programUpgradeState: mocks.upgrade,
  // The real helper: "post" -> true, anything else ("unknown" included) -> false.
  earnNavFloorLive: async () => (await mocks.upgrade()) === "post",
}));
vi.mock("@/lib/rpc-chunk", () => ({ getMultipleAccountsInfoChunked: mocks.chunked }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  parseLpVaultRegistry: () => {
    if (sdk.parseThrows) throw new Error("layout");
    return { totalLpSharesOutstanding: 2_000_000_000n, feeDistributionTotalAtoms: 350_000n, redemptionCooldownSlots: 150n };
  },
}));
vi.mock("@/lib/limits/earn-split-pot", () => ({
  splitPotLedgerKeys: mocks.ledgerKeys,
  splitPotStateFromAccounts: mocks.fromAccounts,
  vaultValue: (sp: { own: { nav: bigint }; sib: { nav: bigint }; unpriceable?: boolean }) =>
    sp.unpriceable ? null : { nav: sp.own.nav + sp.sib.nav, available: 0n },
}));

import { fetchCuratedVaultsOnChain } from "@/hooks/useEarnStats";

const SLAB = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const acct = { data: new Uint8Array(8), owner: PublicKey.default, lamports: 1, executable: false, rentEpoch: 0 };
const ledgers = { ownLedger: new PublicKey("SysvarC1ock11111111111111111111111111111111"), sibLedger: new PublicKey("SysvarRent111111111111111111111111111111111") };
const SHARES_PLUS_FEES = 2_000_350_000n;

describe("fetchCuratedVaultsOnChain: two-pot vaults are valued at NAV", () => {
  beforeEach(() => {
    mocks.chunked.mockReset();
    mocks.ledgerKeys.mockReset();
    mocks.fromAccounts.mockReset();
    mocks.upgrade.mockReset().mockResolvedValue("post");
    sdk.parseThrows = false;
    mocks.chunked.mockResolvedValueOnce([acct]).mockResolvedValueOnce([acct, acct, acct]);
  });

  it("uses the combined NAV, from one batched read of market + both ledgers", async () => {
    mocks.ledgerKeys.mockReturnValue(ledgers);
    mocks.fromAccounts.mockReturnValue({ own: { nav: 400_000_000n }, sib: { nav: 87_740_000n }, feeShareBps: 0, totalShares: 2_000_000_000n });
    const { data, ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(data[SLAB]).toEqual({ tvlAtoms: 487_740_000n, cooldownSlots: 150n, found: true });
    expect(mocks.chunked).toHaveBeenCalledTimes(2);
    expect(mocks.chunked.mock.calls[1][1].map((k: PublicKey) => k.toBase58())).toEqual([SLAB, ledgers.ownLedger.toBase58(), ledgers.sibLedger.toBase58()]);
  });

  it("keeps shares + fees for a bound vault, with no extra read", async () => {
    mocks.ledgerKeys.mockReturnValue(null);
    const { data } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(data[SLAB].tvlAtoms).toBe(SHARES_PLUS_FEES);
    expect(mocks.chunked).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["two-pot state can't be read", () => mocks.fromAccounts.mockReturnValue(null)],
    ["state reads but can't be priced (both pots under water, pre-floor)", () =>
      mocks.fromAccounts.mockReturnValue({ own: { nav: 1n }, sib: { nav: 1n }, feeShareBps: 0, totalShares: 2_000_000_000n, unpriceable: true })],
  ])("a vault whose %s is marked unvalued at 0, never shares + fees; the cycle still succeeds", async (_n, setup) => {
    mocks.ledgerKeys.mockReturnValue(ledgers);
    setup();
    const { data, ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(data[SLAB]).toMatchObject({ tvlAtoms: 0n, unvalued: true, found: true });
    expect(data[SLAB].tvlAtoms).not.toBe(SHARES_PLUS_FEES);
  });

  it("a registry account that doesn't decode is a vault of unknown value (unvalued), not 'no vault' at $0", async () => {
    sdk.parseThrows = true;
    mocks.ledgerKeys.mockReturnValue(ledgers);
    const { data, ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(data[SLAB]).toMatchObject({ tvlAtoms: 0n, found: true, unvalued: true });
    expect(mocks.chunked).toHaveBeenCalledTimes(1); // not sent on to the two-pot read
  });

  it("no shares outstanding: the vault adds 0, not its lifetime fees (and isn't flagged unvalued)", async () => {
    mocks.ledgerKeys.mockReturnValue(ledgers);
    mocks.fromAccounts.mockReturnValue({ own: { nav: 350_000n }, sib: { nav: 0n }, feeShareBps: 0, totalShares: 0n });
    const { data, ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(data[SLAB].tvlAtoms).toBe(0n);
    expect(data[SLAB].unvalued).toBeUndefined();
  });

  it("a failed two-pot read fails the cycle (keep-last-good), not a silent shares + fees", async () => {
    mocks.chunked.mockReset();
    mocks.chunked.mockResolvedValueOnce([acct]).mockRejectedValueOnce(new Error("429"));
    mocks.ledgerKeys.mockReturnValue(ledgers);
    const { ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(false);
  });

  it("the wrapper version can't be read and the floor changes this vault's value: fails the cycle", async () => {
    mocks.ledgerKeys.mockReturnValue(ledgers);
    // An over-impaired pot: unpriceable without the floor (-> shares + fees), worth 4.5 with it.
    mocks.fromAccounts.mockImplementation((...a: unknown[]) =>
      a[6] ? { own: { nav: 4_500_000n }, sib: { nav: 0n }, feeShareBps: 0, totalShares: 2_000_000_000n } : null,
    );
    mocks.upgrade.mockResolvedValue("unknown");
    const { ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(false);
  });

  it("the wrapper version can't be read but the floor doesn't matter for this vault: priced as usual", async () => {
    mocks.ledgerKeys.mockReturnValue(ledgers);
    mocks.fromAccounts.mockReturnValue({ own: { nav: 400_000_000n }, sib: { nav: 87_740_000n }, feeShareBps: 0, totalShares: 2_000_000_000n });
    mocks.upgrade.mockResolvedValue("unknown");
    const { data, ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(data[SLAB].tvlAtoms).toBe(487_740_000n);
  });

  it("passes the NAV floor on (post-upgrade wrapper) and off (pre-upgrade)", async () => {
    mocks.ledgerKeys.mockReturnValue(ledgers);
    mocks.fromAccounts.mockReturnValue(null);
    await fetchCuratedVaultsOnChain([SLAB]);
    expect(mocks.fromAccounts.mock.calls[0][6]).toBe(true);
    mocks.chunked.mockResolvedValueOnce([acct]).mockResolvedValueOnce([acct, acct, acct]);
    mocks.upgrade.mockResolvedValue("pre");
    const { ok } = await fetchCuratedVaultsOnChain([SLAB]);
    expect(ok).toBe(true);
    expect(mocks.fromAccounts.mock.calls[1][6]).toBe(false);
  });
});
