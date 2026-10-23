/**
 * #3607: /stake branched on the first-loss hook's `pool` only. While that read was in flight, or after it failed
 * once (a devnet 429), a pool the API labels `stakeKind: "first-loss"` got the PLAIN deposit form, whose 9-byte
 * deposit a first-loss pool refuses with 33 ConsentRequired. The page now also branches on the API's kind: such a
 * pool shows a reading line, then a "couldn't read" line with Retry, never the plain form.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@/lib/v22/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SLAB = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const LP_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const POOL_PDA = new PublicKey("SysvarC1ock11111111111111111111111111111111");

const h = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  fetch: vi.fn(),
  plainDeposit: vi.fn(),
  conn: null as unknown as { connection: Record<string, unknown> },
  wallet: null as unknown as { connected: boolean; publicKey: PublicKey; signTransaction: () => void },
}));
h.wallet = { connected: true, publicKey: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), signTransaction: () => undefined };
h.conn = {
  connection: {
    getAccountInfo: (...a: unknown[]) => h.getAccountInfo(...a),
    getSlot: async () => 0,
    getTokenAccountBalance: async () => { throw new Error("n/a"); },
  },
};

vi.mock("@/hooks/useWalletCompat", () => ({
  // Stable objects: the page's effects depend on their identity, as with the real hooks (a fresh key per render loops).
  useWalletCompat: () => h.wallet,
  useConnectionCompat: () => h.conn,
}));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  deriveStakePool: () => [POOL_PDA, 255],
  deriveDepositPda: () => [PublicKey.default, 255],
  deriveStakeVaultAuth: () => [PublicKey.default, 255],
}));
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: () => PublicKey.default,
  unpackAccount: () => { throw new Error("TokenInvalidAccountSizeError"); },
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ vaultProgramId: STAKE_PROGRAM.toBase58() }) }));
vi.mock("@/hooks/useStakeDepositByPool", () => ({ useStakeDepositByPool: () => ({ deposit: h.plainDeposit, loading: false, error: null }) }));
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(), loading: false, error: null }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/wallet/ConnectWalletCta", () => ({ ConnectWalletCta: ({ label }: { label: string }) => <button>{label}</button> }));

import StakePage from "@/app/stake/page";
import * as hookModule from "@/hooks/useStakeFirstLoss";

function apiPool(stakeKind?: "first-loss" | "fee-only") {
  return {
    poolAddress: "pool-AAA", slabAddress: SLAB.toBase58(), collateralMint: MINT.toBase58(), lpMint: LP_MINT.toBase58(), vault: LP_MINT.toBase58(),
    name: "AAA", symbol: "AAA", logoUrl: null, tvl: 1000, tvlRaw: "1000000000", poolValue: 1000, apr: null,
    capTotal: 0, capTotalRaw: "0", capUsed: 0, capUsedRaw: "0", cooldownSlots: 0, totalLpSupply: 1_000_000_000, vaultBalance: 1000,
    poolMode: 0, adminTransferred: false,
    ...(stakeKind ? { stakeKind, deployedValue: 0, unclaimedValue: 0 } : {}),
  };
}
const okResponse = (pools: unknown[]) => ({ ok: true, status: 200, json: async () => ({ pools }) });

function v5PoolData(): Buffer {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5; d[F.riskMode] = 1; d[F.consentVersion] = 2;
  v.setUint16(F.deployTargetBps, 5000, true); v.setUint16(F.liquidBufferBps, 3000, true); v.setUint16(F.hysteresisBps, 500, true);
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  return Buffer.from(d);
}
const RATE_LIMITED = new Error("429 Too Many Requests");
const ALL_RETRIES_MS = ((hookModule as { FIRST_LOSS_READ_RETRY_MS?: readonly number[] }).FIRST_LOSS_READ_RETRY_MS ?? [1_000, 2_000]).reduce((a, b) => a + b, 0);

beforeEach(() => {
  h.getAccountInfo.mockReset();
  h.fetch.mockReset();
  h.plainDeposit.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setDevnetV22ForTest(null);
});

describe("#3607 a pool the API marks first-loss never gets the plain 9-byte deposit form", () => {
  it("while the pool read is in flight: a reading line, no plain form", async () => {
    __setDevnetV22ForTest(true);
    h.fetch.mockResolvedValue(okResponse([apiPool("first-loss")]));
    h.getAccountInfo.mockImplementation(() => new Promise(() => {}));
    render(<StakePage />);
    expect(await screen.findByTestId("first-loss-reading")).toBeTruthy();
    expect(screen.queryByTestId("stake-deposit-submit")).toBeNull();
    expect(screen.queryByTestId("first-loss-deposit")).toBeNull();
  });

  it("after the read fails: a couldn't-read line with Retry, still no plain form; Retry brings the consent form", async () => {
    __setDevnetV22ForTest(true);
    h.fetch.mockResolvedValue(okResponse([apiPool("first-loss")]));
    let readOk = false;
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
      if (pk.equals(POOL_PDA)) {
        if (!readOk) throw RATE_LIMITED;
        return { data: v5PoolData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
      }
      return null;
    });
    render(<StakePage />);
    const failed = await screen.findByTestId("first-loss-read-failed", undefined, { timeout: ALL_RETRIES_MS + 4000 });
    expect(failed.textContent).not.toMatch(/429|Too Many|http/i);
    expect(screen.queryByTestId("stake-deposit-submit")).toBeNull();
    expect(screen.queryByTestId("stake-deposit-input")).toBeNull();

    readOk = true;
    await act(async () => { fireEvent.click(screen.getByTestId("first-loss-retry")); });
    await waitFor(() => expect(screen.getByTestId("consent-check")).toBeTruthy());
    expect(screen.queryByTestId("stake-deposit-submit")).toBeNull();
    expect(h.plainDeposit).not.toHaveBeenCalled();
  }, 15_000);

  it("the read answers 'not a first-loss pool' for an API first-loss pool: still no plain form", async () => {
    __setDevnetV22ForTest(true);
    h.fetch.mockResolvedValue(okResponse([apiPool("first-loss")]));
    h.getAccountInfo.mockResolvedValue(null);
    render(<StakePage />);
    expect(await screen.findByTestId("first-loss-read-failed")).toBeTruthy();
    expect(screen.queryByTestId("stake-deposit-submit")).toBeNull();
  });

  it("flag on, a fee-only pool: the plain form, as before", async () => {
    __setDevnetV22ForTest(true);
    h.fetch.mockResolvedValue(okResponse([apiPool("fee-only")]));
    h.getAccountInfo.mockResolvedValue(null);
    render(<StakePage />);
    expect(await screen.findByTestId("stake-deposit-submit")).toBeTruthy();
    expect(screen.queryByTestId("first-loss-reading")).toBeNull();
    expect(screen.queryByTestId("first-loss-read-failed")).toBeNull();
  });

  it("NEGATIVE CONTROL flag off: the plain form, no first-loss read state at all", async () => {
    __setDevnetV22ForTest(false);
    h.fetch.mockResolvedValue(okResponse([apiPool()]));
    h.getAccountInfo.mockResolvedValue(null);
    render(<StakePage />);
    expect(await screen.findByTestId("stake-deposit-submit")).toBeTruthy();
    expect(screen.queryByTestId("first-loss-reading")).toBeNull();
    expect(screen.queryByTestId("first-loss-read-failed")).toBeNull();
  });
});
