/**
 * UX WP-3 (audit §3.3): the order ticket's state machine as ONE pure function. The ticket has
 * one status slot and one submit button whose label IS the state; the first matching row wins.
 * Everything the component shows in the slot or on the button comes from here and is tested.
 */
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { TICKET_COPY as T, TICKET_FUNDS_LINE } from "./copy";
import type { StatusVariant } from "./user-message";
import type { Side } from "./risk-limits";

export type TicketRow =
  | "retired"
  | "settled"
  | "admin-paused"
  | "close-only"
  | "catching-up"
  | "waiting-price"
  | "side-paused"
  | "both-paused"
  | "same-owner"
  | "exceeds-balance"
  | "fee-over-max"
  | "ok";

export interface TicketStateInput {
  direction: Side;
  /** Base ticker, never "SOL-PERP". */
  baseSymbol: string;
  leverageLabel: string;
  marketRetired: boolean;
  marketResolved: boolean;
  marketPaused: boolean;
  adlReduceOnly: boolean;
  /** The engine lag is beyond what the app's own catch-up cranks repair (WP-2). */
  engineStale: boolean;
  /** No price yet, the oracle isn't live, or its price is stale. */
  waitingForPrice: boolean;
  /** Per-side "no room for new exposure" (P1 halt, a legacy side capacity of 0). */
  sidePaused: Record<Side, boolean>;
  /** The market as a whole can't open (no liquidity, de-risking). */
  openingPaused: boolean;
  /** No funds left to take the other side of new trades (market health lpDepleted). */
  lpDepleted?: boolean;
  /** The counterparty is a P3 Earn-vault LP, so the Earn vault is what refills it. */
  lpIsVault?: boolean;
  sameOwner: boolean;
  exceedsBalance: boolean;
  /** The deposit that rides with the trade, "Deposit {x} & Long", e.g. "12.50 USDC" (UX WP-6). */
  shortfallLabel: string;
  /** P2: the quote's fee is over the market / protocol max for this size. */
  feeOverMax: boolean;
  /** A size under which the fee fits, formatted ("2.5 SOL"), or null. */
  feeSuggested: string | null;
}

export interface TicketStatus {
  kind: string;
  variant: StatusVariant;
  title: string;
  body: string;
}

export interface TicketState {
  row: TicketRow;
  /** The button label: the state itself, or the order ("Long SOL 5×"). */
  buttonLabel: string;
  /** Rows that block submit. `exceeds-balance` does not block: its button opens the deposit. */
  blocks: boolean;
  /** Waiting rows re-enable on their own (they listen to the freshness hooks). */
  waiting: boolean;
  status: TicketStatus | null;
  /** Row 5: the selected side is paused and the other is open, so select it. */
  autoSelect: Side | null;
}

const other = (s: Side): Side => (s === "long" ? "short" : "long");
const plural = (s: Side) => (s === "long" ? "longs" : "shorts");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function paused(row: TicketRow, kind: string, title: string, body: string, button: string, variant: StatusVariant = "paused"): TicketState {
  return { row, buttonLabel: button, blocks: true, waiting: variant === "wait", status: { kind, variant, title, body }, autoSelect: null };
}

export function deriveTicketState(i: TicketStateInput): TicketState {
  const d = i.direction;
  if (i.marketRetired) return paused("retired", "retired", T.retired.title, T.retired.body, T.retired.button);
  if (i.marketResolved) return paused("settled", "settled", T.settled.title, T.settled.body, T.settled.button, "info");
  if (i.marketPaused) return paused("admin-paused", "admin-paused", T.adminPaused.title, T.adminPaused.body, T.adminPaused.button);
  if (i.adlReduceOnly) {
    // Depleted as well: the close-only lock lifting is not enough on its own, so say what else it needs.
    const body = i.lpDepleted ? `${T.closeOnly.body} ${TICKET_FUNDS_LINE(i.lpIsVault === true)}` : T.closeOnly.body;
    return paused("close-only", "close-only", T.closeOnly.title, body, T.closeOnly.button);
  }
  if (i.engineStale) return paused("catching-up", "engine-catching-up", T.catchingUp.title, T.catchingUp.body, T.catchingUp.button, "wait");
  if (i.waitingForPrice) return paused("waiting-price", "waiting-price", T.waitingPrice.title, T.waitingPrice.body, T.waitingPrice.button, "wait");
  // A depleted market gets its own reason; the generic "Opening paused" stays neutral because it
  // also fires for an empty vault, an underfunded counterparty and the risk gate.
  if (i.lpDepleted) return paused("both-paused", "lp-depleted", T.lpDepleted.title, T.lpDepleted.body(i.lpIsVault === true), T.lpDepleted.button);
  const bothSides = i.openingPaused || (i.sidePaused.long && i.sidePaused.short);
  if (!bothSides && i.sidePaused[d]) {
    const s = paused("side-paused", "side-paused", T.sidePaused.title(plural(d)), T.sidePaused.body(plural(d), d, cap(plural(other(d)))), T.sidePaused.button(plural(d)));
    return { ...s, autoSelect: other(d) };
  }
  if (bothSides) return paused("both-paused", "both-paused", T.bothPaused.title, T.bothPaused.body, T.bothPaused.button);
  if (i.sameOwner) return paused("same-owner", "same-owner", T.sameOwner.title, T.sameOwner.body, T.sameOwner.button);
  if (i.exceedsBalance) {
    return { row: "exceeds-balance", buttonLabel: T.depositToTrade(i.shortfallLabel, cap(d)), blocks: false, waiting: false, status: null, autoSelect: null };
  }
  if (i.feeOverMax) return paused("fee-over-max", "fee-over-max", T.feeOverMax.title, T.feeOverMax.body(i.feeSuggested), T.feeOverMax.button, "error");
  return {
    row: "ok",
    buttonLabel: `${cap(d)} ${i.baseSymbol} ${i.leverageLabel}×`,
    blocks: false,
    waiting: false,
    status: null,
    autoSelect: null,
  };
}

/**
 * The ONE max per side (audit §4.2, TR-2): the tightest of every cap the market enforces
 * (P1 `maxTradeSizePerSide`, the matcher per-trade cap, the legacy side capacity) and what the
 * balance can margin at the chosen leverage. null = nothing bounds it (no figure shown).
 */
export function oneMaxQ(caps: Array<bigint | null | undefined>): bigint | null {
  let m: bigint | null = null;
  for (const c of caps) {
    if (c === null || c === undefined || c < 0n || c >= UNLIMITED_CAPACITY) continue;
    if (m === null || c < m) m = c;
  }
  return m;
}

/** Base q the balance can margin at `leverage` (x, may be fractional) at `priceE6`. */
export function balanceMaxQ(balanceAtoms: bigint, leverage: number, priceE6: bigint | null | undefined): bigint | null {
  if (!priceE6 || priceE6 <= 0n || balanceAtoms <= 0n || !(leverage > 0)) return null;
  const lev100 = BigInt(Math.max(1, Math.floor(leverage * 100)));
  return (balanceAtoms * lev100 * 1_000_000n) / (100n * priceE6);
}

/** The Max figure in the input's unit: "41.88 SOL" (≤ 4 dp) or "$3,750.00" (2 dp, floored). */
export function maxInUnit(q: bigint, unit: "token" | "usd", priceE6: bigint, baseSymbol: string, lotExp = 0): string {
  if (unit === "token") {
    if (lotExp > 0) q = q * 10n ** BigInt(lotExp);
    const whole = q / 1_000_000n;
    const frac = (q % 1_000_000n).toString().padStart(6, "0").slice(0, 4).replace(/0+$/, "");
    return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} ${baseSymbol}`;
  }
  const cents = (q * priceE6) / 1_000_000n / 10_000n;
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
