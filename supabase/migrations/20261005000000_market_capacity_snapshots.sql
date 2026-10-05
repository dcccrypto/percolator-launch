-- Growth telemetry (devnet-v2-growth-plan-2026-10-04 §2.11): one row per growth market per ~5 min,
-- written by the oracle keeper's capacity snapshotter (KEEPER_CAPACITY_SNAPSHOTS=1) and read by the
-- /growth page via /api/v21/capacity (service role). NOT APPLIED: apply by hand before the keeper flag
-- is turned on. Additive and idempotent.
--
-- Same convention as chart_candles: RLS is enabled with NO policies, so PostgREST anon / authenticated
-- can neither read nor write it; only the service role (keeper writer, app server route) can.
--
-- Units: *_atoms are collateral atoms (sim-USDC, 6 dp); *_q are engine position units; *_bps are basis
-- points; *_x100 is leverage times 100 (1000 = 10.00x); price_e6 is the engine effective price.
-- Only markets that are bound to a vault LP AND carry an AssetGrowthV19 record are snapshotted, so a
-- legacy market never has a row.

CREATE TABLE IF NOT EXISTS public.market_capacity_snapshots (
  slab                        text         NOT NULL,
  asset_index                 smallint     NOT NULL DEFAULT 0,
  ts                          timestamptz  NOT NULL DEFAULT now(),
  slot                        bigint       NOT NULL,
  price_e6                    numeric      NOT NULL,

  -- Earn (senior side of the vault LP)
  earn_principal_atoms        numeric      NOT NULL,
  -- claim-adjusted: principal minus the outstanding senior draw, clamped at 0 (an approximation of what a
  -- senior could redeem while a draw is unpaid)
  earn_nav_atoms              numeric      NOT NULL,
  earn_shares                 numeric      NOT NULL,
  -- earn_nav_atoms / earn_shares, 9 dp; NULL when no shares are outstanding
  nav_per_share               numeric,
  allocated_atoms             numeric      NOT NULL DEFAULT 0,  -- tag 103: Earn principal moved into LP capital
  junior_atoms                numeric      NOT NULL DEFAULT 0,  -- team/creator tranche (deposited - withdrawn)
  cushion_atoms               numeric      NOT NULL DEFAULT 0,  -- G6 fee cushion accrued
  draw_outstanding_atoms      numeric      NOT NULL DEFAULT 0,  -- senior draw not yet repaid

  -- Capacity
  lp_equity_atoms             numeric      NOT NULL,            -- C_m (includes allocated Earn)
  n_cap_q                     numeric,                          -- NULL = capacity unreadable (price 0 / overflow)
  capacity_notional_atoms     numeric,                          -- n_cap_q * price_e6 / POS_SCALE
  u_long_bps                  integer,                          -- users-side OI / N_cap, long
  u_short_bps                 integer,
  imr_dyn_long_bps            integer,                          -- NULL when the side is closed
  imr_dyn_short_bps           integer,
  l_ceil_x100                 integer      NOT NULL,
  max_leverage_long_x100      integer      NOT NULL,            -- 0 when closed to new risk
  max_leverage_short_x100     integer      NOT NULL,
  long_closed                 boolean      NOT NULL DEFAULT false,
  short_closed                boolean      NOT NULL DEFAULT false,
  long_closed_reason          text,
  short_closed_reason         text,

  -- Book
  oi_long_q                   numeric      NOT NULL,
  oi_short_q                  numeric      NOT NULL,
  lp_net_q                    numeric      NOT NULL,            -- vault LP ADL-effective net (+ long)
  max_abs_funding_e9_per_slot numeric      NOT NULL,
  fee_income_atoms            numeric      NOT NULL,            -- LP fee accrued to date
  insurance_atoms             numeric      NOT NULL,
  credit_rate_bps             integer,                          -- NOT captured yet (NULL)
  adl_active                  boolean      NOT NULL DEFAULT false,
  hlock_active                boolean      NOT NULL DEFAULT false,

  PRIMARY KEY (slab, ts)
);

CREATE INDEX IF NOT EXISTS market_capacity_snapshots_slab_ts_idx
  ON public.market_capacity_snapshots (slab, ts DESC);
CREATE INDEX IF NOT EXISTS market_capacity_snapshots_ts_idx
  ON public.market_capacity_snapshots (ts);

ALTER TABLE public.market_capacity_snapshots ENABLE ROW LEVEL SECURITY;

-- RETENTION: at 5 min x 40 markets this is about 11.5k rows/day. Keep 30 days at full resolution; prune with
--   DELETE FROM public.market_capacity_snapshots WHERE ts < now() - interval '30 days';
-- (run daily from a scheduled job; the ts index serves it). Nothing in this migration schedules it.
