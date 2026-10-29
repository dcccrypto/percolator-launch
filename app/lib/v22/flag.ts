/**
 * Devnet v2.2 feature flag.
 *
 * The v2.2 programs (wrapper VERSION 19: lot pricing, price bands, holding rent, capacity bonds,
 * Earn-exit floor + inline refresh, rescue, first-loss stake v5) are built but NOT deployed. With the
 * flag unset (the default) the app behaves exactly as it does today: no v2.2 account is decoded, no
 * v2.2 instruction is built, no v2.2 surface renders, no v2.2 error copy is used.
 *
 * Set `NEXT_PUBLIC_V22=1` (cluster-neutral: a mainnet v2.2 build uses the same switch) only on the deployment that points at the v2.2
 * programs. The old name `NEXT_PUBLIC_DEVNET_V22` is still read as a fallback when `NEXT_PUBLIC_V22` is unset or empty (existing
 * deployments, e.g. the Vercel preview, keep working unchanged); when both are set the new one wins. It is meant
 * to be set TOGETHER with `NEXT_PUBLIC_DEVNET_V21=1` (v2.2 builds on the v2.1 growth / lock paths).
 * Build-time and literal (Next inlines `process.env.NEXT_PUBLIC_*` only when read literally).
 */
const on = (v: string | undefined): boolean => v === "1" || v === "true";

let override: boolean | null = null;

/** Test seam: `null` = read the environment. */
export function __setDevnetV22ForTest(v: boolean | null): void {
  override = v;
}

export function isDevnetV22Enabled(): boolean {
  if (override !== null) return override;
  // Both literal reads: Next inlines only `process.env.NEXT_PUBLIC_*` written out in full.
  const neutral = process.env.NEXT_PUBLIC_V22;
  return on(neutral !== undefined && neutral !== "" ? neutral : process.env.NEXT_PUBLIC_DEVNET_V22);
}
