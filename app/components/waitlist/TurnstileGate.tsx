"use client";

/**
 * Cloudflare Turnstile widget for the waitlist signup form.
 *
 * Renders the Turnstile challenge and yields a single-use token via the
 * `onToken` callback. The token gets bundled into the signup POST body
 * and the server verifies it via `verifyTurnstile` in
 * `lib/waitlist/turnstile.ts` — so this component is purely about
 * "produce a token"; the trust boundary is server-side.
 *
 * Posture:
 *   • Reads the public site key from NEXT_PUBLIC_TURNSTILE_SITE_KEY.
 *   • When the env var is missing (local dev / no Cloudflare account)
 *     the component immediately calls `onToken(null)` and renders
 *     nothing. The server-side verifier matches this with a fail-OPEN
 *     posture outside production.
 *   • When the env var is missing IN production (operator forgot to
 *     set it) we render an inline error and never call `onToken` —
 *     the parent's submit buttons stay disabled.
 *   • A widget-side `expired-callback` / `error-callback` clears the
 *     token by calling `onToken(null)`. The parent re-disables its
 *     submit while the user re-solves.
 *
 * Cloudflare's `api.js` is loaded lazily on mount and cached for the
 * lifetime of the page — multiple instances of this component share
 * the single script tag. The widget's render lifecycle is bound to
 * the React component lifecycle so HMR / route changes clean up the
 * iframe instead of leaking it.
 */

import { useEffect, useRef } from "react";

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Cloudflare's official @cloudflare/turnstile-types declaration (pulled
// in transitively by some Next.js / Cloudflare package) ambient-declares
// `window.turnstile`. Re-declaring it here would conflict, so we use a
// minimal local shape and a runtime cast where we touch the global. The
// fields we use are stable per Cloudflare's published API:
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
interface TurnstileApi {
  render: (
    target: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      appearance?: "always" | "execute" | "interaction-only";
      size?: "normal" | "compact" | "flexible";
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

function getTurnstile(): TurnstileApi | null {
  if (typeof window === "undefined") return null;
  const t = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  return t ?? null;
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (getTurnstile()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="https://challenges.cloudflare.com/turnstile"]`,
    );
    if (existing) {
      // Another mount already injected the script; wait for it to
      // attach the global. Cloudflare's api.js sets window.turnstile
      // synchronously on load.
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("turnstile script failed to load")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(new Error("turnstile script failed to load")),
    );
    document.head.appendChild(script);
  });
  scriptPromise = promise;

  // Reset the cached promise on rejection so a subsequent mount (e.g.,
  // after the user re-solves a captcha-rejected POST and the widget
  // remounts via turnstileNonce, or after a network outage clears)
  // retries the script load from scratch. Without this reset the
  // cached rejected promise routes every later mount straight to the
  // catch arm and the widget never recovers until a full page reload.
  //
  // This attaches a SEPARATE catch chain that doesn't interfere with
  // the caller's promise handlers — each .then/.catch chain on a
  // promise sees the original rejection independently.
  promise.catch(() => {
    if (scriptPromise === promise) scriptPromise = null;
  });

  return promise;
}

export function TurnstileGate({
  onToken,
  className,
}: {
  onToken: (token: string | null) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Hold the latest callback in a ref so the effect doesn't have to
  // depend on it (would re-render the widget on every parent state
  // change, which is both wasteful and visible — the widget shows a
  // brief reload flicker).
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!sitekey) {
      // No site key configured — the server-side verifier is in
      // fail-OPEN mode (non-prod) or will reject every signup
      // (prod). Signal "no token" to the parent so its disabled-
      // submit state reflects the missing widget.
      onTokenRef.current(null);
      return;
    }
    if (typeof window === "undefined") return;

    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;
        const turnstile = getTurnstile();
        if (!containerRef.current || !turnstile) return;
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
          theme: "dark",
          // Invisible for legitimate users: the widget runs in the background
          // and only surfaces an interactive challenge if Cloudflare flags the
          // visitor as suspicious. Keeps 100% of the server-side siteverify
          // protection with zero UX cost on the happy path (Privy already
          // shows its own challenge; we don't want a second visible one).
          // NOTE: pair with a "Managed" widget type on the Cloudflare side so
          // the invisible/interaction-only behaviour is honoured.
          appearance: "interaction-only",
          size: "flexible",
        });
      })
      .catch((err) => {
        // Script load failed (CSP block, network, ad-block). Render
        // an inline error in the placeholder via the parent's empty-
        // token state; nothing else we can do here.
        console.warn("[waitlist] turnstile load failed", err);
        onTokenRef.current(null);
      });

    return () => {
      cancelled = true;
      const turnstile = getTurnstile();
      if (widgetIdRef.current && turnstile) {
        try {
          turnstile.remove(widgetIdRef.current);
        } catch {
          // Widget already torn down or invalid id — non-fatal.
        }
        widgetIdRef.current = null;
      }
    };
  }, [sitekey]);

  if (!sitekey) {
    if (process.env.NODE_ENV === "production") {
      return (
        <div
          className={className}
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: "11px",
            color: "var(--short)",
            border: "1px solid rgba(238,80,80,0.3)",
            padding: "8px 10px",
            borderRadius: "4px",
            background: "rgba(238,80,80,0.06)",
          }}
        >
          captcha unavailable — operator must set NEXT_PUBLIC_TURNSTILE_SITE_KEY
        </div>
      );
    }
    // Local dev with no key — render nothing. Server-side fail-OPEN
    // accepts the signup without a token.
    return null;
  }

  return <div ref={containerRef} className={className} />;
}
