import type { FC } from "react";

/**
 * Shown on a market whose own config lets an account hold more than one asset (`max_portfolio_assets` > 1).
 * The ticket DOES trade such a market, on its first asset only (asset 0, Q-7d; the multi-asset order path,
 * 58bd7bf07), and the position dock on this page shows and closes that position. Only the other assets need the SDK.
 */
export const MULTI_ASSET_NOTICE = {
  label: "Multi-asset market",
  body: "Accounts here can hold more than one asset. This app trades its first asset only: open, view and close that position on this page. The other assets are SDK-only.",
} as const;

export const MultiAssetNotice: FC<{ show: boolean }> = ({ show }) =>
  show ? (
    <div data-testid="multi-asset-notice" className="border-b border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-2 text-center">
      <p className="text-[11px] text-[var(--warning)]">
        <span className="font-medium uppercase tracking-[0.1em]">{MULTI_ASSET_NOTICE.label}</span>
        {" · "}
        {MULTI_ASSET_NOTICE.body}
      </p>
    </div>
  ) : null;
