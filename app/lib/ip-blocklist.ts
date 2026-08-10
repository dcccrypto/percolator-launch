/**
 * Dual-stack (IPv4 + IPv6) IP blocklist matching.
 *
 * The previous implementation lived inline in middleware.ts and was IPv4-only:
 * `_ipToInt` split on "." and returned -1 for anything else. That had two
 * consequences (GH#2486):
 *
 *   1. An IPv6 CIDR entry (`2001:db8::/32`) was silently DROPPED at parse time,
 *      so no IPv6 range could ever be banned.
 *   2. A bare IPv6 entry was kept, but matched by literal string equality — so
 *      banning `2001:db8::1` did not ban the same address written as
 *      `2001:0db8:0000:0000:0000:0000:0000:0001`, `2001:DB8::1`, or
 *      `[2001:db8::1]:443`. IPv6 has many textual forms for one address; a
 *      string compare bans a spelling, not a host.
 *
 * Both are fixed by parsing every address to bytes and comparing bytes.
 * Deliberately dependency-free: this runs in Next.js Edge middleware on every
 * request, where pulling in a parsing library is a bundle cost paid by all
 * traffic to ban a handful of addresses.
 *
 * IPv4-mapped IPv6 (`::ffff:192.168.1.100`) is folded to its IPv4 form, so an
 * IPv4 rule still catches a client presented in mapped notation — otherwise
 * that notation is itself a bypass.
 */

export type ParsedIp = { bytes: Uint8Array; family: 4 | 6 };

export type BlockEntry =
  | { type: "exact"; ip: ParsedIp }
  | { type: "cidr"; ip: ParsedIp; prefix: number };

/** Strip the decorations a proxy may add: brackets, zone id, and a port. */
function stripDecorations(raw: string): string {
  let s = raw.trim();
  // "[2001:db8::1]:443" or "[2001:db8::1]"
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close > 0) return s.slice(1, close).split("%")[0]!.toLowerCase();
  }
  // "192.0.2.1:443" — only for IPv4, where a single colon is unambiguous.
  // A bare IPv6 has 2+ colons, so this cannot truncate one.
  const firstColon = s.indexOf(":");
  if (firstColon !== -1 && s.indexOf(":", firstColon + 1) === -1 && s.includes(".")) {
    s = s.slice(0, firstColon);
  }
  // "fe80::1%eth0"
  s = s.split("%")[0]!;
  return s.toLowerCase();
}

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    // Reject empty, non-digit, and leading zeros ("010" is octal in some
    // parsers — treating it as 10 here would let it dodge a ban on 10).
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === "0") return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(s: string): Uint8Array | null {
  if (!s.includes(":")) return null;
  const doubleColon = s.indexOf("::");
  if (doubleColon !== s.lastIndexOf("::")) return null; // at most one "::"

  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = s.split(":");
    tail = [];
  } else {
    head = s.slice(0, doubleColon) === "" ? [] : s.slice(0, doubleColon).split(":");
    tail = s.slice(doubleColon + 2) === "" ? [] : s.slice(doubleColon + 2).split(":");
  }

  // A trailing IPv4 literal ("::ffff:192.0.2.1") occupies the last two groups.
  let trailingV4: Uint8Array | null = null;
  const all = [...head, ...tail];
  const last = all[all.length - 1];
  if (last !== undefined && last.includes(".")) {
    trailingV4 = parseIpv4(last);
    if (trailingV4 === null) return null;
    if (tail.length > 0) tail = tail.slice(0, -1);
    else head = head.slice(0, -1);
  }

  const groupCount = head.length + tail.length + (trailingV4 ? 2 : 0);
  if (doubleColon === -1 ? groupCount !== 8 : groupCount > 7) return null;

  const bytes = new Uint8Array(16);
  const writeGroup = (idx: number, hex: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(hex)) return false;
    const v = parseInt(hex, 16);
    bytes[idx * 2] = (v >> 8) & 0xff;
    bytes[idx * 2 + 1] = v & 0xff;
    return true;
  };

  for (let i = 0; i < head.length; i++) {
    if (!writeGroup(i, head[i]!)) return null;
  }
  const tailStart = 8 - tail.length - (trailingV4 ? 2 : 0);
  for (let i = 0; i < tail.length; i++) {
    if (!writeGroup(tailStart + i, tail[i]!)) return null;
  }
  if (trailingV4) {
    bytes.set(trailingV4, 12);
  }
  return bytes;
}

/** True when the 16 bytes are an IPv4-mapped address (::ffff:a.b.c.d). */
function isV4Mapped(b: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  return b[10] === 0xff && b[11] === 0xff;
}

/**
 * Parse an address (any common textual form) into comparable bytes.
 * Returns null when the input is not a valid address.
 */
export function parseIp(raw: string): ParsedIp | null {
  const s = stripDecorations(raw);
  if (s === "" || s === "unknown") return null;

  const v4 = parseIpv4(s);
  if (v4) return { bytes: v4, family: 4 };

  const v6 = parseIpv6(s);
  if (v6) {
    // Fold ::ffff:a.b.c.d down to a.b.c.d so IPv4 rules still apply.
    if (isV4Mapped(v6)) return { bytes: v6.slice(12), family: 4 };
    return { bytes: v6, family: 6 };
  }
  return null;
}

/** True when `ip` falls inside `network`/`prefix`. Families must match. */
export function matchesPrefix(ip: ParsedIp, network: ParsedIp, prefix: number): boolean {
  if (ip.family !== network.family) return false;
  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (ip.bytes[i] !== network.bytes[i]) return false;
  }
  const restBits = prefix & 7;
  if (restBits === 0) return true;
  const mask = (0xff << (8 - restBits)) & 0xff;
  return (ip.bytes[fullBytes]! & mask) === (network.bytes[fullBytes]! & mask);
}

/**
 * Parse `IP_BLOCKLIST`-style entries: comma-separated addresses and/or CIDRs,
 * IPv4 or IPv6. Invalid entries are dropped; `onInvalid` reports them so a
 * typo'd or unsupported rule is not silently ignored (the failure mode that
 * made GH#2486 invisible).
 */
export function parseBlocklist(
  entries: string[],
  onInvalid?: (entry: string, reason: string) => void,
): BlockEntry[] {
  const out: BlockEntry[] = [];
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    if (slash !== -1) {
      const addr = entry.slice(0, slash);
      const prefix = Number(entry.slice(slash + 1));
      const ip = parseIp(addr);
      if (!ip) {
        onInvalid?.(entry, "unparseable address");
        continue;
      }
      const max = ip.family === 4 ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
        onInvalid?.(entry, `prefix must be 0-${max} for IPv${ip.family}`);
        continue;
      }
      out.push({ type: "cidr", ip, prefix });
      continue;
    }
    const ip = parseIp(entry);
    if (!ip) {
      onInvalid?.(entry, "unparseable address");
      continue;
    }
    out.push({ type: "exact", ip });
  }
  return out;
}

/** True when `clientIp` matches any entry. Unparseable client IPs never match. */
export function isIpBlocked(clientIp: string, blocklist: BlockEntry[]): boolean {
  if (blocklist.length === 0) return false;
  const ip = parseIp(clientIp);
  if (!ip) return false;
  for (const e of blocklist) {
    if (e.type === "exact") {
      if (
        e.ip.family === ip.family &&
        e.ip.bytes.length === ip.bytes.length &&
        e.ip.bytes.every((b, i) => b === ip.bytes[i])
      ) {
        return true;
      }
    } else if (matchesPrefix(ip, e.ip, e.prefix)) {
      return true;
    }
  }
  return false;
}
