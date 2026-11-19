#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

CONTAINER="perc-k01-pg"
DB="k02_regression_${BASHPID}_${RANDOM}"
CREATED=0

M1="supabase/migrations/20260402170000_exclude_indexer_excluded_from_view.sql"
M2="supabase/migrations/20260402171000_add_market_status_column.sql"
PATCH="supabase/migrations/20261118010000_fix_market_stats_network_join.sql"
TEST="supabase/tests/k02_network_stats_isolation.sql"

cleanup() {
  rc=$?
  trap - EXIT
  if [[ "$CREATED" == 1 ]]; then
    if ! docker exec "$CONTAINER" dropdb -U k01 "$DB"; then
      echo "ERROR: disposable DB cleanup failed: $DB"
      rc=1
    else
      echo "K02_DATABASE_CLEANUP_PASS"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

# The existing authorized local test container only.
if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
  echo "STOP: local PostgreSQL container unavailable"
  exit 1
fi

for file in "$M1" "$M2" "$PATCH" "$TEST"; do
  test -s "$file" || {
    echo "Missing required file: $file"
    exit 1
  }
done

echo "=== CREATE DISPOSABLE DATABASE ==="
docker exec "$CONTAINER" createdb -U k01 "$DB"
CREATED=1

# Minimal test-only schema.
# Numeric placeholders cover columns selected by
# historical views. Not production schema parity.
docker exec -i "$CONTAINER" \
  psql -X -U k01 -d "$DB" \
  -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.markets (
  slab_address TEXT NOT NULL,
  network TEXT NOT NULL,
  mint_address TEXT NOT NULL,
  deployer TEXT NOT NULL,
  indexer_excluded BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (slab_address, network)
);

CREATE TABLE public.market_stats (
  slab_address TEXT NOT NULL,
  network TEXT NOT NULL,
  last_price NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (slab_address, network),
  FOREIGN KEY (slab_address, network)
    REFERENCES public.markets(slab_address, network)
);
SQL

# Supply historical view projection columns.
while IFS= read -r col; do
  case "$col" in
    slab_address|network|last_price|updated_at)
      continue ;;
  esac
  printf \
    'ALTER TABLE public.market_stats ADD COLUMN IF NOT EXISTS %s NUMERIC;\n' \
    "$col"
done < <(
  grep -ohE 's\.[a-z_][a-z0-9_]*' "$M1" "$M2" |
    sed 's/^s\.//' | LC_ALL=C sort -u
) | docker exec -i "$CONTAINER" \
  psql -X -U k01 -d "$DB" -v ON_ERROR_STOP=1 -q

echo "=== APPLY HISTORICAL MIGRATIONS ==="

for migration in "$M1" "$M2"; do
  docker exec -i "$CONTAINER" \
    psql -X -U k01 -d "$DB" -v ON_ERROR_STOP=1 \
    < "$migration" > /dev/null
done

echo "=== VERIFY EXPECTED RED ==="

docker exec -i "$CONTAINER" \
  psql -X -U k01 -d "$DB" \
  -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

INSERT INTO public.markets (
  slab_address, network, mint_address, deployer
)
VALUES
 ('K02_RED','devnet','TEST_MINT','alice'),
 ('K02_RED','mainnet','TEST_MINT','bob');

INSERT INTO public.market_stats (
  slab_address, network, last_price
)
VALUES
 ('K02_RED','devnet',111),
 ('K02_RED','mainnet',999);

DO $red$
DECLARE
  total_rows integer;
  contaminated integer;
BEGIN
  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE last_price = 999)
  INTO total_rows, contaminated
  FROM public.markets_with_stats
  WHERE slab_address = 'K02_RED'
    AND network = 'devnet';

  IF total_rows <> 2 OR contaminated <> 1 THEN
    RAISE EXCEPTION
      'RED reproduction mismatch: %, %',
      total_rows, contaminated;
  END IF;

  RAISE NOTICE 'K02_STANDALONE_RED_CONFIRMED';
END;
$red$;

ROLLBACK;
SQL

echo "=== APPLY K02 PATCH ==="

docker exec -i "$CONTAINER" \
  psql -X -U k01 -d "$DB" -v ON_ERROR_STOP=1 \
  < "$PATCH"

echo "=== RUN VERSIONED REGRESSION ==="

docker exec -i "$CONTAINER" \
  psql -X -U k01 -d "$DB" -v ON_ERROR_STOP=1 \
  < "$TEST"

echo "K02_STANDALONE_GREEN_PASS"
