import type { Context, Next } from "hono";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:ip-blocklist");

/**
 * IP Blocklist Middleware
 *
 * Reads a comma-separated list of blocked CIDRs/IPs from the IP_BLOCKLIST
 * environment variable and rejects matching requests with 403 before they
 * reach any other middleware (rate-limit, auth, routes).
 *
 * Usage (Railway / .env):
 *   IP_BLOCKLIST=88.97.223.158,10.0.0.5,192.168.1.0/24
 *
 * IP extraction respects TRUSTED_PROXY_DEPTH (same logic as rate-limit.ts).
 * CIDR matching is supported for /8, /16, /24, /32 (IPv4 only).
 */

const PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));

// Parse the env var once at startup
const RAW_BLOCKLIST = (process.env.IP_BLOCKLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (RAW_BLOCKLIST.length > 0) {
  logger.info("IP blocklist loaded", { count: RAW_BLOCKLIST.length, entries: RAW_BLOCKLIST });
} else {
  logger.info("IP blocklist is empty — no IPs will be blocked");
}

/** Convert a dotted-decimal IPv4 to a 32-bit integer */
function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

interface ParsedEntry {
  type: "exact" | "cidr";
  raw: string;
  // For exact matches
  ip?: string;
  // For CIDR matches
  network?: number;
  mask?: number;
}

function parseEntry(entry: string): ParsedEntry | null {
  if (entry.includes("/")) {
    const [addr, prefixStr] = entry.split("/");
    const prefix = Number(prefixStr);
    if (!addr || isNaN(prefix) || prefix < 0 || prefix > 32) return null;
    const network = ipToInt(addr);
    if (network === -1) return null;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { type: "cidr", raw: entry, network: (network & mask) >>> 0, mask };
  }
  return { type: "exact", raw: entry, ip: entry };
}

const PARSED_BLOCKLIST: ParsedEntry[] = RAW_BLOCKLIST.map(parseEntry).filter(
  (e): e is ParsedEntry => e !== null
);

function isBlocked(clientIp: string): boolean {
  if (PARSED_BLOCKLIST.length === 0) return false;

  const clientInt = ipToInt(clientIp);

  for (const entry of PARSED_BLOCKLIST) {
    if (entry.type === "exact") {
      if (clientIp === entry.ip) return true;
    } else {
      if (clientInt === -1) continue;
      if ((clientInt & entry.mask!) >>> 0 === entry.network) return true;
    }
  }
  return false;
}

function getClientIp(c: Context): string {
  if (PROXY_DEPTH === 0) {
    return c.req.header("x-real-ip") ?? "unknown";
  }
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    const idx = Math.max(0, ips.length - PROXY_DEPTH);
    return ips[idx] || "unknown";
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

export function ipBlocklist() {
  return async (c: Context, next: Next) => {
    if (PARSED_BLOCKLIST.length === 0) return next();

    const ip = getClientIp(c);
    if (isBlocked(ip)) {
      logger.warn("Blocked request from blocklisted IP", {
        ip,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json({ error: "Forbidden" }, 403);
    }

    return next();
  };
}
