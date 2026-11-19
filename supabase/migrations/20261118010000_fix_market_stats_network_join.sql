-- K-02: Restore network-scoped market statistics.
-- Fail closed on unexpected view structures.
-- Intended for migration-owner execution only.

DO $repair$
DECLARE
  old_definition text;
  new_definition text;
  join_prefix text;
  equality_pattern text;
  legacy_pattern text;
  fixed_pattern text;
  legacy_count integer;
  fixed_count integer;
BEGIN
  IF to_regclass('public.markets_with_stats') IS NULL THEN
    RAISE EXCEPTION 'K02: markets_with_stats view missing';
  END IF;

  old_definition :=
    pg_get_viewdef('public.markets_with_stats'::regclass, true);

  -- Restrict rewriting to the known simple LEFT JOIN form.
  -- Any extra ON predicate must fail the structural check.
  join_prefix :=
    'LEFT[[:space:]]+JOIN[[:space:]]+' ||
    '(public[.])?market_stats[[:space:]]+s' ||
    '[[:space:]]+ON[[:space:]]+';

  equality_pattern :=
    'm[.]network[[:space:]]*=[[:space:]]*s[.]network';

  legacy_pattern :=
    '(' || join_prefix ||
    'm[.]slab_address[[:space:]]*=' ||
    '[[:space:]]*s[.]slab_address)' ||
    '([[:space:]]+WHERE[[:space:]]+)';

  fixed_pattern :=
    join_prefix ||
    'm[.]slab_address[[:space:]]*=' ||
    '[[:space:]]*s[.]slab_address' ||
    '[[:space:]]+AND[[:space:]]+' ||
    equality_pattern ||
    '[[:space:]]+WHERE[[:space:]]+';

  SELECT COUNT(*) INTO legacy_count
  FROM regexp_matches(old_definition, legacy_pattern, 'gi');

  SELECT COUNT(*) INTO fixed_count
  FROM regexp_matches(old_definition, fixed_pattern, 'gi');

  -- Idempotency: exactly one recognized fixed JOIN.
  IF fixed_count = 1 AND legacy_count = 0 THEN
    RAISE NOTICE 'K02_ALREADY_NETWORK_SCOPED';
    RETURN;
  END IF;

  -- Reject unknown structures, including a network predicate
  -- occurring elsewhere rather than on the target JOIN.
  IF legacy_count <> 1
     OR fixed_count <> 0
     OR old_definition ~* equality_pattern
  THEN
    RAISE EXCEPTION
      'K02: unexpected market_stats JOIN structure (legacy %, fixed %)',
      legacy_count, fixed_count;
  END IF;

  new_definition := regexp_replace(
    old_definition,
    legacy_pattern,
    '\1 AND m.network = s.network\3',
    'i'
  );

  IF new_definition = old_definition THEN
    RAISE EXCEPTION 'K02: rewrite made no change';
  END IF;

  SELECT COUNT(*) INTO fixed_count
  FROM regexp_matches(new_definition, fixed_pattern, 'gi');

  IF fixed_count <> 1 THEN
    RAISE EXCEPTION 'K02: rewritten JOIN validation failed';
  END IF;

  EXECUTE
    'CREATE OR REPLACE VIEW public.markets_with_stats AS '
    || new_definition;

  RAISE NOTICE 'K02_NETWORK_SCOPED_VIEW_APPLIED';
END;
$repair$;

NOTIFY pgrst, 'reload schema';
