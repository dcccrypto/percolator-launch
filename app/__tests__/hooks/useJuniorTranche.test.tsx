// @vitest-environment jsdom
/**
 * useJuniorTranche: the creator's junior (first-loss) tranche top-up (tag 96), withdraw (tag 97) and resolved release
 * (tag 102). Chain reads and ix builders are mocked at the module edge; what runs is the hook's own wiring.
 *
 * Expected values come from the program / SDK rules, not from the hook:
 *  - 96 / 97 compute-unit limits: SDK `NAV_FLOW_COMPUTE_UNITS_V22[96|97].units` (prog #640 measured table).
 *  - Account derivations: SDK `deriveLpBackingLedger(prog, market, domain)` (sibling = domain ^ 1) and
 *    `deriveVaultAuthority(prog, market)`; the owner/vault token accounts are the SPL canonical ATAs.
 *  - Junior-owner gate: program tag 96/97 signer check (`juniorOwner` of VaultLpState) -> only that wallet may move it.
 *  - Deposit guard: `assertDepositWithinBalance` (amount > KNOWN balance refuses; unknown balance does not block).
 *  - Refusal 75 = WRAPPER_ERR.VaultLpJuniorWithdrawRefused (wrapper error table).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveLpBackingLedger, deriveVaultAuthority } from "@percolatorct/sdk";
import { NAV_FLOW_COMPUTE_UNITS_V22 } from "@/lib/v22/sdk";

/**
 * PublicKey.findProgramAddressSync is unreliable under jsdom (same note as useCreatorClaim.test), so PDAs/ATAs are stubbed with a
 * deterministic fake keyed on (tag, inputs). What is asserted is the hook's WIRING (which inputs, domain vs domain ^ 1).
 * The real seeds are covered by __tests__/lib/v22/nav-flow-senders.test.ts.
 */
function fakePda(tag: string, ...ks: { toBytes(): Uint8Array }[]): PublicKey {
  const b = new Uint8Array(32);
  Array.from(tag).forEach((c, i) => (b[i % 32] = (b[i % 32] * 31 + c.charCodeAt(0) + 1) & 255));
  ks.forEach((key, j) => key.toBytes().forEach((v, i) => (b[i] = (b[i] * 7 + v + j + 1) & 255)));
  return new PublicKey(b);
}
const k = () => Keypair.generate().publicKey;
const PROG = k();
const MARKET = k();
const OWNER = k();
const MINT = k();
const LP = k();
const noopIx = (tag: number) => new TransactionInstruction({ programId: PROG, keys: [], data: Buffer.from([tag]) });

const h = vi.hoisted(() => ({
  v21: false,
  v22: false,
  slab: {} as Record<string, unknown>,
  wallet: {} as Record<string, unknown>,
  conn: { getMultipleAccountsInfo: undefined as unknown as ReturnType<typeof vi.fn> },
  sendTx: vi.fn(),
  balance: vi.fn(),
  tails: vi.fn(),
  v22Withdraw: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  decodeState: vi.fn(),
  decodeDomain: vi.fn(),
  releaseIxs: vi.fn(),
  needsHarvest: vi.fn(),
  idle: vi.fn(),
  emptyCloses: vi.fn(),
  simulate: vi.fn(),
  packets: [] as unknown[],
  topupOrig: null as unknown as typeof import("@/lib/limits/resolved-topup"),
}));

vi.mock("@/lib/v21/flag", () => ({ isDevnetV21Enabled: () => h.v21 }));
vi.mock("@/lib/v22/flag", () => ({ isDevnetV22Enabled: () => h.v22 }));
vi.mock("@/lib/v21/sdk", () => ({ deriveVaultLpExt: (p: PublicKey, m: PublicKey) => fakePda("ext", p, m) }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  deriveLpBackingLedger: (p: PublicKey, m: PublicKey, d: number) => [fakePda(`ledger${d}`, p, m), 255],
  deriveVaultAuthority: (p: PublicKey, m: PublicKey) => [fakePda("auth", p, m), 255],
}));
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: (mint: PublicKey, owner: PublicKey, off?: boolean) => fakePda(`ata${off ? "off" : "on"}`, mint, owner),
}));
vi.mock("@/lib/v22/market-tails", () => ({ fetchMarketTailsV22: (...a: unknown[]) => h.tails(...a) }));
vi.mock("@/lib/v22/sdk", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/sdk")>()), buildWithdrawJuniorTrancheIxV22: (...a: unknown[]) => h.v22Withdraw(...a) }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: h.conn }), useWalletCompat: () => h.wallet }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => h.slab }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), sendTx: (...a: unknown[]) => h.sendTx(...a) }));
vi.mock("@/lib/deposit-guard", async (orig) => ({ ...(await orig<typeof import("@/lib/deposit-guard")>()), readTokenBalance: (...a: unknown[]) => h.balance(...a) }));
vi.mock("@/lib/limits/decode", () => ({ decodeVaultLpState: (...a: unknown[]) => h.decodeState(...a), decodeLpVaultRegistryDomain: (...a: unknown[]) => h.decodeDomain(...a) }));
vi.mock("@/lib/limits/p3-ix", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/p3-ix")>()),
  deriveLpVaultRegistryPda: (p: PublicKey, m: PublicKey) => fakePda("registry", p, m),
  deriveVaultLpState: (p: PublicKey, m: PublicKey) => fakePda("vls", p, m),
  buildDepositJuniorTrancheIx: (...a: unknown[]) => h.deposit(...a),
  buildWithdrawJuniorTrancheIx: (...a: unknown[]) => h.withdraw(...a),
}));
vi.mock("@/lib/limits/junior-resolved-release", () => ({
  buildJuniorResolvedReleaseIxs: (...a: unknown[]) => h.releaseIxs(...a),
  juniorReleaseNeedsHarvest: (...a: unknown[]) => h.needsHarvest(...a),
  juniorResolvedDomainIdle: (...a: unknown[]) => h.idle(...a),
}));
// the packet wire-size gate (fitTopupToPacket) needs real tx serialisation (unreliable under jsdom); its own tests are resolved-empty-closes.test.ts.
vi.mock("@/lib/limits/resolved-topup", async (orig) => {
  h.topupOrig = await orig<typeof import("@/lib/limits/resolved-topup")>();
  return {
  ...h.topupOrig,
  sendWithTopup: (p: { packet?: unknown }) => {
    h.packets.push(p.packet);
    return h.topupOrig.sendWithTopup({ ...p, packet: undefined } as never);
  },
  };
});
vi.mock("@/lib/limits/resolved-exit-load", () => ({ readEmptyCloseIxs: (...a: unknown[]) => h.emptyCloses(...a) }));
vi.mock("@/lib/self-heal", async (orig) => ({
  ...(await orig<typeof import("@/lib/self-heal")>()),
  computeBudgetPrefix: (units: number) => [new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([units & 255]) })],
  connectionSelfHealDeps: () => ({ simulate: (...a: unknown[]) => h.simulate(...a) }),
}));

import { SimulationRefusal } from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { EMPTY_CLOSE_BUNDLE_CU_CAP, EMPTY_CLOSE_SIM_CU, isJuniorWithdrawRefusal, juniorFlowComputeUnits, useJuniorTranche } from "@/hooks/useJuniorTranche";

const owned = (data: Uint8Array = new Uint8Array(8)) => ({ owner: PROG, data });
const refusal75 = () => new SimulationRefusal({ InstructionError: [0, { Custom: 75 }] }, [], []);

beforeEach(() => {
  vi.clearAllMocks();
  h.v21 = false;
  h.v22 = false;
  h.slab = { programId: PROG.toBase58(), config: { collateralMint: MINT } };
  h.wallet = { publicKey: OWNER };
  h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), owned(), owned(new Uint8Array([9, 9]))]);
  h.decodeState.mockReturnValue({ juniorOwner: OWNER.toBytes(), lpPortfolio: LP.toBytes() });
  h.decodeDomain.mockReturnValue(1);
  h.sendTx.mockResolvedValue("SIG");
  h.balance.mockResolvedValue(1_000n);
  h.deposit.mockReturnValue(noopIx(96));
  h.withdraw.mockReturnValue(noopIx(97));
  h.v22Withdraw.mockReturnValue(noopIx(97));
  h.tails.mockResolvedValue({ bondTranche: null, vaultLpExt: null });
  h.releaseIxs.mockReturnValue([noopIx(102)]);
  h.needsHarvest.mockReturnValue(false);
  h.idle.mockReturnValue(null);
  h.emptyCloses.mockResolvedValue([]);
  h.simulate.mockResolvedValue({ err: null });
  h.packets.length = 0;
});

describe("juniorFlowComputeUnits / isJuniorWithdrawRefusal (pure)", () => {
  it("96 / 97 limits are the SDK table's values", () => {
    expect(juniorFlowComputeUnits("deposit")).toBe(NAV_FLOW_COMPUTE_UNITS_V22[96].units);
    expect(juniorFlowComputeUnits("withdraw")).toBe(NAV_FLOW_COMPUTE_UNITS_V22[97].units);
    expect(juniorFlowComputeUnits("withdraw")).toBeGreaterThan(juniorFlowComputeUnits("deposit"));
  });
  it("only a pre-sign simulation refusal with code 75 counts", () => {
    expect(WRAPPER_ERR.VaultLpJuniorWithdrawRefused).toBe(75);
    expect(isJuniorWithdrawRefusal(refusal75())).toBe(true);
    expect(isJuniorWithdrawRefusal(new SimulationRefusal({ InstructionError: [0, { Custom: 21 }] }, [], []))).toBe(false);
    expect(isJuniorWithdrawRefusal(new Error("custom program error: 0x4b"))).toBe(false);
    expect(isJuniorWithdrawRefusal(null)).toBe(false);
  });
  it("the bundle caps are positive and the cap exceeds one close", () => {
    expect(EMPTY_CLOSE_BUNDLE_CU_CAP).toBeGreaterThan(EMPTY_CLOSE_SIM_CU);
  });
});

describe("deposit (96)", () => {
  it("builds the ix from the derived market context and sends it; initial state idle", async () => {
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    expect(result.current).toMatchObject({ busy: false, error: null, refused75: false });
    let sig = "";
    await act(async () => {
      sig = await result.current.deposit(250n);
    });
    expect(sig).toBe("SIG");
    const [vm, owner, ownerAta, vaultToken, amount] = h.deposit.mock.calls[0];
    const [vaultAuthority] = deriveVaultAuthority(PROG, MARKET);
    expect(owner.equals(OWNER)).toBe(true);
    expect(ownerAta.equals(getAssociatedTokenAddressSync(MINT, OWNER))).toBe(true);
    expect(vaultToken.equals(getAssociatedTokenAddressSync(MINT, vaultAuthority, true))).toBe(true);
    expect(amount).toBe(250n);
    // domain 1 from the registry; the sibling ledger is domain ^ 1 = 0
    expect(vm.ledger.equals(deriveLpBackingLedger(PROG, MARKET, 1)[0])).toBe(true);
    expect(vm.siblingLedger.equals(deriveLpBackingLedger(PROG, MARKET, 0)[0])).toBe(true);
    expect(vm.lpPortfolio.equals(LP)).toBe(true);
    expect(vm.ext).toBeUndefined();
    expect(h.conn.getMultipleAccountsInfo.mock.calls[0][0]).toHaveLength(3);
    // v2.2 off: no explicit CU limit
    expect(h.sendTx.mock.calls[0][0]).not.toHaveProperty("computeUnits");
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("v2.1 on adds the ext key to the batched read and to the market when the account exists (owned by the program)", async () => {
    h.v21 = true;
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), owned(), owned(), owned()]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(1n)));
    expect(h.conn.getMultipleAccountsInfo.mock.calls[0][0]).toHaveLength(4);
    const ext = fakePda("ext", PROG, MARKET);
    expect(h.deposit.mock.calls[0][0].ext.equals(ext)).toBe(true);
  });

  it("v2.1 on but the ext account is missing or foreign-owned: no ext on the market", async () => {
    h.v21 = true;
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), owned(), owned(), { owner: k(), data: new Uint8Array(1) }]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(1n)));
    expect(h.deposit.mock.calls[0][0].ext).toBeUndefined();
  });

  it("registry missing: domain defaults to 0 (and its sibling is 1)", async () => {
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [null, owned(), owned()]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(1n)));
    const vm = h.deposit.mock.calls[0][0];
    expect(vm.ledger.equals(deriveLpBackingLedger(PROG, MARKET, 0)[0])).toBe(true);
    expect(vm.siblingLedger.equals(deriveLpBackingLedger(PROG, MARKET, 1)[0])).toBe(true);
  });

  it("registry owned by another program is ignored (domain 0, decoder not asked); slots read are [registry, state, market]", async () => {
    const regData = new Uint8Array([1, 2, 3]);
    const stData = new Uint8Array([4, 5, 6]);
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [{ owner: k(), data: regData }, owned(stData), owned()]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(1n)));
    expect(h.decodeDomain).not.toHaveBeenCalled();
    expect(Array.from(h.decodeState.mock.calls[0][0])).toEqual([4, 5, 6]);
    expect(h.deposit.mock.calls[0][0].ledger.equals(deriveLpBackingLedger(PROG, MARKET, 0)[0])).toBe(true);
    const keys = h.conn.getMultipleAccountsInfo.mock.calls[0][0] as PublicKey[];
    expect(keys[2].equals(MARKET)).toBe(true);
    expect(keys[0].equals(h.deposit.mock.calls[0][0].registry)).toBe(true);
    expect(keys[1].equals(h.deposit.mock.calls[0][0].vaultLpState)).toBe(true);
  });

  it("registry that does not decode: domain 0", async () => {
    h.decodeDomain.mockReturnValue(null);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(1n)));
    expect(h.deposit.mock.calls[0][0].ledger.equals(deriveLpBackingLedger(PROG, MARKET, 0)[0])).toBe(true);
  });

  it("v2.2 on sends with the SDK's 96 compute-unit limit", async () => {
    h.v22 = true;
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(5n)));
    expect(h.sendTx.mock.calls[0][0].computeUnits).toBe(NAV_FLOW_COMPUTE_UNITS_V22[96].units);
  });

  it("zero / negative amount: refused before any read, plain message kept, busy released", async () => {
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(0n)).rejects.toThrow("Enter an amount greater than zero.");
    });
    expect(result.current.error).toBe("Enter an amount greater than zero.");
    expect(result.current.busy).toBe(false);
    expect(h.conn.getMultipleAccountsInfo).not.toHaveBeenCalled();
    await act(async () => {
      await expect(result.current.deposit(-1n)).rejects.toThrow();
    });
  });

  it("amount above a KNOWN wallet balance is refused before signing", async () => {
    h.balance.mockResolvedValue(100n);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(101n)).rejects.toThrow(/exceeds your wallet balance/);
    });
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/more than your wallet holds/i);
  });

  it("amount equal to the balance passes; an UNKNOWN balance (read failed) never blocks", async () => {
    h.balance.mockResolvedValue(100n);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.deposit(100n)));
    h.balance.mockResolvedValue(null);
    await act(async () => void (await result.current.deposit(10n ** 12n)));
    expect(h.sendTx).toHaveBeenCalledTimes(2);
  });
});

describe("context failures (no pool / wrong wallet / not connected)", () => {
  it("no vault-owned LP (state account missing): refused with the plain no-pool message", async () => {
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), null, owned()]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(1n)).rejects.toThrow("This market has no vault-owned LP.");
    });
    expect(result.current.error).toBe("This market has no vault-owned LP.");
    expect(h.sendTx).not.toHaveBeenCalled();
  });

  it("state account owned by another program, or undecodable: also no pool", async () => {
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), { owner: k(), data: new Uint8Array(8) }, owned()]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(1n)).rejects.toThrow(/no vault-owned LP/);
    });
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), owned(), owned()]);
    h.decodeState.mockReturnValue(null);
    await act(async () => {
      await expect(result.current.withdraw(1n)).rejects.toThrow(/no vault-owned LP/);
    });
  });

  it("only the junior owner may move the tranche", async () => {
    h.decodeState.mockReturnValue({ juniorOwner: k().toBytes(), lpPortfolio: LP.toBytes() });
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(1n)).rejects.toThrow("Only the junior owner can move the junior tranche.");
    });
    expect(result.current.error).toBe("Only the junior owner can move the junior tranche.");
  });

  it.each([
    ["wallet", () => (h.wallet = { publicKey: null })],
    ["slab", () => undefined],
    ["program", () => (h.slab = { programId: null, config: { collateralMint: MINT } })],
    ["config", () => (h.slab = { programId: PROG.toBase58(), config: null })],
  ])("missing %s: 'Wallet not connected' and nothing is read", async (name, mutate) => {
    mutate();
    const { result } = renderHook(() => useJuniorTranche(name === "slab" ? null : MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(1n)).rejects.toThrow("Wallet not connected");
    });
    expect(h.conn.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("a raw chain error from the RPC is never shown to the user", async () => {
    h.conn.getMultipleAccountsInfo = vi.fn(async () => {
      throw new Error("custom program error: 0x4b");
    });
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(1n)).rejects.toThrow();
    });
    expect(result.current.error).not.toMatch(/0x4b|custom program error/i);
    expect(result.current.error).toBeTruthy();
  });

  it("a new attempt clears the previous error", async () => {
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.deposit(0n)).rejects.toThrow();
    });
    expect(result.current.error).not.toBeNull();
    await act(async () => void (await result.current.deposit(1n)));
    expect(result.current.error).toBeNull();
  });
});

describe("withdraw (97)", () => {
  it("v2.2 off: idempotent ATA create + the app builder (vault authority passed), no CU limit", async () => {
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.withdraw(40n)));
    const [vm, owner, ownerAta, vaultToken, vaultAuthority, amount] = h.withdraw.mock.calls[0];
    expect(vaultAuthority.equals(deriveVaultAuthority(PROG, MARKET)[0])).toBe(true);
    expect(vaultToken.equals(getAssociatedTokenAddressSync(MINT, vaultAuthority, true))).toBe(true);
    expect(owner.equals(OWNER)).toBe(true);
    expect(ownerAta.equals(getAssociatedTokenAddressSync(MINT, OWNER))).toBe(true);
    expect(vm.market.equals(MARKET)).toBe(true);
    expect(amount).toBe(40n);
    const ixs = h.sendTx.mock.calls[0][0].instructions as TransactionInstruction[];
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(ixs[1].data[0]).toBe(97);
    expect(h.sendTx.mock.calls[0][0]).not.toHaveProperty("computeUnits");
    expect(h.tails).not.toHaveBeenCalled();
  });

  it("v2.2 on, no bond tranche: still the app builder, with the SDK's 97 compute limit", async () => {
    h.v22 = true;
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.withdraw(7n)));
    expect(h.tails).toHaveBeenCalledTimes(1);
    expect(h.withdraw).toHaveBeenCalledTimes(1);
    expect(h.v22Withdraw).not.toHaveBeenCalled();
    expect(h.sendTx.mock.calls[0][0].computeUnits).toBe(NAV_FLOW_COMPUTE_UNITS_V22[97].units);
  });

  it("v2.2 on + bond tranche: the SDK tail-aware builder with {bond:true} (prog refuses a bond-market 97 without the tranche)", async () => {
    h.v22 = true;
    const tailExt = k();
    h.tails.mockResolvedValue({ bondTranche: k(), vaultLpExt: tailExt });
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.withdraw(9n)));
    expect(h.withdraw).not.toHaveBeenCalled();
    const [accts, owner, ownerAta, vaultToken, amount, opts] = h.v22Withdraw.mock.calls[0];
    expect(accts.programId.equals(PROG)).toBe(true);
    expect(accts.market.equals(MARKET)).toBe(true);
    expect(accts.registryDomain).toBe(1);
    expect(accts.lpPortfolio.equals(LP)).toBe(true);
    expect(accts.vaultLpExt.equals(tailExt)).toBe(true); // no ext on the market read: falls back to the tails' ext
    expect(owner.equals(OWNER)).toBe(true);
    expect(ownerAta.equals(getAssociatedTokenAddressSync(MINT, OWNER))).toBe(true);
    expect(vaultToken.equals(getAssociatedTokenAddressSync(MINT, deriveVaultAuthority(PROG, MARKET)[0], true))).toBe(true);
    expect(amount).toBe(9n);
    expect(opts).toEqual({ bond: true });
  });

  it("v2.2 + bond tranche prefers the ext read with the market over the tails' ext", async () => {
    h.v22 = true;
    h.v21 = true;
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), owned(), owned(), owned()]);
    h.tails.mockResolvedValue({ bondTranche: k(), vaultLpExt: k() });
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.withdraw(1n)));
    const ext = fakePda("ext", PROG, MARKET);
    expect(h.v22Withdraw.mock.calls[0][0].vaultLpExt.equals(ext)).toBe(true);
  });

  it("v2.2 + bond tranche, no ext anywhere: vaultLpExt undefined", async () => {
    h.v22 = true;
    h.tails.mockResolvedValue({ bondTranche: k(), vaultLpExt: null });
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.withdraw(1n)));
    expect(h.v22Withdraw.mock.calls[0][0].vaultLpExt).toBeUndefined();
  });

  it("a simulation refusal 75 raises refused75 (wallet never opened) and shows a plain message; the next attempt resets it", async () => {
    h.sendTx.mockRejectedValueOnce(refusal75());
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.withdraw(1n)).rejects.toBeInstanceOf(SimulationRefusal);
    });
    expect(result.current.refused75).toBe(true);
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toMatch(/0x4b|custom program error|Custom\(75\)/i);
    expect(result.current.busy).toBe(false);
    await act(async () => void (await result.current.withdraw(1n)));
    expect(result.current.refused75).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("another failure does not raise refused75", async () => {
    h.sendTx.mockRejectedValueOnce(new Error("blockhash expired"));
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.withdraw(1n)).rejects.toThrow("blockhash expired");
    });
    expect(result.current.refused75).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

describe("busy flag", () => {
  it("is true while the send is in flight and false after", async () => {
    let release!: (s: string) => void;
    h.sendTx.mockReturnValueOnce(new Promise<string>((r) => (release = r)));
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    let p!: Promise<string>;
    act(() => {
      p = result.current.deposit(1n);
    });
    await vi.waitFor(() => expect(result.current.busy).toBe(true));
    await act(async () => {
      release("DONE");
      await p;
    });
    expect(result.current.busy).toBe(false);
  });
});

describe("releaseResolved (102)", () => {
  it("no empty portfolios: one tx of the release ixs, no bundled CU sizing; harvest/idle come from the market data", async () => {
    h.needsHarvest.mockReturnValue(true);
    h.idle.mockReturnValue([3n, 4n]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.releaseResolved(500n)));
    const marketBytes = h.needsHarvest.mock.calls[0][0] as Uint8Array;
    expect(Array.from(marketBytes)).toEqual([9, 9]);
    expect(h.needsHarvest.mock.calls[0][1]).toBe(1);
    expect(h.idle.mock.calls[0][1]).toBe(1);
    const [ctx, amount, harvest, idle] = h.releaseIxs.mock.calls[0];
    expect(ctx.owner.equals(OWNER)).toBe(true);
    expect(amount).toBe(500n);
    expect(harvest).toBe(true);
    expect(idle).toEqual([3n, 4n]);
    const sent = h.sendTx.mock.calls[0][0];
    expect(sent.instructions).toHaveLength(1);
    expect(sent).not.toHaveProperty("computeUnitsFromSim");
  });

  it("market account missing: marketData null is passed through", async () => {
    h.conn.getMultipleAccountsInfo = vi.fn(async () => [owned(), owned(), null]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.releaseResolved(1n)));
    expect(h.needsHarvest.mock.calls[0][0]).toBeNull();
  });

  it("empty portfolios materialized: closes are bundled first and sized from simulation up to the cap", async () => {
    const close = noopIx(8);
    h.emptyCloses.mockResolvedValue([close]);
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => void (await result.current.releaseResolved(1n)));
    const sent = h.sendTx.mock.calls[0][0];
    expect(sent.instructions[0]).toBe(close);
    expect(sent.instructions).toHaveLength(2);
    expect(sent.computeUnitsFromSim).toEqual({ cap: EMPTY_CLOSE_BUNDLE_CU_CAP });
    // the packet gate is asked for: owner pays, every close is droppable
    const packet = h.packets[0] as { feePayer: PublicKey; droppable: number };
    expect(packet.feePayer.equals(OWNER)).toBe(true);
    expect(packet.droppable).toBe(1);
    // the simulate callback prepends a compute-budget prefix and reports the sim error (or null)
    const args = h.emptyCloses.mock.calls[0][0];
    expect(args.payer.equals(OWNER)).toBe(true);
    expect(args.collateralMint.equals(MINT)).toBe(true);
    expect(await args.simulate([noopIx(8)])).toBeNull();
    h.simulate.mockResolvedValueOnce({ err: "boom" });
    expect(await args.simulate([noopIx(8)])).toBe("boom");
    expect(h.simulate.mock.calls[0][0]).toHaveLength(2); // the budget prefix, then the close
  });

  it("bundle refused before signing: falls back to the release alone", async () => {
    h.emptyCloses.mockResolvedValue([noopIx(8)]);
    h.sendTx.mockRejectedValueOnce(new SimulationRefusal({ InstructionError: [0, { Custom: 21 }] }, [], [])).mockResolvedValueOnce("ALONE");
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    let sig = "";
    await act(async () => {
      sig = await result.current.releaseResolved(1n);
    });
    expect(sig).toBe("ALONE");
    expect(h.sendTx).toHaveBeenCalledTimes(2);
    expect(h.sendTx.mock.calls[1][0].instructions).toHaveLength(1);
  });

  it("zero amount, no-pool and wrong-owner are refused with plain messages and busy resets", async () => {
    const { result } = renderHook(() => useJuniorTranche(MARKET.toBase58()));
    await act(async () => {
      await expect(result.current.releaseResolved(0n)).rejects.toThrow("Enter an amount greater than zero.");
    });
    expect(result.current.error).toBe("Enter an amount greater than zero.");
    h.decodeState.mockReturnValue({ juniorOwner: k().toBytes(), lpPortfolio: LP.toBytes() });
    await act(async () => {
      await expect(result.current.releaseResolved(1n)).rejects.toThrow(/Only the junior owner/);
    });
    expect(result.current.error).toBe("Only the junior owner can move the junior tranche.");
    expect(result.current.busy).toBe(false);
    expect(h.sendTx).not.toHaveBeenCalled();
  });
});

