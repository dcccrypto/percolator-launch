/**
 * UX WP-1: ONE resolver from any failure (a thrown Error, a wallet error, or a
 * SimulationRefusal from sendTx's pre-sign gate) to the one line a user sees
 * (ux-audit-2026-09-30.md §5.3). Protocol vocabulary, codes, program ids and logs never
 * appear in `title` / `body` / `action`; they live in `details`, which the StatusLine shows
 * collapsed ("Details") with a Copy button.
 *
 * Earn, creator stake, create, close-market, NFT and faucet messages route through here
 * (earnErrors.ts, useJuniorTranche, parseMarketError, …). Every wrapper code comes from the
 * generated WRAPPER_ERR table (lib/wrapper-errors.ts), never a literal.
 */
import { WRAPPER_ERR } from "../wrapper-errors";
import { TICKET_FUNDS_LINE } from "./copy";
import { resolveDevnetProgramIds } from "../program-ids";

export type StatusVariant = "info" | "wait" | "paused" | "error";

export type MessageSurface =
  | "trade"
  | "close"
  | "withdraw"
  | "earn-deposit"
  | "earn-withdraw"
  | "creator-stake"
  | "create"
  | "close-market"
  | "nft"
  | "faucet"
  | "stake"
  | "any";

export interface MessageContext {
  surface: MessageSurface;
  /** Selected side, for side-specific lines ("New longs paused"). */
  side?: "long" | "short";
  /** Token symbol of the market ("SOL"), never "SOL-PERP". */
  symbol?: string;
  /** The most the user can open / withdraw now, already formatted ("41.88"), for "Use {max}". */
  maxNow?: string;
  /** Leverage cap for new positions on the busy side (78 step-down). */
  maxLeverage?: number;
  /** Earn cooldown remaining, seconds (36). */
  cooldownSecs?: number;
  /** Live market state, when the caller has it. */
  health?: { resolved?: boolean; adlReduceOnly?: boolean; lpDepleted?: boolean; lpIsVault?: boolean; lossStale?: boolean };
  /** Earn: the vault owns its market's liquidity (P3); changes what 21 on a withdrawal means. */
  p3Bound?: boolean;
  /** Wallet display name for the locked-wallet line. */
  walletName?: string;
  /**
   * GH#2953: this call does NOT wait and resend (fund-and-trade signs once). A waitable refusal
   * must then say nothing was sent and to try again, never promise that the order "goes through
   * automatically".
   */
  oneShot?: boolean;
  /**
   * GH#2959: the order opens a NEW position below the market's minimum initial margin
   * (min_nonzero_im_req), already formatted ("$2"). A Custom(49) is then the floor, and
   * "lower the size" is the wrong advice: a smaller order is refused the same way.
   */
  imFloorLabel?: string;
}

export interface UserMessageAction {
  id: "use-max" | "get-funds" | "try-again" | "refresh" | "stop" | "try-size" | "improve-pricing";
  label: string;
}

export interface UserMessageDetails {
  code: number | null;
  /** Wrapper error name, only when the wrapper program raised the code. */
  name: string | null;
  programId: string | null;
  logs: string[];
  raw: string;
}

export interface UserMessage {
  /** Stable handle (`status-line[data-kind]`). */
  kind: string;
  variant: StatusVariant;
  title: string;
  body: string;
  why?: string;
  action?: UserMessageAction;
  /** The app retries on its own (wait loop / repair); the UI shows a calm waiting state. */
  autoRetry?: boolean;
  /** Nothing to show (the user cancelled): the caller just restores the button. */
  quiet?: boolean;
  details: UserMessageDetails;
}

const NAME_BY_CODE: Record<number, string> = Object.fromEntries(Object.entries(WRAPPER_ERR).map(([n, c]) => [c, n]));

/** Matcher (P2 vAMM) error numbers the resolver knows. */
const MATCHER_STALE = new Set([8002, 8003]);
const MATCHER_UNAVAILABLE = 8004;

interface Parsed {
  raw: string;
  code: number | null;
  programId: string | null;
  logs: string[];
}

function asRecord(e: unknown): Record<string, unknown> | null {
  return e && typeof e === "object" ? (e as Record<string, unknown>) : null;
}

/** Pull code / failing program / logs out of any error shape (Phantom hex, Solflare JSON, SimulationRefusal). */
export function parseFailure(err: unknown): Parsed {
  const r = asRecord(err);
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : r && typeof r.message === "string" ? r.message : safeJson(err);
  const logs = Array.isArray(r?.logs) ? (r!.logs as unknown[]).map(String) : [];
  let code: number | null = typeof r?.code === "number" && r?.name === "SimulationRefusal" ? (r.code as number) : null;
  let programId: string | null = typeof r?.programId === "string" ? (r.programId as string) : null;
  if (code === null) {
    const hex = raw.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
    const json = raw.match(/"Custom"\s*:\s*(\d+)/);
    const paren = raw.match(/Custom\((\d+)\)/);
    if (hex) code = parseInt(hex[1], 16);
    else if (json) code = parseInt(json[1], 10);
    else if (paren) code = parseInt(paren[1], 10);
  }
  if (!programId) {
    const all = [raw, ...logs].join("\n");
    const m = all.match(/Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/);
    if (m) programId = m[1];
  }
  return { raw, code, programId, logs };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

type Origin = "wrapper" | "matcher" | "other" | "unknown";
function originOf(programId: string | null): Origin {
  if (!programId) return "unknown";
  const ids = resolveDevnetProgramIds();
  if (programId === ids.wrapper) return "wrapper";
  if (programId === ids.matcher) return "matcher";
  return "other";
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function sides(side: "long" | "short" | undefined): { one: string; many: string; other: string } {
  return side === "short" ? { one: "short", many: "shorts", other: "longs" } : { one: "long", many: "longs", other: "shorts" };
}
function mmss(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** GH#2953: the one-shot form of a waitable line (see MessageContext.oneShot). */
const ONE_SHOT_BODY: Record<string, string> = {
  "engine-catching-up": "The market is catching up with the latest prices. Nothing was sent. Try again in a moment.",
  "price-wait": "Waiting for a fresh price. Nothing was sent. Try again in a few seconds.",
};

/** The one resolver (§5.3). Never throws. */
export function resolveUserMessage(err: unknown, ctx: MessageContext): UserMessage {
  const u = resolveUserMessageInner(err, ctx);
  if (!ctx.oneShot || !u.autoRetry) return u;
  return { ...u, autoRetry: false, body: ONE_SHOT_BODY[u.kind] ?? `${u.body} Nothing was sent. Try again in a moment.` };
}

function resolveUserMessageInner(err: unknown, ctx: MessageContext): UserMessage {
  const p = parseFailure(err);
  const origin = originOf(p.programId);
  // A Custom(n) is decoded by the program that RAISED it (error-codes-4b1a5d30.md: CPI callees —
  // SPL Token, the matcher, stake, NFT — reuse the same numbers). No attribution => no guess.
  const wrapperish = origin === "wrapper";
  const name = p.code !== null && wrapperish ? NAME_BY_CODE[p.code] ?? null : null;
  const details: UserMessageDetails = { code: p.code, name, programId: p.programId, logs: p.logs, raw: p.raw };
  const m = (kind: string, variant: StatusVariant, title: string, body: string, extra: Partial<UserMessage> = {}): UserMessage => ({
    kind,
    variant,
    title,
    body,
    details,
    ...extra,
  });
  const sym = ctx.symbol ?? "";
  const s = sides(ctx.side);
  const useMax = ctx.maxNow ? { action: { id: "use-max" as const, label: `Use ${ctx.maxNow}` } } : {};
  const lower = p.raw.toLowerCase();

  // ── Wallet / network conditions (no program code) ──────────────────────────
  if (/user rejected|rejected the request|user declined|transaction rejected|request rejected|\b4001\b/i.test(p.raw)) {
    return m("cancelled", "info", "Cancelled", "Cancelled.", { quiet: true });
  }
  // UX WP-3: the user pressed Stop on a long wait (lib/tx.ts WaitStoppedError): nothing was sent.
  if ((err as { name?: string } | null)?.name === "WaitStoppedError") {
    return m("stopped", "info", "Stopped", "Stopped. Nothing was sent.", { quiet: true });
  }
  if (/has not been authori[sz]ed by the user|wallet is locked|locked wallet|walletnotconnected|wallet not connected|please unlock/i.test(p.raw)) {
    return m("wallet-locked", "error", "Wallet locked", `Unlock ${ctx.walletName ?? "your wallet"} and try again.`);
  }
  if (/insufficient lamports|insufficient sol|not enough sol|attempt to debit an account but found no record of a prior credit/i.test(p.raw)) {
    return m("insufficient-sol", "error", "Need network fees", "You need a little SOL for network fees.", {
      action: { id: "get-funds", label: "Get test funds" },
    });
  }
  if (/notenoughaccountkeys|insufficient account keys/i.test(p.raw)) {
    return m("out-of-date", "error", "Page out of date", "This page is out of date. Refresh to continue. Nothing was sent.", {
      action: { id: "refresh", label: "Refresh" },
    });
  }
  if (/blockhash not found|block height exceeded|blockhashnotfound|transactionexpiredblockheightexceeded/i.test(p.raw)) {
    return m("network-slow", "error", "Network was slow", "The network was slow. Nothing was sent.", {
      action: { id: "try-again", label: "Try again" },
    });
  }
  if (/confirmation timeout|was not confirmed in|timed out waiting for confirmation/i.test(lower)) {
    return m("still-confirming", "wait", "Still confirming", "Still confirming. We'll update this when it lands.", { autoRetry: true });
  }
  if (/\b429\b|too many requests|-32005|-32603|failed to fetch|network request failed|econnreset/i.test(p.raw) && p.code === null) {
    return m("rpc-unreachable", "error", "Couldn't reach Solana", "Couldn't reach Solana. Nothing was sent.", {
      action: { id: "try-again", label: "Try again" },
    });
  }
  if (/slippage|price moved past|exceeds? (your )?limit price/i.test(p.raw) && !/live mark price unavailable/i.test(p.raw) && p.code === null) {
    return m("price-moved", "error", "Price moved", "The price moved while you were confirming. Review and confirm again.");
  }

  // ── The app's own pre-sign refusals (thrown before the wallet opens) ─────────
  // These used to fall through to "Something went wrong", hiding a cause the app knew.
  if (p.code === null) {
    if (/no lp portfolio with an active matcher config/i.test(p.raw)) {
      return m("market-not-ready", "paused", "Market not ready", "This market isn't taking trades yet. Nothing was sent.", {
        action: { id: "refresh", label: "Refresh" },
      });
    }
    if (/couldn't reach solana to check this order/i.test(p.raw)) {
      return m("rpc-unreachable", "error", "Couldn't reach Solana", "Couldn't reach Solana to check this order. Nothing was sent.", {
        action: { id: "try-again", label: "Try again" },
      });
    }
    if (/no portfolio account found for your wallet/i.test(p.raw)) {
      return m("no-account", "info", "Add funds first", "Deposit once to open an account, then trade. Nothing was sent.");
    }
    if (/failed to scan lp portfolio/i.test(p.raw)) {
      return m("rpc-unreachable", "error", "Couldn't reach Solana", "Couldn't read the market from Solana. Nothing was sent.", {
        action: { id: "try-again", label: "Try again" },
      });
    }
    if (/account not found: [1-9a-hj-np-z]{32,44}/i.test(p.raw)) {
      return m("out-of-date", "error", "Page out of date", "Part of this market couldn't be read. Refresh to continue. Nothing was sent.", {
        action: { id: "refresh", label: "Refresh" },
      });
    }
    if (/^trade already in progress$/i.test(p.raw.trim())) {
      return m("in-progress", "info", "Already sending", "Your last order is still being sent. Nothing new was sent.");
    }
    if (/not the recognized percolator matcher|not owned by a recognized percolator program/i.test(p.raw)) {
      return m("unsupported-market", "error", "Not supported here", "This market isn't supported by this app. Nothing was sent.");
    }
    if (/does not support signalltransactions or signtransaction/i.test(p.raw)) {
      return m("wallet-unsupported", "error", "Wallet can't sign", "This wallet can't sign this order. Try another wallet. Nothing was sent.");
    }
    if (/market not loaded|wallet not connected or market not loaded/i.test(p.raw)) {
      return m("market-loading", "info", "Still loading", "The market is still loading. Try again in a moment. Nothing was sent.", {
        action: { id: "try-again", label: "Try again" },
      });
    }
    if (/deposit amount exceeds your wallet balance/i.test(p.raw)) {
      return m("amount-too-large", "error", "More than your balance", "That's more than your wallet holds. Lower the size or leverage, or get test funds.", {
        action: { id: "get-funds", label: "Get test funds" },
      });
    }
    if (/earn payout above what the vault can pay now/i.test(p.raw)) {
      return m("earn-max-now", "paused", "Partly available now", "The full amount can't be paid in one go right now. Nothing moved. Withdraw the max available now; the rest stays in the vault.", {
        action: { id: "use-max", label: "Use max available" },
      });
    }
    if (/live mark price unavailable/i.test(p.raw)) {
      return m("price-wait", "wait", "Waiting for price", "Waiting for a live price. Try again in a few seconds. Nothing was sent.");
    }
  }

  // ── Matcher (P2) ───────────────────────────────────────────────────────────
  if (p.code !== null && origin === "matcher" && MATCHER_STALE.has(p.code)) {
    return m("price-wait", "wait", "Waiting for price", "Updating to the latest price, usually a few seconds.", { autoRetry: true });
  }
  if (p.code === MATCHER_UNAVAILABLE && origin === "matcher") {
    return m("market-unavailable", "paused", "Temporarily unavailable", "This market is temporarily unavailable. We've been notified.");
  }

  // ── Wrapper codes ───────────────────────────────────────────────────────────
  if (p.code !== null && wrapperish) {
    const W = WRAPPER_ERR;
    switch (p.code) {
      case W.EngineStale:
      case W.EngineBStale:
        return ctx.surface === "trade"
          // Only the trade ticket waits through this and resends (sendTxWaiting); nothing reads
          // autoRetry elsewhere, and Earn, close, deposit and withdraw do not resend.
          ? m("engine-catching-up", "wait", "Catching up", "The market is catching up with the latest prices. Your trade goes through automatically when it's ready.", { autoRetry: true })
          : m("engine-catching-up", "wait", "Catching up", "The market is catching up with the latest prices. Try again in a moment.");
      case W.OracleStale:
      case W.OracleInvalid:
        return m("price-wait", "wait", "Waiting for price", "Waiting for a fresh price. This usually takes a few seconds.", { autoRetry: true });
      case W.EngineLockActive: {
        const h = ctx.health ?? {};
        if (h.resolved) return m("market-settled", "info", "Market settled", "Close any position and withdraw. There's nothing else to do.");
        if (ctx.surface === "earn-withdraw" && ctx.p3Bound)
          return m("earn-payout-wait", "wait", "Payout waiting", "This withdrawal can't be paid out this moment. Nothing moved; your withdrawal stays ready to collect. Try again in a moment.");
        if (ctx.surface === "earn-withdraw")
          return m("earn-in-use", "paused", "Partly in use", "Part of this vault's money is in use by open trades right now. It becomes available as those trades close; your withdrawal stays ready to collect.");
        if (ctx.surface === "earn-deposit")
          return m("earn-deposit-wait", "wait", "Vault updating", "This vault is updating after a market move. Nothing was deposited. Try again in a moment.");
        if (h.adlReduceOnly && ctx.surface === "trade")
          return m("adl-reduce-only", "paused", "Close-only for now", "Closing works normally. New positions reopen once the positions on one side have closed, which depends on those traders and can take a while.");
        if (h.lpDepleted && ctx.surface === "trade")
          return m("lp-depleted", "paused", "New positions paused", `${TICKET_FUNDS_LINE(h.lpIsVault === true)} Closing works normally.`);
        if (h.lossStale) return m("price-wait", "wait", "Waiting for price", "Updating to the latest price, usually a few seconds.", { autoRetry: true });
        return ctx.surface === "trade"
          // Only the trade ticket waits through this and resends (sendTxWaiting); nothing reads
          // autoRetry elsewhere, and Earn, close, deposit and withdraw do not resend.
          ? m("engine-catching-up", "wait", "Catching up", "The market is catching up with the latest prices. Your trade goes through automatically when it's ready.", { autoRetry: true })
          : m("engine-catching-up", "wait", "Catching up", "The market is catching up with the latest prices. Try again in a moment.");
      }
      case W.EngineInsufficientInitialMargin:
        if (ctx.imFloorLabel) {
          return m("insufficient-margin", "error", "Not enough margin", `New positions on this market need at least ${ctx.imFloorLabel} of margin.`);
        }
        return m("insufficient-margin", "error", "Not enough margin", "Add collateral or lower the size or leverage.");
      case W.ExecPriceOutsideOracleBand:
        return m("price-moved", "error", "Price moved", ctx.maxNow ? `The price moved too far for this size. Most you can open now: ${ctx.maxNow}${sym ? ` ${sym}` : ""}.` : "The price moved too far for this size. Try a smaller size.", useMax);
      case W.SameOwnerTrade:
        return m("same-owner", "paused", "Close-only for this wallet", "You created this market, so this wallet can only close positions here.");
      case W.LpExposureCapExceeded:
      case W.ProtocolSideOiCapExceeded:
      case W.VaultLpExposureCapExceeded:
        return m("too-large", "error", "Too large right now", ctx.maxNow ? `Most you can open now: ${ctx.maxNow}${sym ? ` ${sym}` : ""}.` : "This size is too large right now. Try a smaller size.", useMax);
      case W.LpFloorHalt:
        return ctx.surface === "close"
          ? m("close-paused", "paused", "Closing paused briefly", ctx.maxNow ? `This side reopens as other positions close. You can close ${ctx.maxNow} now.` : "This side reopens as other positions close.", useMax)
          : m("side-paused", "paused", `New ${s.many} paused`, `The market has no room for more ${s.one} exposure. ${cap(s.other)} and closes work.`);
      case W.CloseSlabFeesOutstanding:
        return m("fees-collecting", "info", "One more step", "The market's last fees are being collected. Close again in a minute.");
      case W.VaultLpAlreadyBound:
      case W.VaultLpNotBound:
      case W.VaultLpBoundCannotClose:
      case W.VaultLpMatcherNotApproved:
      case W.VaultLpUseSettleResolved:
      case W.VaultLpMultiAssetMarket:
        return m("setup-not-allowed", "error", "Not available here", "This market's setup doesn't allow that.");
      case W.VaultLpSeniorImpaired:
        return m("earn-deposits-paused", "paused", "Deposits paused", "This vault is covering a loss. Withdrawals still work.");
      case W.VaultLpJuniorWithdrawRefused:
        return m("stake-locked", "paused", "Not withdrawable yet", "Locked while traders have open positions on your market, or it would drop below the minimum you must keep.");
      case W.VaultLpRecallRefused:
        return m("try-later", "info", "Not right now", "This can't go through right now. Nothing was sent.");
      case W.VaultLpExclusiveCounterparty:
        return m("route-unavailable", "info", "Route unavailable", "This trade route isn't available on this market.");
      case W.VaultLpLeverageStepDown:
        return m("lower-leverage", "info", "Lower leverage", ctx.maxLeverage ? `Up to ${ctx.maxLeverage}× for new ${s.many} right now.` : `Leverage for new ${s.many} is lower right now.`);
      case W.VaultLpReleaseRefused:
        return m("stake-nothing", "info", "Nothing to withdraw yet", "Nothing to withdraw above what Earn depositors are owed yet.");
      case W.VaultLpHarvestPending:
        return m("earn-fees-collecting", "wait", "Collecting fees", "Collecting the vault's latest fees. Try again in a moment.");
      case W.VaultLpValuationStale:
        return m("earn-value-updating", "wait", "Updating value", "Updating the vault's value. Try again in a moment.");
      case W.VaultLpSeniorDrawRequired:
        return m("earn-booking-move", "wait", "Booking a market move", "The vault is booking a recent market move. Try again in a moment.");
      case W.VaultLpRedeemNeedsRecall:
        return m("earn-in-use", "paused", "Partly in use", ctx.maxNow ? `Part of this vault's money is in use by open trades right now. You can withdraw up to ${ctx.maxNow} now, or the rest once those trades close.` : "Part of this vault's money is in use by open trades right now. The rest is available once those trades close.", ctx.maxNow ? { action: { id: "use-max", label: `Withdraw ${ctx.maxNow}` } } : {});
      case W.EngineCounterUnderflow:
        // Unbound Earn vault, redemption split across pots. The payout is PRICED on
        // the vault's combined backing across BOTH of the market's sides (domains)
        // but is physically DRAWN from one side's pot, so a redemption whose share
        // of combined principal exceeds that one pot is refused in
        // percolator-prog handle_execute_redemption with the engine's generic
        // `EngineCounterUnderflow` (the `principal_portion > ledger.total_principal_atoms`
        // gate, v16_program.rs). A BOUND vault names this VaultLpRedeemNeedsRecall and
        // auto-repairs (senior-draw-repair.ts); an UNBOUND vault has no recall path, so
        // without this case it falls through to "Something went wrong" — alarming on a
        // money path where nothing was actually sent. Scope STRICTLY to the withdraw
        // surface: everywhere else Custom(25) is a genuine internal-accounting fault and
        // must stay generic. Funds are safe either way (a failed tx moves nothing).
        if (ctx.surface === "earn-withdraw")
          return m("earn-payout-split", "paused", "Can't pay out in full", "Part of this vault's backing is on the market's other side right now. Nothing was sent and your withdrawal stays ready to collect.");
        // Unbound Earn vault DEPOSIT: one backing pot has taken more trading loss than its
        // principal, and the program refuses to price new shares (lp_vault_domain_nav_atoms
        // fails closed, 2026-10-02 live on OTC). It clears by itself as the market moves.
        // Nothing was sent.
        if (ctx.surface === "earn-deposit")
          return m("earn-deposit-settling", "wait", "Vault is settling", "This vault can't take new deposits for a moment while its recent trades settle. Nothing was sent. Please try again shortly.");
        break;
      case W.VaultLpBindRequiresFlatAsset:
        return m("setup-not-allowed", "error", "Not available here", "This market already has open positions, so the Earn vault can't take over its liquidity. Create a new market to use it.");
      case W.VaultLpPausedForSeniorDraw:
        return m("paused-earn-covers-loss", "paused", "Paused briefly", "Paused while Earn covers a loss. It reopens automatically, usually within a minute.");
      case W.LpVaultCooldownActive:
        return m("earn-cooldown", "wait", "Almost ready", ctx.cooldownSecs !== undefined ? `Ready in ${mmss(ctx.cooldownSecs)}.` : "Ready in a moment.", { autoRetry: true });
      case W.LpVaultOiReservationViolated:
        return m("earn-partial-now", "paused", "Partly available", ctx.maxNow ? `You can withdraw up to ${ctx.maxNow} now; the rest as open trades close.` : "Part of this is available now; the rest as open trades close.", ctx.maxNow ? { action: { id: "use-max", label: `Withdraw ${ctx.maxNow}` } } : {});
      case W.LpVaultZeroAmount:
        return m("amount-zero", "error", "Enter an amount", "Enter an amount greater than zero.");
      case W.LpVaultInsufficientShares:
        return m("amount-too-large", "error", "More than your balance", "That's more than your Earn balance.");
      case W.LpVaultZeroSharesMinted:
      case W.LpVaultDepositBelowMinimumLiquidity:
        return m("amount-too-small", "error", "Amount too small", "This deposit is too small. Deposit a larger amount.");
      case W.CreatorFeeOverClaim:
        return m("claim-too-much", "error", "Too much", "That's more than the fees available to claim right now.");
      case W.Unauthorized:
        return m("wrong-wallet", "error", "Wrong wallet", "This wallet can't do that on this market. Switch to the wallet that can.");
      default:
        break;
    }
  }

  return m("unmapped", "error", "Something went wrong", "Something went wrong and nothing was sent.");
}

/**
 * The resolver's line, or — when it has no mapping — `fallback(raw)` for program-specific
 * tables the resolver does not own (the NFT program's codes, the stake program's). The raw
 * message stays reachable through `resolveUserMessage(...).details`.
 */
export function plainMessage(err: unknown, ctx: MessageContext, fallback?: (raw: string) => string): string {
  const u = resolveUserMessage(err, ctx);
  if (u.kind !== "unmapped" || !fallback) return u.body;
  return fallback(u.details.raw);
}

const RAW_CHAIN_TEXT = /custom program error|InstructionError|Program [1-9A-HJ-NP-Za-km-z]{32,44}|Transaction (simulation )?failed|\b0x[0-9a-f]+\b|Custom\(\d+\)|"Custom"/i;

/**
 * Fallback for app surfaces whose own thrown messages are already plain ("Enter an amount
 * greater than zero."): keep those verbatim, but never pass raw chain text to the user.
 */
export function keepAppMessage(raw: string): string {
  return raw && !RAW_CHAIN_TEXT.test(raw) ? raw : "Something went wrong and nothing was sent.";
}

