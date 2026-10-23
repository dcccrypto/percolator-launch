// @vitest-environment node
/**
 * 2026-10-01 live bug: the creator of a relaunch market got a normal order ticket, signed, and
 * the trade leg was refused on-chain with SameOwnerTrade (Custom 67), shown as "Something went
 * wrong". The wrapper enforces 67 on every build; the ticket's same-owner gate only ran with
 * NEXT_PUBLIC_LIMITS_P1 on, which production does not set. These pin the gate with the flags OFF,
 * and the resolver/humanizer lines that replace "Something went wrong" for known causes.
 */
import { describe, it, expect } from "vitest";
import { deriveTicketLimits } from "@/lib/limits/ticket";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError, UNMAPPED_MESSAGE } from "@/lib/errorMessages";
import { SimulationRefusal } from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { marketLimits, OWNER_A } from "./fixtures";

const OFF_FLAGS = { p1: false, p2: false, p2FeeCharged: false, p3: false };
const CREATOR = new Uint8Array(32).fill(0x9c);
/** What useMarketLimits returns in production (flags off): no engine/LP view, asset_admin carried. */
const offLimits = (assetAdmin: Uint8Array | null) =>
  marketLimits({ state: "off", flags: OFF_FLAGS, engine: null, riskLimits: null, lp: null, matcher: null, vaultLp: null, assetAdmin });

const input = (over: Partial<Parameters<typeof deriveTicketLimits>[0]> = {}) => ({
  limits: offLimits(CREATOR),
  direction: "long" as const,
  sizeQ: 83_000_000_000n,
  takerPosQ: 0n,
  takerOwner: CREATOR,
  leverage: 1,
  limitPriceE6: 0n,
  ...over,
});

describe("creator close-only with the limits flags OFF", () => {
  it("the market's asset_admin cannot open: sameOwner blocks the ticket", () => {
    const t = deriveTicketLimits(input());
    expect(t.sameOwner).toBe(true);
    expect(t.sameOwnerCloseOnly).toBe(true);
    expect(t.issues.map((x) => x.kind)).toEqual(["same-owner"]);
  });

  it("the creator can still reduce an existing position (close-only, not blocked)", () => {
    const t = deriveTicketLimits(input({ takerPosQ: 5_000n, direction: "short" }));
    expect(t.sameOwnerCloseOnly).toBe(true);
    expect(t.sameOwner).toBe(false);
  });

  it("negative control: any other wallet gets the unchanged OFF result", () => {
    const t = deriveTicketLimits(input({ takerOwner: OWNER_A }));
    expect(t.sameOwner).toBe(false);
    expect(t.sameOwnerCloseOnly).toBe(false);
    expect(t.issues).toEqual([]);
    expect(t.sideLimits).toBeNull();
  });

  it("negative control: no asset_admin read (null) never blocks", () => {
    expect(deriveTicketLimits(input({ limits: offLimits(null) })).sameOwner).toBe(false);
    expect(deriveTicketLimits(input({ limits: offLimits(new Uint8Array(32)) })).sameOwner).toBe(false);
  });
});

describe("the first-trade refusal maps to its line (no 'Something went wrong')", () => {
  it("SameOwnerTrade from the wrapper in the combined A+B simulation", () => {
    const wrapper = resolveDevnetProgramIds().wrapper;
    const refusal = new SimulationRefusal({ InstructionError: [5, { Custom: WRAPPER_ERR.SameOwnerTrade }] }, [
      `Program ${wrapper} invoke [1]`,
      `Program ${wrapper} failed: custom program error: 0x43`,
    ]);
    const u = resolveUserMessage(refusal, { surface: "trade", side: "long" });
    expect(u.kind).toBe("same-owner");
    expect(u.body).not.toMatch(/something went wrong/i);
  });
});

describe("app pre-sign refusals get a specific calm line", () => {
  const cases: Array<[string, string]> = [
    ["No LP portfolio with an active matcher config found for this market. The LP must call SetMatcherConfig before trading.", "market-not-ready"],
    ["Failed to scan LP portfolio accounts on-chain: 429 Too Many Requests", "network-busy"],
    ["account not found: 9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn", "out-of-date"],
    ["Trade already in progress", "in-progress"],
    ["This market's matcher is not the recognized Percolator matcher program. Refusing to build a transaction.", "unsupported-market"],
    ["Wallet does not support signAllTransactions or signTransaction", "wallet-unsupported"],
    ["Market not loaded", "market-loading"],
    ["Deposit amount exceeds your wallet balance (requested 5, available 1 base units). Reduce the amount to what your wallet holds.", "amount-too-large"],
    ["Cannot compute slippage limit: live mark price unavailable. Wait for the oracle to load, then retry.", "price-wait"],
  ];
  for (const [raw, kind] of cases) {
    it(`${kind}: ${raw.slice(0, 40)}`, () => {
      const u = resolveUserMessage(new Error(raw), { surface: "trade" });
      expect(u.kind).toBe(kind);
      expect(u.body).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}|SetMatcherConfig|429/);
    });
  }

  it("negative control: an unknown raw failure stays unmapped (no invented cause)", () => {
    expect(resolveUserMessage(new Error("Transaction simulation failed: weird"), { surface: "trade" }).kind).toBe("unmapped");
  });
});

describe("humanizeError never hides a cause it can name", () => {
  it("runtime / RPC / wallet free text is never shown verbatim (review of #2726)", () => {
    for (const raw of [
      "Cannot read properties of undefined (reading 'toBytes')",
      "failed to get recent blockhash: TypeError: fetch failed",
      'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
      "WalletSignTransactionError: Something went wrong in the extension",
      "Request failed with status code 500",
    ]) {
      expect(humanizeError(raw, "trade")).toBe(UNMAPPED_MESSAGE);
    }
  });
  it("an unknown on-chain code is named", () => {
    expect(humanizeError("custom program error: 0x7a69", "trade")).toBe("Solana didn't accept this (error 31337), so nothing changed.");
  });
  it("negative control: raw chain text with no code still gets the unmapped line", () => {
    expect(humanizeError("Transaction simulation failed: Program 9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn consumed", "trade")).toBe(UNMAPPED_MESSAGE);
  });
});
