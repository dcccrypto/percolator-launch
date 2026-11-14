/**
 * Ops script for bot-API keys (v1 issues keys by hand; self-serve is later). Uses the same KV as the routes, so run it
 * with the deployment's UPSTASH_REDIS_REST_URL / _TOKEN and BOT_API_KEY_PEPPER in the environment (never pass them as
 * arguments). Prints the new key ONCE; only its keyId is stored in clear.
 *   npx tsx scripts/bot-api/keys.ts issue --scopes read,build [--tier default|mm] [--label "..."]
 *   npx tsx scripts/bot-api/keys.ts revoke <keyId>
 *   npx tsx scripts/bot-api/keys.ts show <keyId>
 */
import { issueKey, revokeKey, getKeyRecord, type Scope, type Tier } from "@/lib/bot-api/keys";
import { getKv } from "@/lib/bot-api/kv";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [cmd, id] = process.argv.slice(2);
  if (getKv().backend !== "upstash") console.error("warning: no UPSTASH_REDIS_REST_URL/_TOKEN, using an in-process store (the key dies with this process)");
  if (cmd === "issue") {
    const scopes = (arg("scopes") ?? "read").split(",").filter(Boolean) as Scope[];
    if (scopes.some((s) => !["read", "build", "ops"].includes(s))) throw new Error("scopes: read, build, ops");
    const tier = (arg("tier") ?? "default") as Tier;
    if (!["default", "mm"].includes(tier)) throw new Error("tier: default | mm");
    const { key, record } = await issueKey({ scopes, tier, label: arg("label") });
    console.log(JSON.stringify({ keyId: record.id, scopes: record.scopes, tier: record.tier, label: record.label }));
    console.log(`key (shown once): ${key}`);
  } else if (cmd === "revoke" && id) {
    console.log((await revokeKey(id)) ? `revoked ${id}` : `no key ${id}`);
  } else if (cmd === "show" && id) {
    const r = await getKeyRecord(id);
    console.log(r ? JSON.stringify({ ...r, hash: undefined }) : `no key ${id}`);
  } else {
    console.error("usage: issue --scopes read,build [--tier default|mm] [--label x] | revoke <keyId> | show <keyId>");
    process.exit(2);
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
