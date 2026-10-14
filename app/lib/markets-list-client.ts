/**
 * The ONE client URL for the full markets list, and a fetcher that collapses concurrent callers.
 *
 * Review E2 (2026-10-14): the browser asked for the same list under 5+ URLs (`/api/markets`,
 * `?limit=500`, `?limit=200`, `?include_zombie=true&limit=500`, `&fresh=<ts>`), each a separate
 * CDN entry and a separate function invocation, and every hook that mounted fetched its own copy.
 * Every list caller now uses MARKETS_LIST_URL, and fetchMarketsList shares one in-flight request
 * between the callers that ask within a moment of each other (a page's hooks mounting together).
 *
 * The canonical URL includes zombie rows (tagged `is_zombie: true`) because useAllMarketStats needs
 * them; listedMarketRows() reproduces the default `/api/markets` list (zombies dropped, order kept)
 * for callers that used the bare URL.
 *
 * Not covered here on purpose: `?search=` (the create-wizard duplicate check, a different query) and
 * the per-slab `/api/markets/[slab]` detail.
 */

export const MARKETS_LIST_URL = "/api/markets?include_zombie=true&limit=500";

export interface MarketsListBody {
  markets?: unknown;
  total?: number;
  activeTotal?: number;
  error?: string;
}

export class MarketsListHttpError extends Error {
  constructor(readonly status: number) {
    super(`Markets API returned ${status}`);
    this.name = "MarketsListHttpError";
  }
}

/**
 * A pending request is shared only while it is this young. That is what collapses N hooks
 * mounting on one page into one request; an older request (a slow or hung one, or one a user's
 * refresh should not wait on) is never joined, so a stuck fetch cannot stall every caller.
 */
const SHARE_WINDOW_MS = 2_000;

let inflight: { at: number; p: Promise<MarketsListBody> } | null = null;

/** Test hook: drop the shared in-flight request. */
export function resetMarketsListClient(): void {
  inflight = null;
}

/**
 * GET the canonical markets list. Callers within SHARE_WINDOW_MS of a pending request share it.
 * The parsed body is shared too: treat it as read-only.
 *
 * `fresh` is for the moment right after a registration lands on this device: a distinct URL skips
 * the CDN copy and the server answers from a copy at most a few seconds old (see /api/markets). It
 * is never shared with ordinary callers.
 */
export function fetchMarketsList(opts: { fresh?: boolean } = {}): Promise<MarketsListBody> {
  if (opts.fresh) return request(`${MARKETS_LIST_URL}&fresh=${Date.now()}`, true);
  const now = Date.now();
  if (inflight) {
    const age = now - inflight.at;
    if (age >= 0 && age < SHARE_WINDOW_MS) return inflight.p;
  }
  const p = request(MARKETS_LIST_URL, false);
  const entry = { at: now, p };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  p.then(clear, clear);
  return p;
}

async function request(url: string, fresh: boolean): Promise<MarketsListBody> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    ...(fresh ? { cache: "no-store" as const } : {}),
  });
  if (!res.ok) throw new MarketsListHttpError(res.status);
  return (await res.json()) as MarketsListBody;
}

/** Resolve within `ms` or reject (the shared request itself keeps running for other callers). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Every row of the list body (zombies included), or null when the body has no markets array. */
export function allMarketRows(body: MarketsListBody | null | undefined): Record<string, unknown>[] | null {
  const list = body?.markets;
  if (!Array.isArray(list)) return null;
  return list.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
}

/**
 * The rows the default `/api/markets` (no include_zombie) returns: the canonical list minus rows the
 * route tagged `is_zombie: true`, in the same order. Null when the body has no markets array.
 */
export function listedMarketRows(body: MarketsListBody | null | undefined): Record<string, unknown>[] | null {
  const rows = allMarketRows(body);
  return rows === null ? null : rows.filter((r) => r.is_zombie !== true);
}
