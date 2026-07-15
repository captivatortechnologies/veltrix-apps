-- BYOL end-to-end deployment tracking (app-owned).
--
-- These make the "deploy all necessary resources" surface real: the resource
-- plan derived from a BYOL infrastructure's topology is PERSISTED here on deploy,
-- and a deployment run + its ordered steps record how the environment came up.
-- Provisioning workers advance these rows via the app's onEvent/onWebhook hooks.
--
-- References to PLATFORM entities (customer) are plain UUID columns with NO
-- cross-boundary foreign key; FKs are used only BETWEEN the app's own tables.
-- Everything is `splunk_`-prefixed so it can never collide with a platform table.

-- --- Resources: one row per thing that must exist for the environment ---------

CREATE TABLE IF NOT EXISTS splunk_byol_resource (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id UUID NOT NULL REFERENCES splunk_byol_infrastructure(id) ON DELETE CASCADE,
  -- foundation | control-plane | data | search | ingest
  tier              TEXT NOT NULL,
  -- machine kind: network, load-balancer, license-manager, indexer, search-head, ...
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT,
  region            TEXT,
  -- not_started | provisioning | ready | attention | failed
  status            TEXT NOT NULL DEFAULT 'not_started',
  external_ref      TEXT,
  message           TEXT,
  -- stable identity from topology.buildByolResourcePlan() for idempotent re-seed
  -- and worker correlation.
  plan_key          TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  customer_id       UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS splunk_byol_resource_plan_key_idx
  ON splunk_byol_resource(infrastructure_id, plan_key);
CREATE INDEX IF NOT EXISTS splunk_byol_resource_infra_idx
  ON splunk_byol_resource(infrastructure_id);

-- --- Deployment runs: one row per deploy/destroy invocation -------------------

CREATE TABLE IF NOT EXISTS splunk_byol_deployment (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id UUID NOT NULL REFERENCES splunk_byol_infrastructure(id) ON DELETE CASCADE,
  -- deploy | destroy
  action            TEXT NOT NULL DEFAULT 'deploy',
  -- running | succeeded | failed | cancelled
  status            TEXT NOT NULL DEFAULT 'running',
  message           TEXT,
  initiated_by_user_id UUID,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_byol_deployment_infra_idx
  ON splunk_byol_deployment(infrastructure_id, started_at DESC);

-- --- Deployment steps: the ordered Activity timeline within a run -------------

CREATE TABLE IF NOT EXISTS splunk_byol_deployment_step (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES splunk_byol_deployment(id) ON DELETE CASCADE,
  step_order    INTEGER NOT NULL DEFAULT 0,
  step_key      TEXT NOT NULL,
  title         TEXT NOT NULL,
  -- pending | running | done | failed
  status        TEXT NOT NULL DEFAULT 'pending',
  detail        TEXT,
  logs          TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS splunk_byol_deployment_step_key_idx
  ON splunk_byol_deployment_step(deployment_id, step_key);
CREATE INDEX IF NOT EXISTS splunk_byol_deployment_step_order_idx
  ON splunk_byol_deployment_step(deployment_id, step_order);
