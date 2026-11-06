/**
 * #3613: each bond action resolves its error with its OWN surface. A refused withdraw request / execute must read as a
 * withdrawal ("your withdrawal stays ready to collect"), never as a deposit ("Nothing was deposited").
 * Wrapper RC handle_bond_execute_withdraw (tag 110) raises EngineLockActive (21: not Live/Resolved, band mark lagging)
 * and EngineCounterUnderflow (25: claim/share accounting); tag 109 raises neither (only BondConfigInvalid / account
 * checks), so its cases pin the surface wiring rather than a live refusal.
 */
import { act, renderHook } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { wrapperRefusal } from "@/lib/v22/refusal";
import { SimulationRefusal } from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { COMPUTE_PRESETS_V22 } from "@/lib/v22/sdk";
import type { TransactionInstruction } from "@solana/web3.js";
import type { EarnV22Context } from "@/lib/v22/earn-context";

const m = vi.hoisted(() => ({ sendTx: vi.fn(), owner: null as unknown, harvest: vi.fn(), ext: null as unknown }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: {} }), useWalletCompat: () => ({ publicKey: m.owner }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => 10n }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<Record<string, unknown>>()), sendTx: (...a: unknown[]) => m.sendTx(...a) }));
vi.mock("@/lib/v21/sdk", async (orig) => ({ ...(await orig<Record<string, unknown>>()), deriveVaultLpExt: () => m.ext }));
vi.mock("@/lib/v22/market-accounts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  vaultTokenOf: () => Keypair.generate().publicKey,
  readBondAccounts: async () => ({ tranche: {}, position: { shares: 10n, pendingWithdrawShares: 10n }, trancheKey: Keypair.generate().publicKey, positionKey: Keypair.generate().publicKey }),
}));
// jsdom cannot derive PDAs (sha256 over its Uint8Array): the builders are stubbed, this file pins the error surface only.
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: () => Keypair.generate().publicKey }));
vi.mock("@/lib/v22/sdk", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const { TransactionInstruction, Keypair: K } = await import("@solana/web3.js");
  const stub = (tag: number) => () => new TransactionInstruction({ programId: K.generate().publicKey, keys: [], data: Buffer.from([tag]) });
  return { ...real, buildBondDepositIxV22: stub(108), buildBondRequestWithdrawIxV22: stub(109), buildBondExecuteWithdrawIxV22: stub(110), buildLpVaultCrankFeesIxBoundV22: (...a: unknown[]) => { m.harvest(...a); return stub(78)(); } };
});
vi.mock("@/lib/v22/bond-ui", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  bondCardState: () => ({}),
  bondWithdrawQuote: () => ({ refusal: null, minOut: 1_000n }),
  bondDepositQuote: () => ({ refusal: null, minShares: 1n }),
}));

import { useBondV22 } from "@/hooks/useBondV22";

const k = () => Keypair.generate().publicKey;
const ctx: EarnV22Context = {
  market: k(), programId: new PublicKey(resolveDevnetProgramIds().wrapper), collateralMint: k(), decimals: 6, symbol: "USDC", registryDomain: 0, lpPortfolio: k(),
  view: { vaultValue: 1_000_000n, seniorClaimEff: 0n } as unknown as EarnV22Context["view"], registryShares: null, oiLongQ: 0n, oiShortQ: 0n, lpEffAbsQ: 0n,
};

async function mounted() {
  const r = renderHook(() => useBondV22(ctx));
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });
  return r;
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
  m.owner = Keypair.generate().publicKey;
  m.sendTx.mockReset();
  m.harvest.mockReset();
  m.ext = Keypair.generate().publicKey;
});
afterEach(() => __setDevnetV22ForTest(null));

describe("#3613 bond card error surface", () => {
  it.each([21, 25])("withdraw request refused %i: the withdraw line, never the deposit line", async (code) => {
    const e = wrapperRefusal(code);
    m.sendTx.mockRejectedValue(e);
    const { result } = await mounted();
    await act(async () => { await result.current.requestWithdraw(5n); });
    const want = resolveUserMessage(e, { surface: "earn-withdraw", symbol: "USDC" });
    expect(result.current.message?.details.raw, "raw").toBe(want.details.raw);
    expect(result.current.message?.kind).toBe(want.kind);
    expect(result.current.message?.body).toBe(want.body);
    expect(result.current.message?.body).not.toMatch(/deposit/i);
  });
  it.each([21, 25])("withdraw execute refused %i: the withdraw line, never the deposit line", async (code) => {
    const e = wrapperRefusal(code);
    m.sendTx.mockRejectedValue(e);
    const { result } = await mounted();
    expect(result.current.bond?.position).toBeTruthy();
    await act(async () => { await result.current.executeWithdraw(); });
    expect(m.sendTx).toHaveBeenCalledTimes(1);
    const want = resolveUserMessage(e, { surface: "earn-withdraw", symbol: "USDC" });
    expect(result.current.message?.details.raw, "raw").toBe(want.details.raw);
    expect(result.current.message?.kind).toBe(want.kind);
    expect(result.current.message?.body).not.toMatch(/deposit/i);
  });
  it("CONTROL: a refused deposit keeps the deposit line", async () => {
    const e = wrapperRefusal(21);
    m.sendTx.mockRejectedValue(e);
    const { result } = await mounted();
    await act(async () => { await result.current.deposit(100n); });
    expect(m.sendTx).toHaveBeenCalledTimes(1);
    expect(result.current.message?.body).toMatch(/Nothing was deposited/);
  });
});

/** A pre-sign refusal as sendTx throws it (simulated before the wallet opens). */
const simRefusal = (code: number, program = resolveDevnetProgramIds().wrapper) =>
  new SimulationRefusal({ InstructionError: [1, { Custom: code }] }, [`Program ${program} failed: custom program error: 0x${code.toString(16)}`]);
type Sent = { instructions: TransactionInstruction[]; computeUnits: number };
const sentTags = () => m.sendTx.mock.calls.map((c) => (c[0] as Sent).instructions.map((i) => i.data[0]));
const sentUnits = () => m.sendTx.mock.calls.map((c) => (c[0] as Sent).computeUnits);
const { VaultLpHarvestPending: E84, LpVaultNoFeesToCrank: E38 } = WRAPPER_ERR;

describe("bond 108 / 110: a pre-sign 84 resends once with 78 in front", () => {
  it.each([
    ["deposit", 108, COMPUTE_PRESETS_V22.bondDeposit.units],
    ["executeWithdraw", 110, COMPUTE_PRESETS_V22.bondExecuteWithdraw.units],
  ] as const)("%s: [%i] refused 84 -> [78, op] once, with 78's units added, no message", async (action, tag, units) => {
    m.sendTx.mockRejectedValueOnce(simRefusal(E84)).mockResolvedValueOnce("sig");
    const { result } = await mounted();
    await act(async () => { await (action === "deposit" ? result.current.deposit(100n) : result.current.executeWithdraw()); });
    expect(sentTags()).toEqual([[tag], [78, tag]]);
    expect(sentUnits()).toEqual([units, units + COMPUTE_PRESETS_V22.lpVaultCrankFeesBond.units]);
    // The 78 for THIS vault: its LP and ext, the bond tail, the vault's own pot, the wallet as cranker.
    expect(m.harvest).toHaveBeenCalledTimes(1);
    expect(m.harvest).toHaveBeenCalledWith(expect.objectContaining({ programId: ctx.programId, market: ctx.market, lpPortfolio: ctx.lpPortfolio, vaultLpExt: m.ext }), m.owner, ctx.registryDomain, { bond: true });
    expect(result.current.message).toBeNull();
  });
  it("happy path: no 84, no 78 (with nothing to harvest 78 refuses 38)", async () => {
    m.sendTx.mockResolvedValue("sig");
    const { result } = await mounted();
    await act(async () => { await result.current.deposit(100n); });
    expect(sentTags()).toEqual([[108]]);
    expect(m.harvest).not.toHaveBeenCalled();
  });
  it("38 on the resend (cranked in between): 'Fees were just collected', no third send", async () => {
    m.sendTx.mockRejectedValueOnce(simRefusal(E84)).mockRejectedValueOnce(simRefusal(E38));
    const { result } = await mounted();
    await act(async () => { await result.current.deposit(100n); });
    expect(sentTags()).toEqual([[108], [78, 108]]);
    expect(result.current.message?.body).toMatch(/Fees were just collected/);
  });
  it("no loop: a second 84 shows 'Collecting fees' after exactly two sends", async () => {
    m.sendTx.mockRejectedValue(simRefusal(E84));
    const { result } = await mounted();
    await act(async () => { await result.current.deposit(100n); });
    expect(sentTags()).toEqual([[108], [78, 108]]);
    expect(result.current.message?.title).toBe("Collecting fees");
  });
  it.each([
    ["another refusal (21)", () => simRefusal(21)],
    ["a CPI callee's 84", () => simRefusal(E84, Keypair.generate().publicKey.toBase58())],
    ["an 84 that is not a pre-sign SimulationRefusal", () => wrapperRefusal(E84)],
  ])("CONTROL not retried: %s", async (_n, err) => {
    m.sendTx.mockRejectedValue(err());
    const { result } = await mounted();
    await act(async () => { await result.current.deposit(100n); });
    expect(sentTags()).toEqual([[108]]);
  });
  it("CONTROL: the request (109) is sent once, alone", async () => {
    m.sendTx.mockResolvedValue("sig");
    const { result } = await mounted();
    await act(async () => { await result.current.requestWithdraw(5n); });
    expect(sentTags()).toEqual([[109]]);
  });
});
