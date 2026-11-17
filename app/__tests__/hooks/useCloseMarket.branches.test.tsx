/**
 * useCloseMarket: closeSlab (creator "recover SOL") branches and the settleMarket send/error tail.
 * Everything below the hook (SDK parsing, plan, pre-resolve gate, tx layer) is mocked; the hook's own decisions are under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { k, WALLET, OTHER, SLAB, OWNER, MINT, VAULT } = await vi.hoisted(async () => {
  const { PublicKey: PK } = await import("@solana/web3.js");
  const kk = (n: number) => new PK(new Uint8Array(32).fill(n));
  return { k: kk, WALLET: kk(1), OTHER: kk(2), SLAB: kk(3), OWNER: kk(4), MINT: kk(5), VAULT: kk(6) };
});

const h = vi.hoisted(() => ({
  info: null as { data: Uint8Array; owner: unknown; lamports: number } | null,
  wrapper: true,
  admin: null as unknown,
  parseThrows: false,
  floor: false as boolean | undefined,
  plan: { ok: true, authorityEpoch: 7n, resolve: null } as Record<string, unknown>,
  cleanup: { ok: true, groups: [] } as Record<string, unknown>,
  gate: { blockers: [], warnings: [], cranks: [] } as Record<string, unknown>,
  sim: { err: null, logs: [], simulated: [] } as Record<string, unknown>,
  closeInOne: vi.fn(),
  sendTx: vi.fn(),
  accounts: [] as unknown[],
  hdrMode: 0,
  wallet: { publicKey: null as unknown, signTransaction: vi.fn() },
  buildBatch: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => h.wallet,
  useConnectionCompat: () => ({
    connection: {
      getAccountInfo: async () => h.info,
      getSlot: async () => 1,
      getProgramAccounts: async () => h.accounts,
    },
  }),
}));
vi.mock("@percolatorct/sdk", () => ({
  parseHeader: () => {
    if (h.parseThrows) throw new Error("bad magic");
    return { admin: h.admin };
  },
  parseConfig: () => ({ vaultPubkey: VAULT, collateralMint: MINT }),
  parseWrapperConfigV17: () => {
    if (h.parseThrows) throw new Error("bad magic");
    return { marketauth: h.admin, collateralMint: MINT };
  },
  V17_HEADER_LEN: 0,
  encodeCloseSlab: () => new Uint8Array([13]),
  ACCOUNTS_CLOSE_SLAB: [],
  encodeResolveMarket: () => new Uint8Array([19]),
  ACCOUNTS_RESOLVE_MARKET: [],
  buildAccountMetas: () => [],
  buildIx: (a: { data: Uint8Array }) => ({ tag: a.data[0] }),
  deriveVaultAuthority: () => [k(7), 255],
  deriveLpVaultRegistry: () => [k(8), 255],
}));
vi.mock("@solana/spl-token", () => ({
  TOKEN_PROGRAM_ID: k(9),
  getAssociatedTokenAddress: async () => k(10),
  getAssociatedTokenAddressSync: () => VAULT,
}));
vi.mock("@/lib/v22/layout", () => ({ isWrapperAccount: () => h.wrapper }));
vi.mock("@/lib/v22/resolved-claims", async (orig) => ({
  ...(await orig<object>()),
  earnDeadShareFloorPresent: () => h.floor,
  othersWithPositions: () => 0,
}));
vi.mock("@/lib/close-market-plan", () => ({ planCloseMarket: () => h.plan }));
vi.mock("@/lib/limits/own-portfolio-cleanup", () => ({
  CLEANUP_CU: 1,
  planOwnCleanupForOneApproval: async () => h.cleanup,
}));
vi.mock("@/lib/pre-resolve", () => ({ readAndPlanPreResolve: async () => h.gate }));
vi.mock("@/lib/v18-wire", () => ({
  readAssetControlSeqs: () => ({ authorityEpoch: 3n }),
  readMarketGroupHeader: () => ({ mode: h.hdrMode, nextMarketId: 5n }),
}));
vi.mock("@/lib/v22/stale-resolve", () => ({ staleResolveStatusV22: () => null }));
vi.mock("@/lib/limits/close-slab", async (orig) => ({
  ...(await orig<object>()),
  closeInOneApproval: (...a: unknown[]) => h.closeInOne(...a),
}));
vi.mock("@/lib/tx", () => ({
  broadcastSignedTx: vi.fn(),
  buildBatchTx: (...a: unknown[]) => h.buildBatch(...a),
  getFreshBlockhash: async () => "bh",
  getPriorityFee: async () => 10,
  sendTx: (...a: unknown[]) => h.sendTx(...a),
  signAllCompat: vi.fn(),
  simulateForGate: async () => h.sim,
  SimulationRefusal: class SimulationRefusal extends Error {
    constructor(public err: unknown, public logs: unknown, public simulated: unknown) {
      super("simulation refused");
    }
  },
}));

import { useCloseMarket } from "@/hooks/useCloseMarket";
import { COPY } from "@/lib/limits/copy";
import { EARN_FLOOR_COPY } from "@/lib/v22/resolved-claims";

const closeRun = async (override?: string) => {
  const { result } = renderHook(() => useCloseMarket());
  let r: unknown;
  await act(async () => {
    r = await result.current.closeSlab(SLAB.toBase58(), override);
  });
  return { r, error: result.current.error, loading: result.current.loading };
};
const settleRun = async () => {
  const { result } = renderHook(() => useCloseMarket());
  let r: unknown;
  await act(async () => {
    r = await result.current.settleMarket(SLAB.toBase58());
  });
  return { r, error: result.current.error };
};

beforeEach(() => {
  h.info = { data: new Uint8Array(64), owner: OWNER, lamports: 1234 };
  h.wrapper = true;
  h.admin = WALLET;
  h.parseThrows = false;
  h.floor = false;
  h.plan = { ok: true, authorityEpoch: 7n, resolve: null };
  h.cleanup = { ok: true, groups: [] };
  h.gate = { blockers: [], warnings: [], cranks: [] };
  h.sim = { err: null, logs: [], simulated: [] };
  h.hdrMode = 0;
  h.accounts = [];
  h.wallet = { publicKey: WALLET, signTransaction: vi.fn() };
  h.closeInOne.mockReset().mockResolvedValue({ signature: "sigX" });
  h.sendTx.mockReset().mockResolvedValue("sendSig");
  h.buildBatch.mockReset().mockImplementation((a: unknown) => a);
  localStorage.setItem("percolator-pending-slab-keypair", "x");
});

describe("closeSlab guards (nothing is signed)", () => {
  it("no wallet", async () => {
    h.wallet = { publicKey: null, signTransaction: vi.fn() };
    const r = await closeRun();
    expect(r.r).toBeNull();
    expect(r.error).toBe("Wallet not connected");
  });
  it("missing account clears the pending keypair", async () => {
    h.info = null;
    const r = await closeRun();
    expect(r.r).toBeNull();
    expect(r.error).toMatch(/no longer exists/);
    expect(localStorage.getItem("percolator-pending-slab-keypair")).toBeNull();
  });
  it("uninitialised slab (parse throws) points at ReclaimSlabRent", async () => {
    h.parseThrows = true;
    expect((await closeRun()).error).toMatch(/not yet initialised/);
  });
  it("non-admin wallet is refused, v17 and v12", async () => {
    h.admin = OTHER;
    expect((await closeRun()).error).toMatch(/Only the market admin/);
    h.wrapper = false;
    expect((await closeRun()).error).toMatch(/Only the market admin/);
    expect(h.closeInOne).not.toHaveBeenCalled();
  });
  it("Earn dead-share floor refuses with the settle copy", async () => {
    h.floor = true;
    expect((await closeRun()).error).toBe(EARN_FLOOR_COPY.line);
  });
  it("plan not ok: market holds capital", async () => {
    h.plan = { ok: false };
    expect((await closeRun()).error).toMatch(/already holds user capital/);
  });
  it("own cleanup refusal uses the COPY.reclaimCleanup line (with and without remaining)", async () => {
    const reasons = Object.keys(COPY.reclaimCleanup) as (keyof typeof COPY.reclaimCleanup)[];
    const reason = reasons[0]!;
    h.cleanup = { ok: false, reason, remaining: 2 };
    expect((await closeRun()).error).toBe(COPY.reclaimCleanup[reason]("2"));
    h.cleanup = { ok: false, reason };
    expect((await closeRun()).error).toBe(COPY.reclaimCleanup[reason](""));
  });
  it("pre-resolve blockers refuse", async () => {
    h.plan = { ok: true, authorityEpoch: 1n, resolve: { assetGenerationFrontier: 1n } };
    h.gate = { blockers: ["fees unclaimed."], warnings: [], cranks: [] };
    expect((await closeRun()).error).toBe("Cannot reclaim yet: fees unclaimed.");
  });
});

describe("closeSlab success paths", () => {
  it("v17 live market: resolve + close in one approval, clears keypair, returns lamports", async () => {
    h.plan = { ok: true, authorityEpoch: 1n, resolve: { assetGenerationFrontier: 1n } };
    h.gate = { blockers: [], warnings: ["w"], cranks: [{ tag: 78 }] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await closeRun();
    expect(r).toEqual({ r: { signature: "sigX", reclaimedLamports: 1234 }, error: null, loading: false });
    expect(warn).toHaveBeenCalled();
    expect(localStorage.getItem("percolator-pending-slab-keypair")).toBeNull();
    const arg = h.closeInOne.mock.calls[0]![0] as { main: { instructions: unknown[] }; cleanup: unknown[] };
    expect(arg.main.instructions).toHaveLength(3); // crank, resolve, close
    expect(arg.cleanup).toHaveLength(0);
    warn.mockRestore();
  });
  it("v17 with cleanup groups skips the simulate gate even when it would refuse", async () => {
    h.cleanup = { ok: true, groups: [[{ tag: 30 }], [{ tag: 46 }]] };
    h.sim = { err: "boom", logs: [], simulated: [] };
    const r = await closeRun(OWNER.toBase58());
    expect((r.r as { signature: string }).signature).toBe("sigX");
    const arg = h.closeInOne.mock.calls[0]![0] as { cleanup: unknown[] };
    expect(arg.cleanup).toHaveLength(2);
  });
  it("v12 slab path uses parseConfig and header admin", async () => {
    h.wrapper = false;
    const r = await closeRun();
    expect((r.r as { reclaimedLamports: number }).reclaimedLamports).toBe(1234);
  });
  it("simulation refusal is surfaced as an error, nothing signed", async () => {
    h.sim = { err: "bad", logs: [], simulated: [] };
    const r = await closeRun();
    expect(r.r).toBeNull();
    expect(r.error).toBeTruthy();
    expect(h.closeInOne).not.toHaveBeenCalled();
  });
});

describe("closeSlab error mapping", () => {
  const fail = async (msg: string) => {
    h.closeInOne.mockRejectedValue(new Error(msg));
    return closeRun();
  };
  it("re-book message passes through", async () => {
    expect((await fail(COPY.closeRebooked)).error).toBe(COPY.closeRebooked);
  });
  it("0xd / EngineInsufficientBalance: vault still has tokens", async () => {
    expect((await fail("custom program error: 0xd")).error).toMatch(/vault or insurance fund still has tokens/);
    expect((await fail("EngineInsufficientBalance")).error).toMatch(/still has tokens/);
  });
  it("0x10 / AccountNotFound: open accounts", async () => {
    expect((await fail("custom program error: 0x10")).error).toMatch(/open user accounts/);
    expect((await fail("AccountNotFound")).error).toMatch(/open user accounts/);
  });
  it("wallet rejection", async () => {
    expect((await fail("User rejected the request")).error).toBe("Transaction cancelled.");
    expect((await fail("WalletSignTransactionError")).error).toBe("Transaction cancelled.");
  });
  it("EngineLockActive (0x15)", async () => {
    expect((await fail("custom program error: 0x15")).error).toMatch(/can never be closed/);
    expect((await fail("EngineLockActive")).error).toMatch(/can never be closed/);
  });
  it("anything else falls back to a plain message", async () => {
    const r = await fail("kaboom unknown");
    expect(r.r).toBeNull();
    expect(typeof r.error).toBe("string");
    expect(r.error).not.toBe("");
    expect(r.loading).toBe(false);
  });
});

describe("settleMarket remaining branches", () => {
  it("no wallet", async () => {
    h.wallet = { publicKey: null, signTransaction: vi.fn() };
    expect((await settleRun()).error).toBe("Wallet not connected");
  });
  it("missing market", async () => {
    h.info = null;
    expect((await settleRun()).error).toBe("This market no longer exists.");
  });
  it("non-v2.2 account", async () => {
    h.wrapper = false;
    expect((await settleRun()).error).toMatch(/not a v2.2 market/);
  });
  it("happy path: gate cranks + resolve go through sendTx once", async () => {
    h.gate = { blockers: [], warnings: [], cranks: [{ tag: 78 }] };
    const r = await settleRun();
    expect(r).toEqual({ r: { signature: "sendSig" }, error: null });
    const arg = h.sendTx.mock.calls[0]![0] as { instructions: unknown[]; computeUnits: number };
    expect(arg.instructions).toEqual([{ tag: 78 }, { tag: 19 }]);
    expect(arg.computeUnits).toBe(1_400_000);
  });
  it("simulation refusal => error, no send", async () => {
    h.sim = { err: "bad", logs: [], simulated: [] };
    const r = await settleRun();
    expect(r.r).toBeNull();
    expect(r.error).toBeTruthy();
    expect(h.sendTx).not.toHaveBeenCalled();
  });
  it("wallet rejection => cancelled; other failure => plain message", async () => {
    h.sendTx.mockRejectedValue(new Error("User rejected the request"));
    expect((await settleRun()).error).toBe("Transaction cancelled.");
    h.sendTx.mockRejectedValue(new Error("weird failure"));
    const r = await settleRun();
    expect(r.r).toBeNull();
    expect(r.error).toBeTruthy();
    expect(r.error).not.toBe("Transaction cancelled.");
  });
});
