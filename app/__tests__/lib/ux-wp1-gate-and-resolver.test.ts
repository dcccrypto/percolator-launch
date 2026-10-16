// @vitest-environment node
/**
 * UX WP-1 (ux-audit-2026-09-30.md §7): the simulation gate (SH-1) and the ONE message resolver
 * (§5.3). AC2: every code × {Phantom hex, Solflare JSON} resolves to copy with no §5.1 banned
 * term, with the code only in `details`. AC3: Earn 84/85/74 never "Program error". AC4: the
 * creator-stake 75 is mapped. AC5's negative control lives in scratch negctl (gate reverted).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { sendTx, SimulationRefusal } from "@/lib/tx";
import { keepAppMessage, plainMessage, resolveUserMessage, type MessageSurface } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { earnErrorMessage } from "@/lib/earnErrors";

const WRAPPER = resolveDevnetProgramIds().wrapper;
const MATCHER = resolveDevnetProgramIds().matcher;
const SIG = bs58.encode(new Uint8Array(64).fill(7));

function conn(sim: { err: unknown; logs?: string[]; unitsConsumed?: number }) {
  const events: string[] = [];
  const c = {
    rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    simulateTransaction: vi.fn(async () => {
      events.push("simulate");
      return { value: { err: sim.err, logs: sim.logs ?? [], unitsConsumed: sim.unitsConsumed ?? 50_000 } };
    }),
    sendRawTransaction: vi.fn(async () => {
      events.push("broadcast");
      return SIG;
    }),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] }),
  };
  return { c: c as never, raw: c, events };
}
function wallet(events: string[]) {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx: Transaction) => {
      events.push("wallet-prompt");
      tx.partialSign(kp);
      return tx;
    }),
  };
}
// No signer beyond the fee payer: the wallet's signature is the only one needed.
const ix = () => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
afterEach(() => vi.restoreAllMocks());

describe("SH-1 simulation gate: no wallet prompt for a doomed tx", () => {
  const band66 = { err: { InstructionError: [2, { Custom: WRAPPER_ERR.ExecPriceOutsideOracleBand }] }, logs: [`Program ${WRAPPER} failed: custom program error: 0x42`] };

  it("trade path (CU-sizing simulation): refusal => 0 prompts, typed SimulationRefusal, one RPC", async () => {
    const { c, raw, events } = conn(band66);
    const w = wallet(events);
    const err = await sendTx({ connection: c, wallet: w, instructions: [ix()], computeUnitsFromSim: { cap: 400_000 } }).catch((e) => e);
    expect(err).toBeInstanceOf(SimulationRefusal);
    expect(err.code).toBe(66);
    expect(err.instructionIndex).toBe(2);
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(events).toEqual(["simulate"]);
    expect(raw.simulateTransaction).toHaveBeenCalledTimes(1);
    // ...and the resolver turns it into the ticket's one line with its next step.
    const u = resolveUserMessage(err, { surface: "trade", side: "long", symbol: "SOL", maxNow: "12.5" });
    expect(u.kind).toBe("price-moved");
    expect(u.body).toBe("The price moved too far for this size. Most you can open now: 12.5 SOL.");
    expect(u.action).toEqual({ id: "use-max", label: "Use 12.5" });
    expect(u.details.code).toBe(66);
    expect(u.details.name).toBe("ExecPriceOutsideOracleBand");
  });

  it("a GREEN CU simulation is reused: no second simulation, then exactly one prompt", async () => {
    const { c, raw, events } = conn({ err: null, unitsConsumed: 80_000 });
    const w = wallet(events);
    await sendTx({ connection: c, wallet: w, instructions: [ix()], computeUnitsFromSim: { cap: 400_000 } });
    expect(raw.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["simulate", "wallet-prompt", "broadcast"]);
  });

  it("default path (no CU sizing) also simulates BEFORE the prompt", async () => {
    const { c, events } = conn(band66);
    const w = wallet(events);
    await expect(sendTx({ connection: c, wallet: w, instructions: [ix()] })).rejects.toBeInstanceOf(SimulationRefusal);
    expect(w.signTransaction).not.toHaveBeenCalled();
  });

  it("an RPC failure of the simulation is not a refusal (the wallet still opens)", async () => {
    const { c, raw, events } = conn({ err: null });
    raw.simulateTransaction = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const w = wallet(events);
    await sendTx({ connection: c, wallet: w, instructions: [ix()] });
    expect(w.signTransaction).toHaveBeenCalledTimes(1);
  });
});

// §5.1 banned in user-visible strings (the Details disclosure may keep them).
const BANNED: RegExp[] = [
  /\bLPs?\b/, /liquidity provider/i, /\btranche/i, /\bsenior/i, /\bjunior/i, /\bNAV\b/, /\bC_eff\b/, /cushion/i,
  /\bcrank/i, /\bkeeper/i, /maintainer/i, /re-?seed/i, /\bcert(ificate)?\b/i, /certified equity/i, /valuation stale/i,
  /\bslots?\b/i, /\brecall/i, /\bharvest/i, /\bescrow/i, /\bpot\b/i, /backing bucket/i, /\bdrain/i, /reset side/i,
  /\bmatcher/i, /\bvAMM\b/i, /\bbps\b/i, /\bslab\b/i, /\bportfolio/i, /sub-account/i, /RebalanceReduce/, /unilateral exit/i,
  /\btag \d+/i, /permissionless/i, /the program refused/i, /rejected by the program/i, /Custom\(\d+\)/, /\b0x[0-9a-f]+/i,
  /\bcode \d+/i, /Program error/i, /Transaction failed:/i, /SOL-PERP/, /\bunits\b/i,
];
function assertPlain(s: string, where: string) {
  for (const b of BANNED) expect(s, `${where}: ${b}`).not.toMatch(b);
}

describe("resolveUserMessage (§5.3): every code, both wallet shapes, plain words only", () => {
  const W = WRAPPER_ERR;
  const codes: [number, MessageSurface, string][] = [
    [W.EngineStale, "trade", "engine-catching-up"],
    [W.EngineLockActive, "trade", "engine-catching-up"],
    [W.ExecPriceOutsideOracleBand, "trade", "price-moved"],
    [W.SameOwnerTrade, "trade", "same-owner"],
    [W.LpExposureCapExceeded, "trade", "too-large"],
    [W.ProtocolSideOiCapExceeded, "trade", "too-large"],
    [W.VaultLpExposureCapExceeded, "trade", "too-large"],
    [W.LpFloorHalt, "trade", "side-paused"],
    [W.LpFloorHalt, "close", "close-paused"],
    [W.CloseSlabFeesOutstanding, "close-market", "fees-collecting"],
    [W.VaultLpAlreadyBound, "create", "setup-not-allowed"],
    [W.VaultLpNotBound, "create", "setup-not-allowed"],
    [W.VaultLpBoundCannotClose, "create", "setup-not-allowed"],
    [W.VaultLpMatcherNotApproved, "create", "setup-not-allowed"],
    [W.VaultLpUseSettleResolved, "create", "setup-not-allowed"],
    [W.VaultLpMultiAssetMarket, "create", "setup-not-allowed"],
    [W.VaultLpSeniorImpaired, "earn-deposit", "earn-deposits-paused"],
    [W.VaultLpJuniorWithdrawRefused, "creator-stake", "stake-locked"],
    [W.VaultLpRecallRefused, "any", "try-later"],
    [W.VaultLpExclusiveCounterparty, "trade", "route-unavailable"],
    [W.VaultLpLeverageStepDown, "trade", "lower-leverage"],
    [W.VaultLpReleaseRefused, "creator-stake", "stake-nothing"],
    [W.VaultLpHarvestPending, "earn-deposit", "earn-fees-collecting"],
    [W.VaultLpValuationStale, "earn-deposit", "earn-value-updating"],
    [W.VaultLpSeniorDrawRequired, "earn-withdraw", "earn-booking-move"],
    [W.VaultLpRedeemNeedsRecall, "earn-withdraw", "earn-in-use"],
    [W.VaultLpPausedForSeniorDraw, "creator-stake", "paused-earn-covers-loss"],
    [W.LpVaultCooldownActive, "earn-withdraw", "earn-cooldown"],
    [W.LpVaultOiReservationViolated, "earn-withdraw", "earn-partial-now"],
    [W.EngineInsufficientInitialMargin, "trade", "insufficient-margin"],
    [W.Unauthorized, "any", "wrong-wallet"],
  ];
  const shapes = (code: number) => ({
    phantom: new Error(`Transaction simulation failed: Error processing Instruction 2: custom program error: 0x${code.toString(16)}\nProgram ${WRAPPER} failed: custom program error: 0x${code.toString(16)}`),
    // Solflare's JSON shape as sendTx's gate delivers it: a SimulationRefusal attributed to the
    // failing program (here the wrapper) — the resolver never guesses the program.
    solflare: Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`), {
      name: "SimulationRefusal", code, programId: WRAPPER, logs: [] as string[],
    }),
  });
  for (const [code, surface, kind] of codes) {
    for (const [shape, err] of Object.entries(shapes(code))) {
      it(`${code} on ${surface} (${shape}) -> ${kind}`, () => {
        const u = resolveUserMessage(err, { surface, side: "long", symbol: "SOL" });
        expect(u.kind).toBe(kind);
        assertPlain(`${u.title} ${u.body} ${u.action?.label ?? ""}`, `${code}/${shape}`);
        expect(`${u.title} ${u.body}`).not.toContain(String(code).length > 1 ? `(${code})` : "()");
        expect(u.details.code).toBe(code);
        expect(u.title.split(/\s+/).length).toBeLessThanOrEqual(5);
        expect(u.body.split(/\s+/).length).toBeLessThanOrEqual(30);
      });
    }
  }
  it("21 is refined by live state: settled / close-only / no room / waiting for price", () => {
    const e = shapes(W.EngineLockActive).solflare;
    expect(resolveUserMessage(e, { surface: "trade", health: { resolved: true } }).kind).toBe("market-settled");
    expect(resolveUserMessage(e, { surface: "trade", health: { adlReduceOnly: true } }).title).toBe("Close-only for now");
    expect(resolveUserMessage(e, { surface: "trade", health: { lpDepleted: true } }).kind).toBe("lp-depleted");
    expect(resolveUserMessage(e, { surface: "trade", health: { lossStale: true } }).variant).toBe("wait");
    expect(resolveUserMessage(e, { surface: "earn-withdraw", p3Bound: true }).kind).toBe("earn-payout-wait");
  });
  it("49 on an open with the counterparty below the IM floor is the market's state, not the trader's margin", () => {
    // STONK 2026-10-07: LP at 0.84 USDC against a 2 USDC floor; every open is 49 whatever the trader deposits.
    const e = shapes(W.EngineInsufficientInitialMargin).solflare;
    const u = resolveUserMessage(e, { surface: "trade", side: "long", health: { lpDepleted: true }, imFloorLabel: "$2" });
    expect(u.kind).toBe("lp-depleted");
    expect(u.variant).toBe("paused");
    expect(u.body).not.toMatch(/margin|collateral/i);
    expect(resolveUserMessage(e, { surface: "trade", health: { lpDepleted: true, lpIsVault: true } }).body).toMatch(/Earn vault/);
    // NEGATIVE CONTROLS: a funded counterparty keeps the margin message; a close is never the LP's fault.
    expect(resolveUserMessage(e, { surface: "trade", health: { lpDepleted: false }, imFloorLabel: "$2" }).kind).toBe("insufficient-margin");
    expect(resolveUserMessage(e, { surface: "close", health: { lpDepleted: true } }).kind).toBe("insufficient-margin");
  });

  it("matcher codes are the matcher's: 8002/8003 wait, 8004 unavailable; a wrapper 66 is never read as matcher", () => {
    const m = (n: number) => new Error(`Program ${MATCHER} failed: custom program error: 0x${n.toString(16)}`);
    expect(resolveUserMessage(m(8002), { surface: "trade" }).kind).toBe("price-wait");
    expect(resolveUserMessage(m(8004), { surface: "trade" }).kind).toBe("market-unavailable");
  });
  it("a Custom(n) is decoded only by the program that raised it (error-codes-4b1a5d30.md)", () => {
    // unattributed (bare Solflare JSON, no log, no refusal program): no guess
    const bare = resolveUserMessage(new Error('{"InstructionError":[2,{"Custom":66}]}'), { surface: "trade" });
    expect(bare.kind).toBe("unmapped");
    expect(bare.details.code).toBe(66);
    expect(bare.details.name).toBeNull();
    // SPL Token Custom(1) (insufficient funds) is NOT the wrapper's InvalidVersion
    const spl = resolveUserMessage(new Error("Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1"), { surface: "trade" });
    expect(spl.details.name).toBeNull();
    // a matcher-raised 66 is not the wrapper's band refusal
    expect(resolveUserMessage(new Error(`Program ${MATCHER} failed: custom program error: 0x42`), { surface: "trade" }).kind).toBe("unmapped");
    // the SAME 66 raised by the wrapper is
    expect(resolveUserMessage(new Error(`Program ${WRAPPER} failed: custom program error: 0x42`), { surface: "trade" }).kind).toBe("price-moved");
  });
  it("wallet / network conditions", () => {
    const r = (s: string) => resolveUserMessage(new Error(s), { surface: "any" });
    expect(r("User rejected the request.").quiet).toBe(true);
    expect(r("Wallet is locked").body).toBe("Unlock your wallet and try again.");
    expect(r("Attempt to debit an account but found no record of a prior credit.").action?.id).toBe("get-funds");
    expect(r('{"InstructionError":[1,"NotEnoughAccountKeys"]}').kind).toBe("out-of-date");
    expect(r("Blockhash not found").kind).toBe("network-slow");
    expect(r("429 Too Many Requests").kind).toBe("rpc-unreachable");
    const u = r("custom program error: 0x7e7e7e");
    expect(u.kind).toBe("unmapped");
    expect(u.body).toBe("Something went wrong and nothing was sent.");
    expect(u.details.raw).toContain("0x7e7e7e");
  });
});

describe("AC3: Earn 84/85/74 (and every P3 Earn code) never render 'Program error'", () => {
  for (const code of [WRAPPER_ERR.VaultLpHarvestPending, WRAPPER_ERR.VaultLpValuationStale, WRAPPER_ERR.VaultLpSeniorImpaired, WRAPPER_ERR.VaultLpSeniorDrawRequired, WRAPPER_ERR.VaultLpRedeemNeedsRecall, WRAPPER_ERR.VaultLpPausedForSeniorDraw]) {
    for (const action of ["deposit", "claim"] as const) {
      it(`${code} on ${action}`, () => {
        const m = earnErrorMessage(new Error(`Program ${WRAPPER} failed: custom program error: 0x${code.toString(16)}`), action, { p3Bound: true });
        expect(m).not.toMatch(/Program error|Custom\(|0x[0-9a-f]/i);
        assertPlain(m, `earn ${code}`);
      });
    }
  }
});

describe("AC4: creator stake 75 is mapped (useJuniorTranche routes through the resolver)", () => {
  it("75 -> the plain reason; app-thrown plain messages are kept; raw chain text never passes", () => {
    const m = plainMessage(new Error(`Program ${WRAPPER} failed: custom program error: 0x4b`), { surface: "creator-stake" }, keepAppMessage);
    expect(m).toMatch(/^Locked while traders have open positions/);
    expect(plainMessage(new Error("Enter an amount greater than zero."), { surface: "creator-stake" }, keepAppMessage)).toBe("Enter an amount greater than zero.");
    expect(keepAppMessage("Transaction simulation failed: {\"InstructionError\":[0,{\"Custom\":999}]}")).toBe("Something went wrong and nothing was sent.");
    const src = readFileSync(join(process.cwd(), "hooks/useJuniorTranche.ts"), "utf8");
    expect(src.match(/setError\(plainMessage\(e, \{ surface: 'creator-stake' \}, keepAppMessage\)\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/setError\(msg\)/);
  });
});
