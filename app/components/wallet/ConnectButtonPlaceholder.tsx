/**
 * What the server renders where a wallet-adapter ConnectButton will be (ConnectButtonAdapterGate,
 * and the header's lazily-loaded button): the disconnected button's box, invisible, so the real
 * button appears in place on hydration with no layout shift.
 *
 * Invisible rather than a visible "Connect Wallet": the real label depends on the browser
 * ("Connect Wallet", or the address once a remembered wallet auto-connects), so any visible
 * guess would visibly change on hydration for someone.
 */
export function ConnectButtonPlaceholder() {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-state="placeholder"
      className="invisible min-h-10 rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20 px-4 text-[13px] font-medium text-[var(--text)]"
    >
      Connect Wallet
    </button>
  );
}
