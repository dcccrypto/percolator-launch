/**
 * Bot API switches. Everything is OFF unless BOT_API_ENABLED=1 on a devnet v2.2 build: then /api/v1 answers and the
 * playground gate lets /api/v1/* through to routes that authenticate themselves. Unset = 503 `disabled` everywhere and the
 * gate is unchanged, so merging the code changes nothing on a deployment until someone turns it on.
 *
 * PROVISIONAL / OPEN OWNER DECISIONS (docs/ideas/bot-trading-rails.md section 8; none is decided, these are devnet test defaults):
 *  - Playground-gate exemption: with BOT_API_ENABLED=1 the gate lets /api/v1/* through (lib/playground-gate.ts). There is no
 *    separate switch for it: "API on" means "waitlist bypass on". Whether bots may bypass the waitlist is the owner's call.
 *  - Anonymous reads: allowed by default (anonReadsAllowed below, BOT_API_ANON_READS=0 turns them off). Also an owner call.
 */
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export const API_VERSION = "v1";

/** Edge-safe (middleware): only reads env. */
export function botApiFlagOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOT_API_ENABLED === "1";
}

/** Both Upstash REST variables are set: the store is shared across serverless instances. */
export function sharedKvConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

/** A deployed build (Vercel sets VERCEL) with only the per-process map: keys, limits and idempotency cannot work there. */
export function memoryKvOnDeployedBuild(backend: "upstash" | "memory", env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VERCEL) && backend === "memory";
}

/** Null when the API may answer, else why not. */
export function botApiDisabledReason(): string | null {
  if (!botApiFlagOn()) return "the bot API is not enabled on this deployment (BOT_API_ENABLED)";
  const network = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  if (network !== "devnet") return `only available on devnet (current: ${network ?? "unset"})`;
  if (!isDevnetV22Enabled()) return "only available on v2.2 builds";
  if (process.env.VERCEL && !sharedKvConfigured()) return "a deployed build needs the shared key store (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN); the in-process map cannot hold keys or limits across instances";
  return null;
}

/** Whether anonymous (no key) callers may use read endpoints. Default yes, at the anon budget. PROVISIONAL: an open owner decision (see the header). */
export function anonReadsAllowed(): boolean {
  return process.env.BOT_API_ANON_READS !== "0";
}

/** Largest request body accepted (bytes). */
export const MAX_BODY_BYTES = 4096;
