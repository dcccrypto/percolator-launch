/**
 * "How Earn risk works": the one place the backtest figures appear (D3, v22 deep memo 2026-10-29). Never quoted in the deposit flow,
 * never as a promise: it is a backtest on past prices, not a floor. Source: sims/v22lev/out/implcheck/lpstop.md, 2,245 seven-day
 * windows of real price history, the stop as built (lambda <= 1, trim).
 */
import { V22_COPY } from "@/lib/v22/copy";

export const EARN_RISK_PAGE = {
  title: "How Earn risk works",
  mechanism: [
    "Earn deposits back a market's liquidity. When traders win, the money to pay them comes out of that liquidity, so the value of your deposit goes down. You can lose most of your deposit.",
    "The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage.",
  ],
  stopTitle: "The liquidity loss stop",
  stop: V22_COPY.lpStop.notice,
  stopMore:
    "The stop limits how much a bad week can take. It does not remove the risk: it works on a schedule of rounds, prices can move faster, and the result in a worse week than any we tested can be worse than the figures below.",
  backtestTitle: "Backtest on past prices",
  backtestLabel: "Backtest on past prices, not a floor or a promise.",
  backtest: [
    "We replayed 2,245 seven-day windows of real price history with the stop as built.",
    "When traders were net long, in the worst of those weeks the liquidity kept about 30% of its value at a funding rate of 0.001, and about 27% at a funding rate of 0.",
    "When traders were net short, it kept 44% to 57%.",
  ],
  backtestEnd: "These are results from one model on past prices. They say nothing about what will happen to your deposit.",
  back: "Back to Earn",
} as const;
