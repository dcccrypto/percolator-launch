"use client";

import { FC, useEffect, useState, type ReactNode } from "react";
import { useLinkAccount, usePrivy, useUnlinkOAuth } from "@privy-io/react-auth";
import { Modal } from "@/components/ui/Modal";

const WAITLIST_URL = "https://percolator.trade/waitlist";
const REFERRAL_LINK_BASE = "https://percolator.trade/r/";
/** Chart drawings, indicators, overlays, style and the TradingView layouts (hooks/useChart*, lib/tv). */
const CHART_KEY_PREFIXES = ["perc:chart:", "perc:tv:"];

/** Removes every chart-settings key from `storage`. Returns how many were removed. Never throws. */
export function clearChartSettings(storage: Storage): number {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && CHART_KEY_PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
    }
    keys.forEach((k) => storage.removeItem(k));
    return keys.length;
  } catch {
    return 0;
  }
}

interface AccountSecurityModalProps {
  onClose: () => void;
  /** The wallet the header shows. */
  walletAddress: string | null;
}

export const AccountSecurityModal: FC<AccountSecurityModalProps> = ({ onClose, walletAddress }) => {
  const { user } = usePrivy();
  const { unlink } = useUnlinkOAuth();
  const [xError, setXError] = useState<string | null>(null);
  const [xBusy, setXBusy] = useState(false);
  // linkTwitter redirects to X and back (a page load), so this only hears failures before the
  // redirect, e.g. X not enabled for this Privy app. The OAuth result itself is Privy's to show.
  const { linkTwitter } = useLinkAccount({
    onError: (code) => {
      if (code !== "exited_link_flow") setXError("Couldn't connect X. Try again later.");
    },
  });

  // undefined = loading, null = not available here.
  const [refCode, setRefCode] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/playground/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ref?: unknown } | null) => {
        if (!cancelled) setRefCode(typeof j?.ref === "string" && j.ref ? j.ref : null);
      })
      .catch(() => {
        if (!cancelled) setRefCode(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const copy = (what: "code" | "link", text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => {});
  };

  const [confirmReset, setConfirmReset] = useState(false);

  const twitter = user?.twitter ?? null;
  const signedIn: { label: string; value: string }[] = [
    ...(user?.email?.address ? [{ label: "Email", value: user.email.address }] : []),
    ...(user?.google?.email ? [{ label: "Google", value: user.google.email }] : []),
    ...(walletAddress ? [{ label: "Wallet", value: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}` }] : []),
  ];

  const disconnectX = async () => {
    if (!twitter) return;
    setXError(null);
    setXBusy(true);
    try {
      await unlink({ provider: "twitter", subject: twitter.subject });
    } catch {
      setXError("Couldn't disconnect X. Try again later.");
    } finally {
      setXBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy="account-security-title"
      panelClassName="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-sm border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)]/50 px-4 py-3">
        <h2 id="account-security-title" className="text-[15px] font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
          Account and Security
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="space-y-2 p-4">
        <Row title="Signed in as" testId="account-signed-in">
          <dl className="mt-1 space-y-0.5 text-[12px]">
            {signedIn.map((s) => (
              <div key={s.label} className="flex gap-2">
                <dt className="w-14 shrink-0 text-[var(--text-muted)]">{s.label}</dt>
                <dd className="min-w-0 truncate font-mono text-[var(--text-secondary)]">{s.value}</dd>
              </div>
            ))}
          </dl>
        </Row>

        <Row title="Referral code" testId="account-referral">
          {refCode === undefined ? (
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">Loading…</p>
          ) : refCode ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[14px] text-[var(--text)]">{refCode}</span>
              <SmallButton onClick={() => copy("code", refCode)}>{copied === "code" ? "Copied" : "Copy code"}</SmallButton>
              <SmallButton onClick={() => copy("link", `${REFERRAL_LINK_BASE}${refCode}`)}>{copied === "link" ? "Copied" : "Copy link"}</SmallButton>
            </div>
          ) : (
            <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
              Your referral code is on your{" "}
              <a href={WAITLIST_URL} target="_blank" rel="noreferrer" className="text-[var(--accent-text)] hover:text-[var(--accent)]">
                waitlist page
              </a>
              .
            </p>
          )}
        </Row>

        <Row
          title={
            <>
              <XLogo /> account
            </>
          }
          testId="account-x"
          action={
            twitter ? (
              <SmallButton onClick={() => void disconnectX()} disabled={xBusy}>Disconnect</SmallButton>
            ) : (
              <SmallButton
                onClick={() => {
                  setXError(null);
                  linkTwitter();
                }}
              >
                Connect X
              </SmallButton>
            )
          }
        >
          <p className={`mt-1 text-[12px] ${twitter ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"}`}>
            {twitter ? (twitter.username ? `@${twitter.username}` : "Connected") : "Not connected"}
          </p>
          {xError && (
            <p role="alert" className="mt-1 text-[12px] text-[var(--short)]">
              {xError}
            </p>
          )}
        </Row>

        <Row
          title="Reset chart settings"
          testId="account-chart-reset"
          description={
            confirmReset
              ? "Delete your chart drawings, indicators and layouts on this device? The page reloads."
              : "Clears chart drawings, indicators and layouts on this device."
          }
          action={
            confirmReset ? (
              <div className="flex gap-2">
                <SmallButton onClick={() => setConfirmReset(false)}>Cancel</SmallButton>
                <SmallButton
                  danger
                  onClick={() => {
                    // An open chart writes back only an edit still in flight (drawings: 250 ms
                    // debounce flushed on pagehide; TradingView: its auto-save), and there is none
                    // by the time this is clicked from the menu.
                    clearChartSettings(window.localStorage);
                    window.location.reload();
                  }}
                >
                  Reset
                </SmallButton>
              </div>
            ) : (
              <SmallButton danger onClick={() => setConfirmReset(true)}>Reset</SmallButton>
            )
          }
        />
      </div>
    </Modal>
  );
};

/** The X logo mark. */
const XLogo: FC = () => (
  <svg role="img" aria-label="X" viewBox="0 0 24 24" className="inline-block h-3 w-3 -translate-y-px fill-current">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const Row: FC<{ title: ReactNode; testId: string; description?: string; action?: ReactNode; children?: ReactNode }> = ({
  title,
  testId,
  description,
  action,
  children,
}) => (
  <section data-testid={testId} className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-2.5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-[var(--text)]">{title}</h3>
        {description && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
    {children}
  </section>
);

const SmallButton: FC<{ onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }> = ({
  onClick,
  disabled,
  danger,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={[
      "rounded-sm border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
      danger
        ? "border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/[0.08]"
        : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] hover:text-[var(--text)]",
    ].join(" ")}
  >
    {children}
  </button>
);
