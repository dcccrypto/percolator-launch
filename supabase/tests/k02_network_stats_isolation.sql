BEGIN;

DO $guard$
BEGIN
  IF current_database() NOT LIKE 'k02_regression_%' THEN
    RAISE EXCEPTION 'K02 test requires isolated fixture';
  END IF;
END;
$guard$;

INSERT INTO public.markets (
  slab_address, network, mint_address,
  deployer, indexer_excluded, status
)
VALUES
  ('K02_REPO_TEST','devnet','TEST_MINT','alice',false,'active'),
  ('K02_REPO_TEST','mainnet','TEST_MINT','bob',false,'active'),
  ('K02_REPO_HIDDEN','devnet','TEST_MINT','alice',true,'active'),
  ('K02_REPO_CLOSED','devnet','TEST_MINT','alice',false,'closed');

INSERT INTO public.market_stats (
  slab_address, network, last_price
)
VALUES
  ('K02_REPO_TEST','devnet',111),
  ('K02_REPO_TEST','mainnet',999);

DO $test$
DECLARE
  total_rows integer;
  wrong_rows integer;
BEGIN
  SELECT COUNT(*),
    COUNT(*) FILTER (
      WHERE
        (network='devnet' AND last_price IS DISTINCT FROM 111)
        OR
        (network='mainnet' AND last_price IS DISTINCT FROM 999)
    )
  INTO total_rows, wrong_rows
  FROM public.markets_with_stats
  WHERE slab_address='K02_REPO_TEST';

  IF total_rows <> 2 OR wrong_rows <> 0 THEN
    RAISE EXCEPTION
      'Network isolation failed: total %, wrong %',
      total_rows, wrong_rows;
  END IF;

  RAISE NOTICE 'K02_REPO_NETWORK_ISOLATION_PASS';

  IF EXISTS (
    SELECT 1 FROM public.markets_with_stats
    WHERE slab_address IN ('K02_REPO_HIDDEN','K02_REPO_CLOSED')
  ) THEN
    RAISE EXCEPTION 'Existing view filters changed';
  END IF;

  RAISE NOTICE 'K02_REPO_FILTERS_PASS';
END;
$test$;

ROLLBACK;
