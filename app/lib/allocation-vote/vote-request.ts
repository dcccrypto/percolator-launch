/**
 * Strict parsing of the vote API bodies. Pure (no env, no I/O) except
 * readCapped, which only reads the request stream up to a byte limit.
 *
 *   POST /api/vote/challenge  {"wallet","choice"}
 *   POST /api/vote/submit     {"wallet","choice","nonce","issuedAt","expiresAt","signature"}
 *
 * Exactly these keys, string values only, no arrays/batches, small bodies.
 */
import { validateOwner } from "./owner";
import { isVoteChoice, VOTE_NONCE_RE, VOTE_TS_RE, type VoteChoice } from "./vote-message";

export const VOTE_MAX_BODY = 1024;

export type Refusal = { ok: false; status: 400 | 413 | 415; error: string };
export type ParsedChallenge = { ok: true; wallet: string; choice: VoteChoice } | Refusal;
export type ParsedSubmit =
  | { ok: true; wallet: string; choice: VoteChoice; nonce: string; issuedAt: string; expiresAt: string; signature: string }
  | Refusal;

const bad = (error: string): Refusal => ({ ok: false, status: 400, error });

/** Read at most `limit` bytes of the body; null when it is larger. */
export async function readCapped(req: Request, limit: number = VOTE_MAX_BODY): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseObject(text: string, keys: readonly string[]): Record<string, unknown> | Refusal {
  if (text.length > VOTE_MAX_BODY) return { ok: false, status: 413, error: "Request too large" };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("Body must be a JSON object");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("Body must be a JSON object");
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) return bad(`Send exactly: ${keys.join(", ")}`);
  for (const k of keys) if (typeof (v as Record<string, unknown>)[k] !== "string") return bad(`${k} must be a string`);
  return v as Record<string, unknown>;
}

const isRefusal = (x: unknown): x is Refusal => !!x && typeof x === "object" && (x as Refusal).ok === false;

export function parseChallenge(text: string): ParsedChallenge {
  const o = parseObject(text, ["wallet", "choice"]);
  if (isRefusal(o)) return o;
  const w = validateOwner(o.wallet);
  if (!w.ok || w.owner !== o.wallet) return bad(w.ok ? "Wallet address must not contain spaces" : w.message);
  if (!isVoteChoice(o.choice)) return bad("Unknown choice");
  return { ok: true, wallet: w.owner, choice: o.choice };
}

export function parseSubmit(text: string): ParsedSubmit {
  const o = parseObject(text, ["wallet", "choice", "nonce", "issuedAt", "expiresAt", "signature"]);
  if (isRefusal(o)) return o;
  const w = validateOwner(o.wallet);
  if (!w.ok || w.owner !== o.wallet) return bad(w.ok ? "Wallet address must not contain spaces" : w.message);
  if (!isVoteChoice(o.choice)) return bad("Unknown choice");
  const nonce = o.nonce as string;
  const issuedAt = o.issuedAt as string;
  const expiresAt = o.expiresAt as string;
  const signature = o.signature as string;
  if (!VOTE_NONCE_RE.test(nonce)) return bad("Malformed nonce");
  if (!VOTE_TS_RE.test(issuedAt) || !VOTE_TS_RE.test(expiresAt)) return bad("Malformed timestamp");
  if (signature.length < 64 || signature.length > 90 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) return bad("Malformed signature");
  return { ok: true, wallet: w.owner, choice: o.choice, nonce, issuedAt, expiresAt, signature };
}
