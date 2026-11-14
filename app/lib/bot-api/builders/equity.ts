/**
 * The ONE equity the API uses for leverage, in collateral atoms: capital + min(0, pnl) + min(0, fee credits), where pnl is
 * the account's PnL at the engine's effective price: the stored pnl plus the K/F the open legs have accrued since their
 * snapshots (reads/pending-pnl.ts; a flat account holds its stored pnl). Not counted: holding rent and the social-loss share. Gains are ignored on purpose: unrealized profit is not margin until it is
 * settled and released, so a cap or a leverage figure must not lean on it.
 *
 *   leverage = |position notional at the effective price| / this equity
 *
 * Used by the order caps (builders/caps.ts) and by GET /v1/account positions[].leverage (reads/account.ts), so a bot that
 * stays under the cap by reading its account leverage is not refused.
 */
export function conservativeEquity(capital: bigint, valuePnl: bigint, feeCredits: bigint): bigint {
  const negPnl = valuePnl < 0n ? valuePnl : 0n;
  const negFee = feeCredits < 0n ? feeCredits : 0n;
  return capital + negPnl + negFee;
}
