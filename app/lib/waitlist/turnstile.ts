/**
 * Cloudflare Turnstile server-side verification for the waitlist signup
 * route. Pulled into a tiny module so the verify call is unit-testable
 * with a mocked fetch and so the env-var posture is documented in one
 * place.
 *
 * Posture:
 *   • Production (NODE_ENV === "production"): fail-CLOSED. A missing
 *     TURNSTILE_SECRET in prod is a configuration error and signups
 *     are blocked until it's set. A missing client token is also
 *     blocked — bots that skipped the widget never get past the gate.
 *   • Non-prod: fail-OPEN when TURNSTILE_SECRET is missing, so local
 *     dev / CI / smoke tests don't have to provision a Cloudflare
 *     account to exercise the signup flow.
 *
 * The secret never leaves this module; the wire format to Cloudflare's
 * siteverify endpoint is `application/x-www-form-urlencoded` per the
 * official docs.
 */

export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "verification_failed" | "verification_error" | "not_configured" };

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile widget response token against Cloudflare's
 * siteverify endpoint. Returns `{ ok: true }` on a valid token,
 * `{ ok: false, reason }` otherwise.
 *
 * `clientIp`, when supplied, is forwarded as `remoteip` so Cloudflare
 * can cross-check against the IP the challenge was issued to. Passing
 * the wrong IP (or omitting it) doesn't fail verification — Cloudflare
 * treats it as a soft hint — but binding it tightens the assertion.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  clientIp: string | null,
): Promise<TurnstileVerdict> {
  const secret = process.env.TURNSTILE_SECRET?.trim();

  if (!secret) {
    if (process.env.NODE_ENV !== "production") {
      // Local dev / CI: no secret → no gate. Mirrors the existing
      // email-rate-limit fail-open posture so contributors don't
      // have to provision Cloudflare before they can exercise the
      // signup form.
      return { ok: true };
    }
    // Prod with no secret = misconfiguration. Refuse the signup
    // rather than silently let a bot past — the operator will see
    // the error in logs + Sentry and fix the env var.
    console.error("[waitlist] TURNSTILE_SECRET missing in production");
    return { ok: false, reason: "not_configured" };
  }

  if (!token || typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" };
  }

  const params = new URLSearchParams({ secret, response: token });
  if (clientIp) params.set("remoteip", clientIp);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("[waitlist] turnstile siteverify non-2xx", res.status);
      return { ok: false, reason: "verification_error" };
    }
    const data = (await res.json()) as { success?: unknown };
    if (data?.success === true) return { ok: true };
    return { ok: false, reason: "verification_failed" };
  } catch (err) {
    // Network error / abort / non-JSON. Fail-CLOSED — a Cloudflare
    // outage shouldn't let bots past while honest users are blocked
    // by the widget UI anyway.
    console.error("[waitlist] turnstile siteverify error", err);
    return { ok: false, reason: "verification_error" };
  }
}
