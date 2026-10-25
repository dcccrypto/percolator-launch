/**
 * UX WP-7 (audit §3.15, WZ-2): registering the new market's live price, automatically, with NO
 * signature. The proof is the market-creation transaction itself (lib/keeper-register-memo.ts), so
 * the app can retry in the background for as long as the page is open:
 *   attempt now, then after 5, 10, 20, 40, 60, 60 s, then every 2 min.
 * Status copy: "Connecting the live price… usually under a minute."; after 5 min: "Keep this page open
 * while we keep trying; if you close it, this browser retries on its next visit (resumePendingRegistrations)."
 * A FINAL refusal (a 4xx that is not retryable, e.g. 403 oracle-not-keeper) ends the loop as a
 * "failed" status flagged `final`, with the reason, so the screen says so instead of "connecting".
 * SECURITY REVIEW REQUIRED before merge (replaces the signed-message registration).
 */
import type { MarketRegistrationPayload } from "@/lib/market-registration-auth";
import { PRICE_SOURCE_LOCKED } from "@/lib/market-registration";
import { UNSUPPORTED_POOL_COPY } from "@/lib/wizard-copy";
import { GLOBAL_CAP_COPY, PER_CREATOR_CAP_COPY } from "@/lib/keeper-enrollment-guard";
import { isTxSignature } from "@/lib/keeper-register-memo";

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
  slow: "Your market is created but its live price isn't connected yet. Keep this page open while we keep trying. If you close it, this browser tries again the next time you open Percolator; other devices don't.",
  ready: "Live price connected.",
  tryNow: "Try now",
  noProof: "This market's creation transaction isn't known on this device, so the live price can't be connected from here.",
  serverTrouble: "Live price couldn't connect just now. Your market is live; try again in a moment.",
  /** Retryable-neutral fallback for a reason that is not creator copy (the status may still be a passing one). */
  generic: "Live price couldn't connect for this market. Your market is live; try again in a moment.",
  /** FINAL (#3637): the server refused for good, so nothing here says "try again" and nothing promises a fix. */
  refused: "This market's live price can't connect, and trying again won't change that. The market exists on-chain but will not show a price. Share its address in the Percolator Discord.",
  oracleNotKeeper: "This market's price feed was set up with a key our price service doesn't control, so its live price can't connect, and trying again won't change that. The market exists on-chain but will not show a price. Share its address in the Percolator Discord.",
} as const;

/** Hook state for a launch whose creation tx was not saved on this device: nothing can ever be sent from
 *  here, so it is a final failure from the start (not "connecting"). Shared by the launch and the retry. */
export const KEEPER_NO_PROOF_STATE = { keeperPhase: "failed", keeperMessage: KEEPER_REGISTER_COPY.noProof, keeperFinal: true } as const;

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
  KEEPER_REGISTER_COPY.oracleNotKeeper,
  KEEPER_REGISTER_COPY.refused,
  PER_CREATOR_CAP_COPY,
  GLOBAL_CAP_COPY,
];

/** The one calm line shown on a My Markets row in place of the button once the per-wallet limit refuses
 *  (final: another click cannot help). Lives here, with the other server-facing copy. */
export const PER_CREATOR_LIMIT_ROW_COPY = "This wallet has reached its limit of live-priced markets. Ask the team to connect more.";

/** True when a refusal is the final per-creator limit: nothing the creator can do clears it. Prefers the
 *  route's `code`; the exact copy still counts so an older response is read the same way. */
export function isPerCreatorCapRefusal(r: { code?: string | null; message?: string | null }): boolean {
  return r.code === "per-creator-cap" || (r.message ?? "").trim() === PER_CREATOR_CAP_COPY;
}

/** The line a creator sees for a failed registration: the reason itself if it is user copy; otherwise the
 *  final-refusal line when the server refused for good (`retryable` false), else the try-again line. */
export function userFacingRegistrationReason(message: string | null | undefined, code?: string | null, retryable = true): string {
  if (code === "oracle-not-keeper") return KEEPER_REGISTER_COPY.oracleNotKeeper;
  const m = (message ?? "").trim();
  if (USER_FACING_REGISTRATION_REASONS.includes(m)) return m;
  return retryable ? KEEPER_REGISTER_COPY.generic : KEEPER_REGISTER_COPY.refused;
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
  /** The route's machine-readable refusal reason (`per-creator-cap` is final), when it sent one. */
  code?: string;
  /** HTTP status of the response; absent for a network error. */
  status?: number;
  /** The response's `Retry-After`, in ms, when it carried one (the full ceiling sends 300 s). */
  retryAfterMs?: number;
}

const registrationPosts = new Map<string, Promise<KeeperRegisterAttempt>>();

export function postKeeperRegistration(req: KeeperRegisterRequest, fetchImpl: typeof fetch = fetch): Promise<KeeperRegisterAttempt> {
  if (!isTxSignature(req.proofTx)) {
    return Promise.resolve({ registered: false, retryable: false, message: "Invalid proofTx: expected a transaction signature", status: 400 });
  }
  const existing = registrationPosts.get(req.slabAddress);
  if (existing) return existing;
  const pending = sendKeeperRegistration(req, fetchImpl);
  registrationPosts.set(req.slabAddress, pending);
  void pending.then(() => {
    if (registrationPosts.get(req.slabAddress) === pending) registrationPosts.delete(req.slabAddress);
  }, () => {
    if (registrationPosts.get(req.slabAddress) === pending) registrationPosts.delete(req.slabAddress);
  });
  return pending;
}

async function sendKeeperRegistration(req: KeeperRegisterRequest, fetchImpl: typeof fetch): Promise<KeeperRegisterAttempt> {
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
    const body = (await r.json().catch(() => ({}))) as { registered?: boolean; error?: string; message?: string; code?: string };
    if (r.ok && body.registered) return { registered: true, retryable: false, message: KEEPER_REGISTER_COPY.ready, status: r.status };
    // 401 comes only from the devnet v2 waitlist gate (middleware.ts; this route never 401s
    // itself): the visitor's session lapsed. That says nothing about the registration, so it
    // must stay retryable — final would mark the launch "refused" in localStorage forever.
    const retryable = r.status === 401 || r.status === 409 || r.status === 429 || r.status >= 500;
    const ra = Number(r.headers?.get?.("Retry-After"));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3_600) * 1000 : undefined;
    return { registered: false, retryable, message: body.error ?? body.message ?? `HTTP ${r.status}`, ...(typeof body.code === "string" ? { code: body.code } : {}), status: r.status, ...(retryAfterMs ? { retryAfterMs } : {}) };
  } catch (e) {
    return { registered: false, retryable: true, message: e instanceof Error ? e.message : String(e) };
  }
}

export type KeeperRegisterPhase = "connecting" | "slow" | "ready" | "failed";

export interface KeeperRegisterLoopDeps {
  attempt: () => Promise<KeeperRegisterAttempt>;
  /** `final` = the server refused for good (not retryable); `message` is then creator copy and `code` the route's reason. */
  onStatus: (s: { phase: KeeperRegisterPhase; message: string; attempts: number; final?: boolean; code?: string }) => void;
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
    // Aborted while this attempt was in flight (a manual retry already ended it, or the page left):
    // its answer must not overwrite a status the caller has since set (#3637).
    if (d.signal?.aborted) return phase;
    if (!r.retryable) {
      d.onStatus({ phase: "failed", message: userFacingRegistrationReason(r.message, r.code, false), attempts: i + 1, final: true, ...(r.code ? { code: r.code } : {}) });
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
    await sleep(Math.max(wait, r.retryAfterMs ?? 0), d.signal);
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
export function saveProofPayload(slab: string, payload: MarketRegistrationPayload, store: KeyStore | null = browserStore()): void {
  try {
    store?.setItem(PAYLOAD_KEY(slab), JSON.stringify(payload));
    if (store) announcePendingRegistration(slab, store);
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
// New memo-v2 launches require the saved payload; older unmarked requests may have signed null.
// This flag stays in localStorage only and is never sent to the registration route.
type SavedRegisterRequest = Omit<KeeperRegisterRequest, "proofTx" | "payload"> & { payloadRequired?: true };

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

/** The launch request without proof/payload, plus the local payload-presence contract. */
function announcePendingRegistration(slab: string, store: KeyStore): void {
  try {
    const rawPayload = store.getItem(PAYLOAD_KEY(slab));
    const payload: unknown = rawPayload ? JSON.parse(rawPayload) : null;
    if (
      isTxSignature(store.getItem(`${PROOF_PREFIX}${slab}`)) &&
      payload && typeof payload === "object" && !Array.isArray(payload) &&
      loadRegisterRequest(slab, store) &&
      store.getItem(REGISTERED_KEY(slab)) === null &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab } }));
    }
  } catch {
    /* private mode */
  }
}

export function saveRegisterRequest(req: SavedRegisterRequest, store: KeyStore | null = browserStore()): void {
  try {
    store?.setItem(REQUEST_KEY(req.slabAddress), JSON.stringify(req));
    if (store) announcePendingRegistration(req.slabAddress, store);
  } catch {
    /* private mode */
  }
}

/** The registration request this browser saved for a slab (without proof/payload), or null. */
export function loadRegisterRequest(slab: string, store: KeyStore | null = browserStore()): SavedRegisterRequest | null {
  try {
    const raw = store?.getItem(REQUEST_KEY(slab));
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) && (v as { slabAddress?: unknown }).slabAddress === slab
      ? (v as SavedRegisterRequest)
      : null;
  } catch {
    return null;
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

// Defined in a leaf module so listeners need not import this client (see that file).
import { MARKET_REGISTERED_EVENT } from "./market-registered-event";
export { MARKET_REGISTERED_EVENT };
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
  if (!isTxSignature(proofTx)) return [];
  let payload: MarketRegistrationPayload | null = null;
  const rawPayload = store.getItem(PAYLOAD_KEY(slab));
  if (rawPayload !== null) {
    try {
      const v: unknown = JSON.parse(rawPayload);
      if (!v || typeof v !== "object" || Array.isArray(v)) return [];
      payload = v as MarketRegistrationPayload;
    } catch {
      return [];
    }
  }
  try {
    const raw = store.getItem(REQUEST_KEY(slab));
    if (raw) {
      const req = JSON.parse(raw) as SavedRegisterRequest;
      if (req && req.slabAddress === slab && typeof req.dexPoolAddress === "string") {
        const { payloadRequired, ...request } = req;
        if (payloadRequired === true && !payload) return [];
        return [{ ...request, payload, proofTx }];
      }
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
    if (store.getItem(REGISTERED_KEY(slab)) === null && registrationCandidates(slab, store).length > 0) out.push(slab);
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
