/**
 * UX WP-10 (audit §5.1): harvest every user-visible string the app's copy tables and message
 * resolvers can produce, for the banned-terms guard. Functions are called with sample arguments;
 * the resolvers are driven over every wrapper / matcher code and surface.
 */
export interface CopyString {
  source: string;
  text: string;
}

const SAMPLE = ["1", "2", "3", "4"];

function walk(source: string, v: unknown, out: CopyString[], depth = 0): void {
  if (depth > 6 || v === null || v === undefined) return;
  if (typeof v === "string") {
    out.push({ source, text: v });
    return;
  }
  if (typeof v === "function") {
    try {
      const r = (v as (...a: unknown[]) => unknown)(...SAMPLE.slice(0, Math.max(v.length, 1)));
      walk(`${source}()`, r, out, depth + 1);
    } catch {
      /* a function that needs real args: skipped */
    }
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(`${source}[${i}]`, x, out, depth + 1));
    return;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${source}.${k}`, x, out, depth + 1);
  }
}

export async function collectCopyStrings(): Promise<CopyString[]> {
  const out: CopyString[] = [];
  const mods: [string, () => Promise<Record<string, unknown>>][] = [
    ["limits/copy", () => import("@/lib/limits/copy")],
    ["limits/earn-withdraw", () => import("@/lib/limits/earn-withdraw")],
    ["limits/creator-stake", () => import("@/lib/limits/creator-stake")],
    ["v22/reduce-copy", () => import("@/lib/v22/reduce-copy")],
    ["limits/resolved-eta", () => import("@/lib/limits/resolved-eta")],
    ["first-trade", () => import("@/lib/first-trade")],
    ["keeper-register-client", () => import("@/lib/keeper-register-client")],
    ["wizard-copy", () => import("@/lib/wizard-copy")],
    ["close-market-checklist", () => import("@/lib/close-market-checklist")],
    ["stake-copy", () => import("@/lib/stake-copy")],
    ["errorMessages", () => import("@/lib/errorMessages")],
  ];
  for (const [name, load] of mods) {
    const m = await load();
    for (const [k, v] of Object.entries(m)) {
      if (!/COPY|MESSAGE|MESSAGES|_TEXT$/.test(k)) continue;
      walk(`${name}.${k}`, v, out);
    }
  }
  // The one resolver, over every wrapper code, every surface.
  const um = await import("@/lib/limits/user-message");
  const { WRAPPER_ERR } = await import("@/lib/wrapper-errors");
  const surfaces = ["trade", "close", "earn-deposit", "earn-withdraw", "creator-stake", "create", "close-market", "nft", "faucet", "stake", "any"] as const;
  const codes = [...new Set(Object.values(WRAPPER_ERR as Record<string, number>))];
  for (const surface of surfaces) {
    for (const code of codes) {
      const err = new Error(`Transaction simulation failed: {"InstructionError":[0,{"Custom":${code}}]}`);
      try {
        const m = (um as unknown as { resolveUserMessage?: (e: unknown, c: unknown) => { title?: string; body?: string } }).resolveUserMessage?.(err, { surface });
        if (m) {
          if (m.title) out.push({ source: `resolve(${surface},${code}).title`, text: m.title });
          if (m.body) out.push({ source: `resolve(${surface},${code}).body`, text: m.body });
        }
      } catch {
        /* skipped */
      }
    }
  }
  // The legacy fallbacks the resolver still delegates to: humanizeError and the Earn mapper.
  const em = await import("@/lib/errorMessages");
  const earn = await import("@/lib/earnErrors");
  for (const code of codes) {
    const raw = `Transaction simulation failed: {"InstructionError":[0,{"Custom":${code}}]}`;
    try {
      const h = (em as unknown as { humanizeError?: (m: string) => string }).humanizeError?.(raw);
      if (h) out.push({ source: `humanizeError(${code})`, text: h });
    } catch {
      /* skipped */
    }
    for (const action of ["deposit", "claim"] as const) {
      try {
        out.push({ source: `earnErrorMessage(${action},${code})`, text: earn.earnErrorMessage(new Error(raw), action) });
      } catch {
        /* skipped */
      }
    }
  }
  return out;
}

/** §5.1 banned terms in user-visible strings (Details, dev-chrome titles and comments excepted). */
export const BANNED: [string, RegExp][] = [
  ["LP", /\bLPs?\b/],
  ["liquidity provider", /liquidity provider/i],
  ["tranche", /\btranches?\b/i],
  ["senior", /\bseniors?\b/i],
  ["junior", /\bjuniors?\b/i],
  ["NAV", /\bNAV\b/],
  ["cushion", /\bcushion\b/i],
  ["crank", /\bcrank(ed|s|ing)?\b/i],
  ["keeper", /\bkeepers?\b/i],
  ["maintainer", /\bmaintainers?\b/i],
  ["re-seed", /\bre-?seed/i],
  ["certificate", /\bcert(ificate|ified)?s?\b/i],
  ["valuation stale", /valuation stale/i],
  ["slot", /\bslots?\b/i],
  ["recall", /\brecall(ed|s)?\b/i],
  ["harvest", /\bharvest(ed|s|ing)?\b/i],
  ["escrow", /\bescrow(ed|s)?\b/i],
  ["pot", /\bpots?\b/i],
  ["backing bucket", /backing bucket/i],
  ["drain", /\bdrain(ed|s)?\b/i],
  ["reset side", /reset side/i],
  ["matcher", /\bmatchers?\b/i],
  ["vAMM", /\bvAMM\b/i],
  ["quote kind", /quote kind/i],
  ["bps", /\bbps\b/i],
  ["slab", /\bslabs?\b/i],
  ["portfolio", /\bportfolios?\b/i],
  ["sub-account", /\bsub-?accounts?\b/i],
  ["RebalanceReduce", /RebalanceReduce/],
  ["unilateral exit", /unilateral exit/i],
  ["tag N", /\btag \d+/i],
  ["permissionless", /\bpermissionless\b/i],
  ["program refused", /(the program refused|rejected by the program|refused by the program)/i],
  ["Custom(n)", /Custom\(\d+\)/],
  ["hex code", /\b0x[0-9a-f]+\b/i],
  ["code N", /\bcode \d+/i],
  ["Program error", /Program error/],
  ["Transaction failed raw", /Transaction failed:/],
  ["SOL-PERP", /-PERP\b/],
  ["units", /\bunits\b/i],
];

export function bannedHits(all: readonly CopyString[]): { source: string; term: string; text: string }[] {
  const hits: { source: string; term: string; text: string }[] = [];
  for (const s of all) for (const [term, re] of BANNED) if (re.test(s.text)) hits.push({ source: s.source, term, text: s.text });
  return hits;
}
