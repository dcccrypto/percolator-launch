# Bot API uptime check: how to run it

`app/scripts/bot-api/uptime.ts` checks one deployment of `/api/v1`: `GET /health`, the keyed check
(`GET /metrics`), `GET /markets` (fails on an empty list), and one `GET /markets/{market}`. It prints one line per check
and exits 1 when any fails (non-200, a `degraded` health, a timeout, slower than `--max-ms`, or a stale oracle with
`--fail-on-stale`).

Nothing is scheduled by this repo. Scheduling it, where it runs, and who gets told when it fails are ops decisions for
the owner; this page only shows how.

## The key

Reads need a key unless the deployment set `BOT_API_ANON_READS=1` (off by default), and the keyed check needs `ops`.
So issue one key with both scopes for the uptime check, against the deployment's key store:

    cd app && npx tsx scripts/bot-api/keys.ts issue --scopes read,ops --label uptime

Pass it only through the `UPTIME_API_KEY` environment variable (the script never takes it as an argument). A key with
only `ops` makes health fail with 403 `forbidden_scope`.

On a deployment behind the playground waitlist, `/api/v1` is only reachable without a waitlist session when the
deployment set `BOT_API_GATE_EXEMPT=1` (a pending owner decision, off by default). Without it the check gets the
gate's 401 and fails: run it against a deployment without the gate, or after the owner decides.

## Run it once

    cd app
    UPTIME_API_KEY=... pnpm bot-api:uptime --base https://<deployment> --max-ms 3000

(`pnpm bot-api:uptime` is `tsx scripts/bot-api/uptime.ts`; `--market ADDR`, `--timeout-ms N` and `--fail-on-stale` are
optional.) Set the variable in your own shell session, not in a file you commit.

## Run it every minute on a Mac (launchd)

`ops/bot-api/uptime.plist.example` is a template. It reads the key from the macOS keychain at run time, so the plist
holds no key.

1. Store the key: `security add-generic-password -s percolator-bot-api-uptime -a uptime -w` (it prompts).
2. Copy the template to `~/Library/LaunchAgents/trade.percolator.bot-api-uptime.plist` and replace `__REPO__`,
   `__BASE_URL__` and `__LOG_DIR__`.
3. Check it: `plutil -lint ~/Library/LaunchAgents/trade.percolator.bot-api-uptime.plist`.
4. Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/trade.percolator.bot-api-uptime.plist`.
5. Watch `__LOG_DIR__/bot-api-uptime.log`; `launchctl print gui/$(id -u)/trade.percolator.bot-api-uptime` shows the
   last exit status.
6. Stop it: `launchctl bootout gui/$(id -u)/trade.percolator.bot-api-uptime`.

Alerting is not included: the job only logs and exits non-zero. Hook the exit status or the log to whatever pages the
owner (a cron wrapper that mails on failure, a log watcher) when that is decided.

## Limits

- `/v1/metrics` counters are per serverless instance on Vercel; a scrape sees one instance.
- `/v1/health` reports this instance's key-store breaker state; a fresh instance during an Upstash outage can report ok
  until a keyed request trips it. The keyed check is what catches that.
