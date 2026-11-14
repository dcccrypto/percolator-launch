/**
 * Uptime check for /api/v1: GET /health, then a market read (the market list, then one market). Prints one line per
 * check with status and latency; exits 1 if any check fails (non-200, bad body, timeout, or slower than --max-ms).
 * Runs anywhere with Node 20+; it only reads and sends no secrets unless you pass a key.
 *   npx tsx scripts/bot-api/uptime.ts --base https://<deployment> [--market ADDR] [--max-ms 3000] [--timeout-ms 10000] [--fail-on-stale]
 * A key, if needed, comes from UPTIME_API_KEY (never from an argument). With a key set, a keyed check also runs
 * (GET /api/v1/metrics, `ops` scope): it is what catches a KV outage, where anonymous reads still answer but every key fails.
 * /health with status "degraded" (KV failing, memory store on a deployed build) fails the check.
 */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const base = (flag("base") ?? "http://127.0.0.1:3917").replace(/\/+$/, "");
const timeoutMs = Number(flag("timeout-ms") ?? 10_000);
const maxMs = flag("max-ms") ? Number(flag("max-ms")) : null;
const failOnStale = process.argv.includes("--fail-on-stale");
const key = process.env.UPTIME_API_KEY;

interface Result {
  name: string;
  ok: boolean;
  status: number;
  ms: number;
  note: string;
  json: Record<string, unknown> | null;
}

function describeDegraded(j: Record<string, unknown> | null): string {
  const kv = j?.kv as { backend?: string; degraded?: boolean; memoryOnDeployedBuild?: boolean } | undefined;
  const bits = [kv?.degraded ? "kv degraded" : "", kv?.memoryOnDeployedBuild ? "memory kv on a deployed build" : "", (j?.clientIp as { resolved?: boolean } | undefined)?.resolved === false ? "client ip unresolved" : ""].filter(Boolean);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

/** The keyed check: /metrics answers Prometheus text, not JSON, and needs the ops scope. */
async function checkKeyed(): Promise<Result> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/v1/metrics`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    if (res.status !== 200) {
      let code = "";
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "";
      } catch {
        /* not JSON */
      }
      return { name: "keyed", ok: false, status: res.status, ms, note: code ? `error ${code}` : "not a 200", json: null };
    }
    if (!text.includes("botapi_requests_total")) return { name: "keyed", ok: false, status: 200, ms, note: "metrics body is not Prometheus text", json: null };
    if (maxMs !== null && ms > maxMs) return { name: "keyed", ok: false, status: 200, ms, note: `slower than ${maxMs} ms`, json: null };
    return { name: "keyed", ok: true, status: 200, ms, note: "key accepted (ops scope)", json: null };
  } catch (e) {
    return { name: "keyed", ok: false, status: 0, ms: Math.round(performance.now() - t0), note: e instanceof Error && e.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : "request failed", json: null };
  }
}

async function check(name: string, path: string, verify: (j: Record<string, unknown>) => string | null): Promise<Result> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Math.round(performance.now() - t0);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status !== 200 || !json) {
      const code = (json?.error as { code?: string } | undefined)?.code;
      const st = typeof json?.status === "string" ? json.status : null;
      return { name, ok: false, status: res.status, ms, note: code ? `error ${code}` : st ? `status ${st}${describeDegraded(json)}` : "not a JSON 200", json };
    }
    const bad = verify(json);
    if (bad) return { name, ok: false, status: 200, ms, note: bad, json };
    if (maxMs !== null && ms > maxMs) return { name, ok: false, status: 200, ms, note: `slower than ${maxMs} ms`, json };
    return { name, ok: true, status: 200, ms, note: "", json };
  } catch (e) {
    return { name, ok: false, status: 0, ms: Math.round(performance.now() - t0), note: e instanceof Error && e.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : "request failed", json: null };
  }
}

const line = (r: Result) => `${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(8)} ${String(r.status).padStart(3)} ${String(r.ms).padStart(5)} ms  ${r.note}`.trimEnd();

async function main() {
  const results: Result[] = [];
  const health = await check("health", "/api/v1/health", (j) => (j.status === "ok" && typeof j.slot === "number" ? null : `health status is ${String(j.status)}${describeDegraded(j)}`));
  if (health.ok) health.note = `slot ${health.json?.slot}, rpc ${health.json?.rpcMs} ms, kv ${(health.json?.kv as { backend?: string } | undefined)?.backend}${health.json?.writesPaused ? ", WRITES PAUSED" : ""}`;
  results.push(health);
  console.log(line(health));

  if (key) {
    const keyed = await checkKeyed();
    results.push(keyed);
    console.log(line(keyed));
  }

  let market = flag("market");
  const list = await check("markets", "/api/v1/markets", (j) => (Array.isArray(j.markets) ? null : "no markets array"));
  if (list.ok) {
    const ms = list.json?.markets as Array<{ market: string }>;
    list.note = `${ms.length} markets`;
    if (ms.length === 0 && !market) {
      list.ok = false;
      list.note = "no markets listed";
    }
    market = market ?? ms[0]?.market;
  }
  results.push(list);
  console.log(line(list));

  if (market) {
    const one = await check("market", `/api/v1/markets/${market}`, (j) => {
      const m = j.market as { oracle?: { stale?: boolean } } | undefined;
      if (!m) return "no market in body";
      return failOnStale && m.oracle?.stale ? "oracle is stale" : null;
    });
    if (one.ok) {
      const m = one.json?.market as { symbol?: string | null; oracle?: { stale?: boolean; ageSecs?: number | null } };
      one.note = `${m.symbol ?? market.slice(0, 8)} oracle ${m.oracle?.stale ? "STALE" : "fresh"}${m.oracle?.ageSecs != null ? ` (${Math.round(m.oracle.ageSecs)} s old)` : ""}`;
    }
    results.push(one);
    console.log(line(one));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `all ${results.length} checks passed` : `${failed} of ${results.length} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
void main();
