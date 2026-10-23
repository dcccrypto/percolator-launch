/**
 * S3-C10 (fix-all 2026-10-18): a `NEXT_PUBLIC_*` variable is inlined into the browser bundle at
 * build time, so an RPC URL carrying an API key (e.g. `https://devnet.helius-rpc.com/?api-key=…`)
 * or a raw `NEXT_PUBLIC_HELIUS_API_KEY` would ship the key to every visitor. The app routes browser
 * RPC through the server-side /api/rpc proxy, so no browser code needs such a key.
 *
 * `stripPublicRpcKeys` is called from next.config.ts BEFORE the bundle is compiled: it removes any
 * offending variable from the build's environment (so it is never inlined) and logs which, by NAME
 * only (never the value). No env is changed anywhere else.
 *
 * Exempt by design: `NEXT_PUBLIC_HELIUS_WS_API_KEY`, the dedicated WS-only key that is meant to be
 * public (PERC-469), and any URL whose key IS that WS key.
 *
 * Pure and dependency-free so next.config.ts can import it.
 */

/** Bare public variables that are an RPC API key by name. */
const FORBIDDEN_PUBLIC_KEYS: readonly string[] = ["NEXT_PUBLIC_HELIUS_API_KEY"];

/** Exempt: the WS-only key is public by design. */
const PUBLIC_BY_DESIGN = "NEXT_PUBLIC_HELIUS_WS_API_KEY";

const KEY_PARAM = /^(api[-_]?key|apikey)$/i;

/** The secret embedded in a URL value (query param or Helius-style path key), or null. */
export function urlEmbeddedKey(value: string): string | null {
  const v = value.trim();
  if (!/^(https?|wss?):\/\//i.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  for (const [k, val] of u.searchParams) {
    if (KEY_PARAM.test(k) && val.trim()) return val.trim();
  }
  if (u.username || u.password) return u.password || u.username;
  return null;
}

export interface PublicKeyLeak {
  name: string;
  reason: "raw-key" | "url-key";
}

/** Every NEXT_PUBLIC_* variable that would ship an RPC key to the browser (names only). */
export function findPublicRpcKeyLeaks(env: Record<string, string | undefined>): PublicKeyLeak[] {
  const wsKey = (env[PUBLIC_BY_DESIGN] ?? "").trim();
  const leaks: PublicKeyLeak[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_") || name === PUBLIC_BY_DESIGN) continue;
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (FORBIDDEN_PUBLIC_KEYS.includes(name)) {
      if (wsKey && value === wsKey) continue;
      leaks.push({ name, reason: "raw-key" });
      continue;
    }
    const key = urlEmbeddedKey(value);
    if (key && key !== wsKey) leaks.push({ name, reason: "url-key" });
  }
  return leaks.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remove every leaking variable from `env` (default process.env) so the build cannot inline it.
 * Returns the names removed. Logs names only.
 */
export function stripPublicRpcKeys(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (m) => console.error(m),
): string[] {
  const leaks = findPublicRpcKeyLeaks(env);
  for (const l of leaks) delete env[l.name];
  if (leaks.length > 0) {
    log(
      `[public-env-guard] SECURITY: removed ${leaks.map((l) => `${l.name} (${l.reason})`).join(", ")} ` +
        "from the build: a NEXT_PUBLIC_* RPC key would ship to every browser. Use the server-only " +
        "variables (DEVNET_RPC_URL / HELIUS_*_API_KEY) behind /api/rpc instead.",
    );
  }
  return leaks.map((l) => l.name);
}
