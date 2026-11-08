/**
 * Server-only configuration for the allocation lookup. The ONLY env reads on
 * the allocation surface live here, and none of them is a publish switch:
 * without a valid runtime-role database URL and a rate-limit secret the
 * checker fails closed as unavailable.
 *
 *   ALLOCATION_DATABASE_URL        postgres URL for role perc_alloc_reader (server-only)
 *   ALLOCATION_RATE_LIMIT_SECRET   >= 32 chars, HMAC key for client-IP bucket keys (server-only)
 *   ALLOCATION_DATABASE_CA_PEM     optional, CA certificate (PEM) for verified TLS
 */
import "server-only";

export const READER_ROLE = "perc_alloc_reader";
export const MIN_SECRET_LENGTH = 32;
/** URL query parameters that pg would use to override the host/port/options. */
export const OVERRIDE_PARAMS = ["host", "hostaddr", "port", "options", "service", "servicefile"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface AllocationConfig {
  connectionString: string;
  /** null for loopback hosts (local development/E2E); otherwise always verified TLS */
  ssl: { rejectUnauthorized: true; ca?: string } | null;
  secret: string;
}

export function readAllocationConfig(env: NodeJS.ProcessEnv = process.env): AllocationConfig | null {
  const raw = env.ALLOCATION_DATABASE_URL;
  const secret = env.ALLOCATION_RATE_LIMIT_SECRET;
  if (!raw || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  // Only the least-privilege runtime role may be configured (Supavisor form: role.project_ref).
  const user = decodeURIComponent(u.username);
  if (user !== READER_ROLE && !user.startsWith(`${READER_ROLE}.`)) return null;
  // Connection parameters that could redirect the connection away from the URL
  // host (and so dodge the TLS decision below) are refused outright.
  if (OVERRIDE_PARAMS.some((k) => u.searchParams.has(k))) return null;
  const local = LOCAL_HOSTS.has(u.hostname);
  // TLS is decided here, not by URL parameters: drop every query parameter.
  u.search = "";
  const ca = env.ALLOCATION_DATABASE_CA_PEM?.trim();
  return {
    connectionString: u.toString(),
    ssl: local ? null : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    secret,
  };
}
