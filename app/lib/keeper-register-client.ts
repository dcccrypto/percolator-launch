/**
 * UX WP-7 (audit §3.15, WZ-2): registering the new market's live price, automatically, with NO
 * signature. The proof is the market-creation transaction itself (lib/keeper-register-memo.ts), so
 * the app can retry in the background for as long as the page is open:
 *   attempt now, then after 5, 10, 20, 40, 60, 60 s, then every 2 min.
 * Status copy: "Connecting the live price… usually under a minute."; after 5 min: "Your market is
 * created but its live price isn't connected yet. We'll keep trying; you can close this page."
 * SECURITY REVIEW REQUIRED before merge (replaces the signed-message registration).
 */
import type { MarketRegistrationPayload } from "@/lib/market-registration-auth";
import { PRICE_SOURCE_LOCKED } from "@/lib/market-registration";
import { UNSUPPORTED_POOL_COPY } from "@/lib/wizard-copy";
import { GLOBAL_CAP_COPY, PER_CREATOR_CAP_COPY } from "@/lib/keeper-enrollment-guard";

export const KEEPER_REGISTER_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000] as const;
export const KEEPER_REGISTER_STEADY_MS = 120_000;
/**
 * A 409 means "not visible yet" (the creation tx or the finished market has not reached the
 * server's RPC node). It clears in seconds, so it is retried on a short ladder instead of the 5 s
 * first step: 1.5, 2.5, 4, 6, 10, 15, 20, 30, 45 s (about 2.2 minutes in all), after which the
 * ordinary schedule above takes over. Only a 409 uses it; 5xx / 429 / network keep the schedule
 * above, so a struggling server or a full ceiling is not hammered.
 */
export const KEEPER_REGISTER_NOT_YET_BACKOFF_MS = [1_500, 2_500, 4_000, 6_000, 10_000, 15_000, 20_000, 30_000, 45_000] as const;
export const KEEPER_REGISTER_SLOW_AFTER_MS = 5 * 60_000;
/**
 * A server error (5xx) is retried with the normal backoff this many times, then surfaced as a
 * "failed" phase with a calm line and a Retry button. Without a cap a persistent 5xx (2026-10-01:
 * every fractional-leverage registration 500'd) kept the launch screen "connecting" forever.
 * 409 / 429 / network errors keep the open-ended schedule (they clear by themselves).
 */
export const KEEPER_REGISTER_MAX_SERVER_RETRIES = 3;

export const KEEPER_REGISTER_COPY = {
  connecting: "Connecting the live price… usually under a minute.",
  slow: "Your market is created but its live price isn't connected yet. We'll keep trying; you can close this page.",
  ready: "Live price connected.",
  tryNow: "Try now",
  noProof: "This market's creation transaction isn't known on this device, so the live price can't be connected from here.",
  serverTrouble: "Live price couldn't connect just now. Your market is live; try again in a moment.",
  generic: "Live price couldn't connect for this market. Your market is live; try again in a moment.",
} as const;

/**
 * The keeper-register reasons that were written for creators. Everything else the route can say
 * ("Slab account does not exist on-chain", "Registration proof refused: …", "Invalid dexType", …)
 * is an operator diagnostic, so the launch screen maps it to KEEPER_REGISTER_COPY.generic.
 * An allow-list, not a deny-list: a new server message stays hidden until someone adds it here.
 */
export const USER_FACING_REGISTRATION_REASONS: readonly string[] = [
  PRICE_SOURCE_LOCKED,
  "This market's live price was turned off by a maintainer.",
  UNSUPPORTED_POOL_COPY,
  "Could not verify the pool on mainnet right now. Try again in a moment.",
  KEEPER_REGISTER_COPY.noProof,
  KEEPER_REGISTER_COPY.serverTrouble,
  PER_CREATOR_CAP_COPY,
  GLOBAL_CAP_COPY,
];

/** The line a creator sees for a failed registration: the reason itself if it is user copy. */
export function userFacingRegistrationReason(message: string | null | undefined): string {
  const m = (message ?? "").trim();
  return USER_FACING_REGISTRATION_REASONS.includes(m) ? m : KEEPER_REGISTER_COPY.generic;
}

export interface KeeperRegisterRequest {
  slabAddress: string;
  mainnetCA?: string | null;
  dexPoolAddress: string;
  /** Already normalized to the keeper vocabulary (the memo binds exactly what is sent). */
  dexType?: string | null;
  symbol?: string | null;
  payload?: MarketRegistrationPayload | null;
  /** The market-creation (M1) transaction signature: the registration proof. */
  proofTx: string;
}

export interface KeeperRegisterAttempt {
  registered: boolean;
  /** Worth retrying (not landed yet, RPC or server trouble). A 400 / 403 is final. */
  retryable: boolean;
  message: string;
  /** HTTP status of the response; absent for a network error. */
  status?: number;
  /** The response's `Retry-After`, in ms, when it carried one (the full ceiling sends 300 s). */
  retryAfterMs?: number;
}

export async function postKeeperRegistration(req: KeeperRegisterRequest, fetchImpl: typeof fetch = fetch): Promise<KeeperRegisterAttempt> {
  try {
    const r = await fetchImpl("/api/playground/keeper-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slabAddress: req.slabAddress,
        mainnetCA: req.mainnetCA ?? null,
        dexPoolAddress: req.dexPoolAddress,
        dexType: req.dexType ?? null,
        symbol: req.symbol ?? null,
        payload: req.payload ?? null,
        proofTx: req.proofTx,
      }),
    });
    const body = (await r.json().catch(() => ({}))) as { registered?: boolean; error?: string; message?: string };
    if (r.ok && body.registered) return { registered: true, retryable: false, message: KEEPER_REGISTER_COPY.ready, status: r.status };
    // 401 comes only from the devnet v2 waitlist gate (middleware.ts; this route never 401s
    // itself): the visitor's session lapsed. That says nothing about the registration, so it
    // must stay retryable — final would mark the launch "refused" in localStorage forever.
    const retryable = r.status === 401 || r.status === 409 || r.status === 429 || r.status >= 500;
    const ra = Number(r.headers?.get?.("Retry-After"));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3_600) * 1000 : undefined;
    return { registered: false, retryable, message: body.error ?? body.message ?? `HTTP ${r.status}`, status: r.status, ...(retryAfterMs ? { retryAfterMs } : {}) };
  } catch (e) {
    return { registered: false, retryable: true, message: e instanceof Error ? e.message : String(e) };
  }
}

export type KeeperRegisterPhase = "connecting" | "slow" | "ready" | "failed";

export interface KeeperRegisterLoopDeps {
  attempt: () => Promise<KeeperRegisterAttempt>;
  onStatus: (s: { phase: KeeperRegisterPhase; message: string; attempts: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** Consecutive 5xx retries before giving up with "failed" (default KEEPER_REGISTER_MAX_SERVER_RETRIES). */
  maxServerRetries?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

/** The background loop. Resolves with the final phase ("ready" / "failed", or the last one on abort). */
export async function runKeeperRegistration(d: KeeperRegisterLoopDeps): Promise<KeeperRegisterPhase> {
  const sleep = d.sleep ?? defaultSleep;
  const now = d.now ?? Date.now;
  const t0 = now();
  const maxServerRetries = d.maxServerRetries ?? KEEPER_REGISTER_MAX_SERVER_RETRIES;
  let phase: KeeperRegisterPhase = "connecting";
  let serverErrors = 0;
  let notYet = 0;
  for (let i = 0; ; i++) {
    if (d.signal?.aborted) return phase;
    const r = await d.attempt();
    if (r.registered) {
      d.onStatus({ phase: "ready", message: KEEPER_REGISTER_COPY.ready, attempts: i + 1 });
      return "ready";
    }
    if (!r.retryable) {
      d.onStatus({ phase: "failed", message: r.message, attempts: i + 1 });
      return "failed";
    }
    serverErrors = r.status !== undefined && r.status >= 500 ? serverErrors + 1 : 0;
    if (serverErrors > maxServerRetries) {
      d.onStatus({ phase: "failed", message: KEEPER_REGISTER_COPY.serverTrouble, attempts: i + 1 });
      return "failed";
    }
    phase = now() - t0 >= KEEPER_REGISTER_SLOW_AFTER_MS ? "slow" : "connecting";
    d.onStatus({ phase, message: phase === "slow" ? KEEPER_REGISTER_COPY.slow : KEEPER_REGISTER_COPY.connecting, attempts: i + 1 });
    notYet = r.status === 409 ? notYet + 1 : 0;
    const wait =
      r.status === 409 && notYet <= KEEPER_REGISTER_NOT_YET_BACKOFF_MS.length
        ? KEEPER_REGISTER_NOT_YET_BACKOFF_MS[notYet - 1]
        : i < KEEPER_REGISTER_BACKOFF_MS.length
          ? KEEPER_REGISTER_BACKOFF_MS[i]
          : KEEPER_REGISTER_STEADY_MS;
    await sleep(wait, d.signal);
  }
}

const PROOF_KEY = (slab: string) => `perc.keeperProofTx.${slab}`;

/** The creation tx per market, so "Try now" works after a reload on this device. */
export function saveProofTx(slab: string, sig: string): void {
  try {
    window.localStorage.setItem(PROOF_KEY(slab), sig);
  } catch {
    /* private mode: the in-memory loop still has it */
  }
}
export function loadProofTx(slab: string): string | null {
  try {
    return window.localStorage.getItem(PROOF_KEY(slab));
  } catch {
    return null;
  }
}

const PAYLOAD_KEY = (slab: string) => `perc.keeperPayload.${slab}`;

/**
 * The markets-row payload the creation-tx memo was built with (its digest is in the memo, memo
 * v2), so a registration retried after a reload sends the SAME payload and still verifies.
 */
export function saveProofPayload(slab: string, payload: MarketRegistrationPayload): void {
  try {
    window.localStorage.setItem(PAYLOAD_KEY(slab), JSON.stringify(payload));
  } catch {
    /* private mode: the in-memory copy still has it */
  }
}
export function loadProofPayload(slab: string): MarketRegistrationPayload | null {
  try {
    const raw = window.localStorage.getItem(PAYLOAD_KEY(slab));
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as MarketRegistrationPayload) : null;
  } catch {
    return null;
  }
}

// ── Resume on a later visit ────────────────────────────────────────────────────────────────────
// The launch-time loop stops when the creator closes the page. A registration that failed there
// (2026-10-01: every fractional-leverage launch got a 500 from the markets write) left the market
// unpriced with no way back short of a database edit. The proof (the creation tx) and the bound
// payload are already on this device, so the app re-sends them on the creator's next visit.

const REQUEST_KEY = (slab: string) => `perc.keeperRequest.${slab}`;
const REGISTERED_KEY = (slab: string) => `perc.keeperRegistered.${slab}`;
const PROOF_PREFIX = "perc.keeperProofTx.";

/** Minimal Storage surface (window.localStorage in the app; a Map-backed fake in tests). */
export interface KeyStore {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const browserStore = (): KeyStore | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** The exact request the launch sent (without the proof), so a resume sends the same bytes. */
export function saveRegisterRequest(req: Omit<KeeperRegisterRequest, "proofTx" | "payload">, store: KeyStore | null = browserStore()): void {
  try {
    store?.setItem(REQUEST_KEY(req.slabAddress), JSON.stringify(req));
  } catch {
    /* private mode */
  }
}

export function markRegistered(slab: string, store: KeyStore | null = browserStore()): void {
  try {
    store?.setItem(REGISTERED_KEY(slab), "1");
  } catch {
    /* private mode */
  }
  announceMarketRegistered(slab);
}

/**
 * Fired on `window` the moment a registration lands, so every list on this page (the markets page,
 * the landing rail) refetches past the CDN's 10 s + 60 s stale window instead of showing the market
 * a poll or two late (hooks/useAllMarketStats.ts). Other visitors still see it on their next poll.
 */
export const MARKET_REGISTERED_EVENT = "perc:market-registered";
export function announceMarketRegistered(slab: string): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MARKET_REGISTERED_EVENT, { detail: { slab } }));
  } catch {
    /* no window / no CustomEvent: the next poll picks it up */
  }
}

const KEEPER_DEX_TYPE_CANDIDATES: readonly (string | null)[] = ["raydium-clmm", "meteora-dlmm", "pumpswap", null];

/**
 * Candidate requests for one slab. With the saved request there is exactly one. A launch from
 * before the request was saved has only the payload, which carries the pool, the CA and the
 * symbol but not the dex type the memo bound, so each keeper dex type is a candidate (a wrong
 * one is a cheap, final 400 "no matching registration memo"; nothing is written).
 */
export function registrationCandidates(slab: string, store: KeyStore): KeeperRegisterRequest[] {
  const proofTx = store.getItem(`${PROOF_PREFIX}${slab}`);
  if (!proofTx) return [];
  let payload: MarketRegistrationPayload | null = null;
  try {
    const raw = store.getItem(`perc.keeperPayload.${slab}`);
    const v: unknown = raw ? JSON.parse(raw) : null;
    payload = v && typeof v === "object" && !Array.isArray(v) ? (v as MarketRegistrationPayload) : null;
  } catch {
    payload = null;
  }
  try {
    const raw = store.getItem(REQUEST_KEY(slab));
    if (raw) {
      const req = JSON.parse(raw) as Omit<KeeperRegisterRequest, "proofTx" | "payload">;
      if (req && req.slabAddress === slab && typeof req.dexPoolAddress === "string") return [{ ...req, payload, proofTx }];
    }
  } catch {
    /* fall through to the payload */
  }
  const pool = payload && typeof payload.dex_pool_address === "string" ? payload.dex_pool_address : null;
  if (!payload || !pool) return [];
  const sym = typeof payload.symbol === "string" && payload.symbol !== "UNKNOWN" ? payload.symbol : null;
  const ca = typeof payload.mainnet_ca === "string" ? payload.mainnet_ca : null;
  return KEEPER_DEX_TYPE_CANDIDATES.map((dexType) => ({ slabAddress: slab, mainnetCA: ca, dexPoolAddress: pool, dexType, symbol: sym, payload, proofTx }));
}

/** Slabs on this device with a creation proof and no confirmed registration. */
export function pendingRegistrationSlabs(store: KeyStore): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k || !k.startsWith(PROOF_PREFIX)) continue;
    const slab = k.slice(PROOF_PREFIX.length);
    // "1" = registered, "refused" = every candidate refused (final): both are done.
    if (store.getItem(REGISTERED_KEY(slab)) === null) out.push(slab);
  }
  return out;
}

export interface ResumeResult {
  registered: string[];
  /** Server / network trouble: tried again on the next visit. */
  retryLater: string[];
  /** The longest `Retry-After` any retryable answer in this pass carried (ms), if any. */
  retryAfterMs?: number;
  /** Every candidate refused (final). */
  refused: string[];
}

/** A pass that left slabs as `retryLater` is repeated this often while the page stays open. */
export const RESUME_REPEAT_MS = 60_000;
/** ...but never for ever: stop after this many passes or this long from the first, whichever first.
 *  The next page load resumes as before. A permanently failing retryable status (the full ceiling's
 *  429, a standing 5xx) must not make every open tab post every pending slab for as long as it lives. */
export const RESUME_MAX_PASSES = 30;
export const RESUME_MAX_MS = 30 * 60_000;

/**
 * One pass over this device's unregistered launches. A candidate refused with a final error
 * moves to the next candidate; a retryable failure stops that slab until the next visit.
 */
export async function resumePendingRegistrations(d: {
  store: KeyStore;
  post?: (req: KeeperRegisterRequest) => Promise<KeeperRegisterAttempt>;
  /** Only these slabs (a repeat pass over what a previous pass left as `retryLater`). */
  only?: readonly string[];
}): Promise<ResumeResult> {
  const post = d.post ?? ((req: KeeperRegisterRequest) => postKeeperRegistration(req));
  const r: ResumeResult = { registered: [], retryLater: [], refused: [] };
  const slabs = pendingRegistrationSlabs(d.store).filter((slab) => !d.only || d.only.includes(slab));
  for (const slab of slabs) {
    let outcome: "registered" | "later" | "refused" = "refused";
    for (const req of registrationCandidates(slab, d.store)) {
      const a = await post(req);
      if (a.registered) {
        markRegistered(slab, d.store);
        if (req.dexType !== undefined) saveRegisterRequest({ slabAddress: req.slabAddress, mainnetCA: req.mainnetCA, dexPoolAddress: req.dexPoolAddress, dexType: req.dexType, symbol: req.symbol }, d.store);
        outcome = "registered";
        break;
      }
      if (a.retryable) {
        outcome = "later";
        if (a.retryAfterMs) r.retryAfterMs = Math.max(r.retryAfterMs ?? 0, a.retryAfterMs);
        break;
      }
    }
    if (outcome === "refused") {
      try {
        d.store.setItem(REGISTERED_KEY(slab), "refused");
      } catch {
        /* private mode */
      }
    }
    (outcome === "registered" ? r.registered : outcome === "later" ? r.retryLater : r.refused).push(slab);
  }
  return r;
}
