/**
 * Create wizard: does the wallet hold the seed the launch takes? (Council r9 creator: seed 3,100 USDC, wallet 400,
 * HOLD TO LAUNCH was on and said nothing.)
 *
 * On devnet the launch itself tops the wallet up first (/api/devnet-pre-fund mints the shortfall; one top-up per wallet
 * per hour). So a short wallet is only a problem when that top-up is known not to be available:
 *   - balance covers the seed            -> HOLD on.
 *   - short, top-up available            -> HOLD on, with a note that the launch adds the missing amount.
 *   - short, top-up can't be confirmed   -> HOLD on, the note says so (a refused top-up still ends the launch before
 *                                           anything is sent: "Nothing was sent").
 *   - short, top-up known unavailable    -> HOLD off, with the shortfall (and the faucet link if /faucet would allow a claim).
 *   - balance unread / being read        -> HOLD off ("checking" / retry), never silently on.
 */

export type SeedCheck =
  | { kind: "ok" }
  | { kind: "checking" }
  | { kind: "unknown" }
  | { kind: "short"; haveAtoms: bigint; needAtoms: bigint };

export function checkSeedBalance(args: {
  /** null = not read yet. */
  balanceAtoms: bigint | null;
  /** The read failed (not "the token account does not exist", which is a real zero). */
  readFailed: boolean;
  needAtoms: bigint;
}): SeedCheck {
  if (args.readFailed) return { kind: "unknown" };
  if (args.balanceAtoms === null) return { kind: "checking" };
  return args.balanceAtoms >= args.needAtoms
    ? { kind: "ok" }
    : { kind: "short", haveAtoms: args.balanceAtoms, needAtoms: args.needAtoms };
}

/** What /api/devnet-pre-fund (GET) said about the launch's top-up. */
export type TopUp =
  | { kind: "checking" }
  | { kind: "unknown" }
  | { kind: "available" }
  | { kind: "unavailable"; nextClaimAt: string | null; faucetOpen: boolean };

export interface SeedVerdict {
  blocked: boolean;
  /** Short reason for the HOLD control while it is off. */
  holdReason?: string;
  notice?: { message: string; faucetHref?: string; retry?: "balance" };
}

const fmt = (atoms: bigint, decimals: number): string =>
  (Number(atoms) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function decideSeed(check: SeedCheck, topUp: TopUp, symbol: string, decimals: number): SeedVerdict {
  switch (check.kind) {
    case "ok":
      return { blocked: false };
    case "checking":
      return { blocked: true, holdReason: "Checking balance", notice: { message: "Checking your wallet balance…" } };
    case "unknown":
      return { blocked: true, holdReason: "Balance unknown", notice: { message: "Could not read your wallet balance. Try again.", retry: "balance" } };
    case "short": {
      const have = fmt(check.haveAtoms, decimals);
      const missing = fmt(check.needAtoms - check.haveAtoms, decimals);
      if (topUp.kind === "available") {
        return { blocked: false, notice: { message: `Your wallet has ${have} ${symbol}. The launch adds the missing ${missing} test ${symbol} first.` } };
      }
      if (topUp.kind === "unknown") {
        return {
          blocked: false,
          notice: { message: `Your wallet has ${have} ${symbol}. The launch tries to add the missing ${missing} test ${symbol} first, but we can't confirm it is available right now.` },
        };
      }
      if (topUp.kind === "checking") {
        return { blocked: true, holdReason: "Checking balance", notice: { message: "Checking whether the launch can add the missing test USDC…".replace("USDC", symbol) } };
      }
      return {
        blocked: true,
        holdReason: `Not enough ${symbol} to seed`,
        notice: {
          message: `You need ${fmt(check.needAtoms, decimals)} ${symbol} to seed this market; your wallet has ${have}.`,
          faucetHref: topUp.faucetOpen ? "/faucet" : undefined,
        },
      };
    }
  }
}
