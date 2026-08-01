-- SonarQube App — BYOL usage metering (app-owned).
--
-- Foundation for usage-based cloud billing, billed separately from the flat
-- platform subscription. Two tables:
--   * sonarqube_byol_state_event — append-only lifecycle state log. `status` on
--     sonarqube_byol_infrastructure is overwritten in place, so this log is what
--     makes node-HOURS (running duration × node count) reconstructable. Its
--     infrastructure_id is a plain UUID with NO foreign key, so a terminal
--     'decommissioned' event survives the infrastructure row's deletion for
--     billing history.
--   * sonarqube_byol_usage — the daily metered ledger (node_hours + ingest_gb),
--     one idempotent row per (infrastructure, dimension, day).
--
-- sonarqube_-prefixed and app-owned. References to platform entities (customer) are
-- plain UUID columns with NO cross-boundary foreign key, matching 002_sonarqube_byol.sql.

-- --- Lifecycle state event log (enables node-hours) --------------------------

CREATE TABLE IF NOT EXISTS sonarqube_byol_state_event (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id UUID NOT NULL,
  customer_id       UUID NOT NULL,
  status            TEXT NOT NULL,
  node_count        INTEGER NOT NULL DEFAULT 0,   -- stack nodes at the transition
  at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sonarqube_byol_state_event_infra_at_idx
  ON sonarqube_byol_state_event(infrastructure_id, at);
CREATE INDEX IF NOT EXISTS sonarqube_byol_state_event_customer_idx
  ON sonarqube_byol_state_event(customer_id);

-- --- Daily metered usage ledger ----------------------------------------------

CREATE TABLE IF NOT EXISTS sonarqube_byol_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id UUID NOT NULL,
  customer_id       UUID NOT NULL,
  dimension         TEXT NOT NULL,                 -- 'node_hours' | 'ingest_gb'
  quantity          NUMERIC(14,4) NOT NULL DEFAULT 0,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  source            TEXT NOT NULL DEFAULT 'collector',
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per infra × dimension × day so the collector is idempotent
  -- (re-running a date upserts, never double-counts).
  CONSTRAINT sonarqube_byol_usage_unique UNIQUE (infrastructure_id, dimension, period_start)
);

CREATE INDEX IF NOT EXISTS sonarqube_byol_usage_customer_period_idx
  ON sonarqube_byol_usage(customer_id, period_start);
