/**
 * #3611 on /stake: a first-loss pool the API could not value (`tvl: null`) shows a dash for its TVL and for the
 * page's Total Staked, and a stake in it whose own units read also failed is shown as unknown (a dash), never valued
 * from a vault-only figure. With a TVL the API could read (vault + deployed) the stake is still valued from it.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE } from "@solana/spl-token";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@/lib/v22/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const WALLET = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SLAB = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const LP_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const POOL_PDA = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const LP_ATA = new PublicKey("SysvarRecentB1ockHashes11111111111111111111");

const h = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  fetch: vi.fn(),
  conn: null as unknown as { connection: Record<string, unknown> },
  wallet: null as unknown as Record<string, unknown>,
}));
h.conn = { connection: { getAccountInfo: (...a: unknown[]) => h.getAccountInfo(...a), getSlot: async () => 0, getTokenAccountBalance: async () => { throw new Error("n/a"); } } };
h.wallet = { connected: true, publicKey: WALLET, signTransaction: () => undefined };

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => h.wallet, useConnectionCompat: () => h.conn }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  deriveStakePool: () => [POOL_PDA, 255],
  deriveDepositPda: () => [PublicKey.default, 255],
  deriveStakeVaultAuth: () => [PublicKey.default, 255],
}));
vi.mock("@/lib/v22/sdk", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/sdk")>()),
  // The page's own InsuranceUnits read fails (as on a rate-limited devnet RPC).
  deriveInsuranceUnitsV22: () => { throw new Error("429 Too Many Requests"); },
}));
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: (mint: PublicKey) => (mint.equals(LP_MINT) ? LP_ATA : PublicKey.default),
  unpackAccount: (address: PublicKey, info: { data: Buffer }) => {
    if (!info || info.data.length !== 165) throw new Error("TokenInvalidAccountSizeError");
    return { address, amount: Buffer.from(info.data).readBigUInt64LE(64) };
  },
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ vaultProgramId: STAKE_PROGRAM.toBase58() }) }));
vi.mock("@/hooks/useStakeDepositByPool", () => ({ useStakeDepositByPool: () => ({ deposit: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(), loading: false, error: null }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/wallet/ConnectWalletCta", () => ({ ConnectWalletCta: ({ label }: { label: string }) => <button>{label}</button> }));

import StakePage from "@/app/stake/page";

function apiPool(tvl: number | null) {
  return {
    poolAddress: "pool-AAA", slabAddress: SLAB.toBase58(), collateralMint: MINT.toBase58(), lpMint: LP_MINT.toBase58(), vault: LP_MINT.toBase58(),
    name: "AAA", symbol: "AAA", logoUrl: null, tvl, tvlRaw: "500000000", poolValue: tvl, apr: null,
    capTotal: 0, capTotalRaw: "0", capUsed: 500, capUsedRaw: "500000000", cooldownSlots: 0, totalLpSupply: 1_000_000_000, vaultBalance: 500,
    poolMode: 0, adminTransferred: false, stakeKind: "first-loss", deployedValue: tvl === null ? null : 400, liquidValue: tvl === null ? null : 500, unclaimedValue: 0,
  };
}
function v5PoolData(): Buffer {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5; d[F.riskMode] = 1; d[F.consentVersion] = 2;
  v.setUint16(F.deployTargetBps, 5000, true); v.setUint16(F.liquidBufferBps, 3000, true); v.setUint16(F.hysteresisBps, 500, true);
  v.setBigUint64(176, 1_000_000_000n, true); // total LP supply
  for (const off of [F.slab, 40, 72, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  d.set(LP_MINT.toBytes(), 104);
  return Buffer.from(d);
}
function lpTokenAccountData(amount: bigint): Buffer {
  const d = Buffer.alloc(ACCOUNT_SIZE);
  LP_MINT.toBuffer().copy(d, 0);
  WALLET.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  h.getAccountInfo.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
    if (pk.equals(POOL_PDA)) return { data: v5PoolData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
    // The wallet holds half the pool's LP; the pool vault holds $500 (the vault-only figure).
    if (pk.equals(LP_ATA)) return { data: lpTokenAccountData(500_000_000n), owner: STAKE_PROGRAM, lamports: 1, executable: false };
    return null;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setDevnetV22ForTest(null);
});

const stat = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
const row = () => screen.getByTitle("Open AAA chart").closest("div[class*='cursor-pointer']") as HTMLElement;

describe("#3611 /stake with a first-loss pool the API could not value", () => {
  it("TVL, Total Staked, the stake and Your Deposits are dashes, never a vault-only dollar figure", async () => {
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ pools: [apiPool(null)] }) });
    render(<StakePage />);
    await waitFor(() => expect(screen.getByTitle("Open AAA chart")).toBeTruthy());
    await waitFor(() => expect(stat("Total Staked")).toBe("—"));
    const cells = within(row()).getAllByText((_, el) => el?.tagName === "SPAN" && /^(—|\$)/.test(el.textContent ?? "") && el.children.length === 0);
    expect(cells.map((c) => c.textContent)).toContain("—"); // the TVL cell
    expect(cells.map((c) => c.textContent)).not.toContain("$500.00");
    expect(cells.map((c) => c.textContent)).not.toContain("$250.00");
    await waitFor(() => expect(stat("Your Deposits")).toBe("—"));
    expect(document.body.textContent).not.toContain("$250.00");
    expect(document.body.textContent).not.toContain("$500.00 ");
  });

  it("with a TVL the API could read (vault + deployed = $900), the stake is half of it", async () => {
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ pools: [apiPool(900)] }) });
    render(<StakePage />);
    await waitFor(() => expect(stat("Total Staked")).toBe("$900.00"));
    await waitFor(() => expect(stat("Your Deposits")).toBe("$450.00"));
  });
});
