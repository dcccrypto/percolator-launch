/**
 * The disconnected wallet-adapter "Connect Wallet" button as plain markup: what the server renders
 * where a ConnectButton will be (ConnectButtonAdapterGate, and the header's lazily-loaded button),
 * so the page paints its connect control from the HTML instead of after the wallet chunk.
 * Same classes as the real disconnected button; it is replaced by the real one on hydration.
 * A returning visitor whose wallet will auto-connect (layout.tsx's pre-paint script sets
 * html[data-wallet-remembered] from wallet-adapter's `walletName` key) gets an invisible
 * placeholder instead, as before, rather than a "Connect Wallet" that turns into their address.
 */
export function ConnectButtonPlaceholder() {
  return (
    <button
      type="button"
      data-testid="wallet-connect"
      data-state="disconnected"
      className="wallet-connect-placeholder min-h-10 rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20 px-4 text-[13px] font-medium text-[var(--text)] transition-all hover:bg-[var(--accent)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      Connect Wallet
    </button>
  );
}
