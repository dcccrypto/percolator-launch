import { checkEnvelope, parseCheckJson, MAX_BODY } from "@/lib/allocation-vote/check-request";
import { mapCheckRow, UNAVAILABLE } from "@/lib/allocation-vote/check-result";
import { clientKey } from "@/lib/allocation-vote/client-key";
import { lookupAllocation } from "@/lib/allocation-vote/lookup-db";
import { readAllocationConfig } from "@/lib/allocation-vote/server-config";
import { hostGuard, json } from "@/lib/allocation-vote/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Read at most `limit` bytes of the body; null when it is larger. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
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

/**
 * POST {"wallet": "<one address>"} -> the result for that wallet only:
 * eligible (snapshot balance + provisional USD allocation), excluded (known
 * reasons), not_found (no figures), rate_limited, invalid or unavailable.
 * The wallet is never logged, stored or cached by this handler.
 */
export async function POST(req: Request) {
  const blocked = hostGuard(req);
  if (blocked) return blocked;
  const refused = checkEnvelope(req.headers.get("content-type"), req.headers.get("content-length"));
  if (refused) return json(refused.status, { status: "invalid", error: refused.error });
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return json(413, { status: "invalid", error: "Request too large" });
  const parsed = parseCheckJson(text);
  if (!parsed.ok) return json(parsed.status, { status: "invalid", error: parsed.error });

  const cfg = readAllocationConfig();
  if (!cfg) return json(503, UNAVAILABLE);
  let row;
  try {
    row = await lookupAllocation(cfg, parsed.owner, clientKey(req.headers, cfg.secret));
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "unknown";
    console.error(`[allocation] lookup failed (${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16)})`);
    return json(503, UNAVAILABLE);
  }
  const m = mapCheckRow(row);
  const res = json(m.http, m.body);
  if (m.retryAfter) res.headers.set("Retry-After", String(m.retryAfter));
  return res;
}
