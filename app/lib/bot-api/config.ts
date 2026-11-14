/**
 * Bot API switches. Everything is OFF unless BOT_API_ENABLED=1 on a devnet v2.2 build: then /api/v1 answers and the
 * playground gate lets /api/v1/* through to routes that authenticate themselves. Unset = 503 `disabled` everywhere and the
 * gate is unchanged, so merging the code changes nothing on a deployment until someone turns it on.
 */
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export const API_VERSION = "v1";

/** Edge-safe (middleware): only reads env. */
export function botApiFlagOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOT_API_ENABLED === "1";
}

/** Null when the API may answer, else why not. */
export function botApiDisabledReason(): string | null {
  if (!botApiFlagOn()) return "the bot API is not enabled on this deployment (BOT_API_ENABLED)";
  const network = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  if (network !== "devnet") return `only available on devnet (current: ${network ?? "unset"})`;
  if (!isDevnetV22Enabled()) return "only available on v2.2 builds";
  return null;
}

/** Whether anonymous (no key) callers may use read endpoints. Default yes, at the anon budget. */
export function anonReadsAllowed(): boolean {
  return process.env.BOT_API_ANON_READS !== "0";
}

/** Largest request body accepted (bytes). */
export const MAX_BODY_BYTES = 4096;
