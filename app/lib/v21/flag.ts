/**
 * Devnet v2.1 feature flag (growth-v19 dynamic leverage, P2b lock exits, P2b Earn allocation).
 *
 * Those programs are approved but NOT deployed. Everything the app does for them is either
 * (a) feature-detected from on-chain bytes that read all-zero on today's programs, or
 * (b) gated here. With the flag unset (the default) the app behaves exactly as it does against
 * the live wrapper: the wizard offers no growth block, the ticket reads no growth record, no
 * tag 103 / 104 is ever built.
 *
 * Set `NEXT_PUBLIC_DEVNET_V21=1` only on the deployment that points at the v2.1 programs.
 * Build-time and literal (Next inlines `process.env.NEXT_PUBLIC_*` only when read literally).
 */
const on = (v: string | undefined): boolean => v === "1" || v === "true";

let override: boolean | null = null;

/** Test seam: `null` = read the environment. */
export function __setDevnetV21ForTest(v: boolean | null): void {
  override = v;
}

export function isDevnetV21Enabled(): boolean {
  if (override !== null) return override;
  return on(process.env.NEXT_PUBLIC_DEVNET_V21);
}
