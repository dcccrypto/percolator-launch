import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { getWaitlistSupabase } from "@/lib/waitlist/supabase";

export const runtime = "nodejs";

/**
 * High-intent waitlist signup.
 *
 * Body: {
 *   pubkey: base58 Solana public key,
 *   signature: base58 signature over `message`,
 *   message: text the user signed (MUST contain the pubkey + a recent timestamp),
 *   twitter_handle?: optional handle for follow-up,
 *   source?: optional UTM source
 * }
 *
 * The server verifies the signature with tweetnacl BEFORE inserting,
 * so the RLS-anon-insert policy on the waitlist table cannot be abused
 * to insert someone else's pubkey.
 *
 * Replay protection: the message must include a timestamp within the
 * last 10 minutes; the server rejects older messages.
 */

const MESSAGE_PREFIX = "Joining the Percolator waitlist at ";
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // 10 min

function isValidSolanaPubkey(s: string): boolean {
  try {
    const bytes = bs58.decode(s);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Spam filter: check that the pubkey has been seen on Solana mainnet at all.
 *
 * A spammer can generate ed25519 keypairs locally and sign arbitrary messages —
 * the signature verifies but the wallet has never been funded or used. Real
 * users have at least one on-chain transaction (Phantom funds the account on
 * first use, and any received SOL creates an account info entry).
 *
 * Implementation: server-side getAccountInfo call against Helius mainnet using
 * HELIUS_MAINNET_API_KEY. Result.value === null means "system program does not
 * have an account here" = wallet has never received SOL.
 *
 * Posture: fail-open on RPC errors so a Helius outage doesn't block signups.
 * The cost of letting through a few extras during an outage is lower than
 * blocking real users.
 */
async function walletExistsOnMainnet(pubkey: string): Promise<boolean> {
  const apiKey = (
    process.env.HELIUS_MAINNET_API_KEY ??
    process.env.HELIUS_API_KEY ??
    ""
  ).trim();
  const url = apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
    : "https://api.mainnet-beta.solana.com";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [pubkey, { encoding: "base64", commitment: "confirmed" }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("[waitlist] mainnet RPC non-2xx, fail-open", res.status);
      return true;
    }
    const data = (await res.json()) as { result?: { value?: unknown } };
    return data?.result?.value !== null && data?.result?.value !== undefined;
  } catch (err) {
    console.warn("[waitlist] mainnet RPC error, fail-open", err);
    return true;
  }
}

function parseTimestampFromMessage(message: string): number | null {
  if (!message.startsWith(MESSAGE_PREFIX)) return null;
  const tail = message.slice(MESSAGE_PREFIX.length);
  // Tail format: <ISO8601 timestamp> | <pubkey>
  const sepIdx = tail.indexOf(" | ");
  if (sepIdx === -1) return null;
  const ts = tail.slice(0, sepIdx);
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const pubkey = typeof b.pubkey === "string" ? b.pubkey : null;
  const signature = typeof b.signature === "string" ? b.signature : null;
  const message = typeof b.message === "string" ? b.message : null;
  const twitter_handle =
    typeof b.twitter_handle === "string" && b.twitter_handle.trim().length > 0
      ? b.twitter_handle.trim().slice(0, 50)
      : null;
  const source =
    typeof b.source === "string" && b.source.length > 0
      ? b.source.slice(0, 100)
      : null;

  // Honeypot — silently accept and drop
  if (typeof b.website === "string" && b.website.length > 0) {
    return NextResponse.json({ ok: true });
  }

  if (!pubkey || !signature || !message) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  if (!isValidSolanaPubkey(pubkey)) {
    return NextResponse.json({ error: "invalid pubkey" }, { status: 400 });
  }

  // Replay protection: timestamp must be recent and message must include the pubkey
  const ts = parseTimestampFromMessage(message);
  if (!ts) {
    return NextResponse.json({ error: "invalid message format" }, { status: 400 });
  }
  if (Math.abs(Date.now() - ts) > MAX_MESSAGE_AGE_MS) {
    return NextResponse.json({ error: "message expired" }, { status: 400 });
  }
  if (!message.includes(pubkey)) {
    return NextResponse.json({ error: "message must include pubkey" }, { status: 400 });
  }

  // Verify ed25519 signature
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(signature);
    pubBytes = bs58.decode(pubkey);
  } catch {
    return NextResponse.json({ error: "decode failed" }, { status: 400 });
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return NextResponse.json({ error: "wrong sig/pubkey length" }, { status: 400 });
  }

  const msgBytes = new TextEncoder().encode(message);
  const ok = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  if (!ok) {
    return NextResponse.json({ error: "signature invalid" }, { status: 401 });
  }

  // Spam filter: wallet must have been seen on Solana mainnet at least once.
  // Locally-generated vanity keypairs that have never received SOL get rejected
  // here even if their signature verifies.
  const exists = await walletExistsOnMainnet(pubkey);
  if (!exists) {
    return NextResponse.json(
      {
        error:
          "wallet not seen on Solana mainnet — fund this wallet (any amount) and try again",
      },
      { status: 400 },
    );
  }

  // Insert
  const supabase = getWaitlistSupabase();
  const userAgent = req.headers.get("user-agent")?.slice(0, 200) ?? null;

  const { error: insertError } = await supabase
    .from("waitlist")
    .insert({
      pubkey,
      signature,
      message,
      twitter_handle,
      source,
      user_agent: userAgent,
    });

  // Treat unique-violation as idempotent success
  if (insertError && insertError.code !== "23505") {
    console.error("[waitlist] insert error", insertError);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }

  // Position lookup (best-effort — don't fail the signup if this errors)
  let position: number | null = null;
  try {
    const { data } = await supabase.rpc("waitlist_position", { p_pubkey: pubkey });
    if (typeof data === "number") position = data;
  } catch {
    /* ignore */
  }

  return NextResponse.json({ ok: true, position });
}
