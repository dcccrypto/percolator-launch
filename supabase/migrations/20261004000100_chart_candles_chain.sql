-- One-time on-chain backfill of MARK candles (PushAuthMark txs): allow src='chain' and keep a
-- resumable progress row. Additive and idempotent.

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.chart_candles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%src%'
  LOOP
    EXECUTE format('ALTER TABLE public.chart_candles DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.chart_candles
    ADD CONSTRAINT chart_candles_src_check CHECK (src IN ('live', 'gecko', 'chain'));
END $$;

-- Resumable cursor + the forming candles carried across batches, so a restart continues exactly.
CREATE TABLE IF NOT EXISTS public.chart_chain_backfill (
  id          text        PRIMARY KEY,
  cursor_slot bigint      NOT NULL DEFAULT 0,
  cursor_sig  text,
  processed   integer     NOT NULL DEFAULT 0,
  pushes      bigint      NOT NULL DEFAULT 0,
  state       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  done        boolean     NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.chart_chain_backfill ENABLE ROW LEVEL SECURITY;
