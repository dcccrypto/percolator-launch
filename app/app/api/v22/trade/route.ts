/**
 * POST /api/v22/trade: build an UNSIGNED v2.2 market order for `owner` (lib/v22/trade-build.ts).
 *
 * For bots, agents and other non-browser clients. The server never signs, never sends and holds no key: it returns
 * base64 legacy transactions (fee payer = owner, recent blockhash set) that the caller signs and sends in order.
 * Each one simulated clean here at build time (sigVerify off); otherwise the refusal comes back instead.
 *
 * Body: { owner, market, size, slippageBps?, limitPriceE6?, maxFeeBps?, portfolio? }
 *   size          signed engine size q as a decimal STRING (> 0 buy, < 0 sell); numbers are refused (precision)
 *   slippageBps   around the engine's effective price (default: the app's); ignored with limitPriceE6
 *   limitPriceE6  explicit worst price, > 0
 *   maxFeeBps     refuse instead of signing a higher fee cap than this; without it a fee rise is refused (409)
 *   portfolio     the owner's portfolio on the market, if known (checked; saves the server a scan)
 * 200: { transactions: [{ purpose, transaction, computeUnitLimit, unitsConsumed }], resubmitAfter, summary }
 *   resubmitAfter = true: only a maintenance crank came back; send it, then POST again for the order.
 * 4xx/5xx: { error: <code>, message, logs? }
 *
 * Devnet + v2.2 builds only (403 elsewhere), like /api/mobile/create-market. GET returns this description as JSON.
 */
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { getServerConnection } from "@/lib/server-rpc";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { buildV22Trade, TradeBuildRefusal, type TradeBuildRequest } from "@/lib/v22/trade-build";

export const dynamic = "force-dynamic";

const rateLimiter = createUpstashRateLimiter({ limit: 20, windowMs: 60_000, prefix: "rl:v22-trade-build" });
// Every build costs program scans + simulations on the server's RPC: a ceiling for all callers together, so one source
// (or many behind one unknown-IP bucket) cannot spend the quota the app's own pages need.
const globalLimiter = createUpstashRateLimiter({ limit: 120, windowMs: 60_000, prefix: "rl:v22-trade-build-all" });
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_U64 = (1n << 64n) - 1n;
const MAX_I128_ABS = (1n << 127n) - 1n;

const USAGE = {
  method: "POST",
  body: {
    owner: "base58 wallet that signs and pays",
    market: "base58 v2.2 market (slab) address",
    size: "signed engine size q, decimal string; > 0 buy, < 0 sell",
    slippageBps: "optional, around the engine's effective price",
    limitPriceE6: "optional explicit worst price (> 0), decimal string",
    maxFeeBps: "optional: the highest fee cap you accept; without it a fee rise is refused with the new cap",
    portfolio: "optional: your portfolio on the market (checked), saves a scan",
  },
  returns: "unsigned base64 transactions, in send order; resubmitAfter=true means send the crank then ask again",
  notes: "devnet only; single-asset markets; the owner needs a portfolio with collateral on the market",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

function refuse(code: string, message: string, status: number, logs?: string[]) {
  return json(logs && logs.length > 0 ? { error: code, message, logs } : { error: code, message }, status);
}

function enabled(): string | null {
  const network = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  if (network !== "devnet") return `only available on devnet (current: ${network ?? "unset"})`;
  if (!isDevnetV22Enabled()) return "only available on v2.2 builds";
  return null;
}

function pubkey(v: unknown): PublicKey | null {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return null;
  try {
    const pk = new PublicKey(v);
    return pk.toBase58() === v ? pk : null;
  } catch {
    return null;
  }
}

/** `stringOnly`: values that can exceed 2^53 must come as strings (a JSON number has already lost precision). */
function int(v: unknown, opts: { signed: boolean; max: bigint; stringOnly?: boolean }): bigint | null {
  if (typeof v === "number") {
    if (opts.stringOnly || !Number.isSafeInteger(v)) return null;
  } else if (typeof v !== "string") {
    return null;
  }
  const s = String(v).trim();
  if (!(opts.signed ? /^-?\d{1,40}$/ : /^\d{1,20}$/).test(s)) return null;
  const n = BigInt(s);
  return (n < 0n ? -n : n) <= opts.max ? n : null;
}

/** Validated request, or the 400 message. Exported for tests. */
export function parseTradeBody(body: unknown): TradeBuildRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const owner = pubkey(b.owner);
  if (!owner) return "owner must be a base58 public key";
  const slab = pubkey(b.market);
  if (!slab) return "market must be a base58 public key";
  const size = int(b.size, { signed: true, max: MAX_I128_ABS, stringOnly: true });
  if (size === null || size === 0n) return "size must be a non-zero integer string";
  const req: TradeBuildRequest = { owner, slab, size };
  if (b.slippageBps !== undefined) {
    const v = int(b.slippageBps, { signed: false, max: 10_000n });
    if (v === null) return "slippageBps must be an integer 0..10000";
    req.slippageBps = v;
  }
  if (b.limitPriceE6 !== undefined) {
    const v = int(b.limitPriceE6, { signed: false, max: MAX_U64, stringOnly: true });
    if (v === null || v === 0n) return "limitPriceE6 must be a positive integer";
    req.limitPriceE6 = v;
  }
  if (b.maxFeeBps !== undefined) {
    const v = int(b.maxFeeBps, { signed: false, max: 10_000n });
    if (v === null) return "maxFeeBps must be an integer 0..10000";
    req.maxFeeBps = v;
  }
  if (b.portfolio !== undefined) {
    const v = pubkey(b.portfolio);
    if (!v) return "portfolio must be a base58 public key";
    req.portfolio = v;
  }
  return req;
}

export async function GET() {
  const off = enabled();
  return off ? refuse("disabled", off, 403) : json(USAGE);
}

export async function POST(request: NextRequest) {
  const off = enabled();
  if (off) return refuse("disabled", off, 403);
  const rl = await rateLimiter.check(getClientIp(request));
  const all = rl.allowed ? await globalLimiter.check("all") : rl;
  if (!all.allowed) return json({ error: "rate_limited", message: "too many requests" }, 429, { "Retry-After": String(all.retryAfterSecs || 60) });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("bad_request", "body must be JSON", 400);
  }
  const parsed = parseTradeBody(body);
  if (typeof parsed === "string") return refuse("bad_request", parsed, 400);

  try {
    const r = await buildV22Trade(getServerConnection("confirmed"), parsed);
    return json({
      transactions: r.transactions.map((t) => ({
        purpose: t.purpose,
        transaction: t.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        computeUnitLimit: t.computeUnitLimit,
        unitsConsumed: t.unitsConsumed,
      })),
      resubmitAfter: r.resubmitAfter,
      summary: r.summary,
    });
  } catch (e) {
    if (e instanceof TradeBuildRefusal) return refuse(e.code, e.message, e.status, e.logs);
    return refuse("internal", "could not build the transaction", 500);
  }
}
