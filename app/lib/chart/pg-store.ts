/**
 * Lazily-created Postgres candle store from env. Works in the Next route handlers and in the
 * price-ws script (both run under Node with the `postgres` package the app already depends on).
 *
 * The Supabase pooler (port 6543) is transaction-mode: prepared statements are not supported,
 * so `prepare: false` is required.
 */
import postgres from "postgres";
import { createPgCandleStore, type CandleStore, type SqlLike } from "./candle-store";

const stores = new Map<string, CandleStore>();
const sqls = new Map<string, SqlLike>();

export function candlesDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const u = (env.CANDLES_DATABASE_URL ?? env.INDEXER_DATABASE_URL ?? "").trim();
  return u.length > 0 ? u : null;
}

/** The shared pooled client (created once per URL). */
export function getPgSql(env: Record<string, string | undefined> = process.env, max = 3): SqlLike | null {
  const url = candlesDatabaseUrl(env);
  if (!url) return null;
  let sql = sqls.get(url);
  if (!sql) {
    sql = postgres(url, {
      max,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
      onnotice: () => {},
    }) as unknown as SqlLike;
    sqls.set(url, sql);
  }
  return sql;
}

export function getPgCandleStore(env: Record<string, string | undefined> = process.env, max = 3): CandleStore | null {
  const sql = getPgSql(env, max);
  const url = candlesDatabaseUrl(env);
  if (!sql || !url) return null;
  let s = stores.get(url);
  if (!s) {
    s = createPgCandleStore(sql);
    stores.set(url, s);
  }
  return s;
}
