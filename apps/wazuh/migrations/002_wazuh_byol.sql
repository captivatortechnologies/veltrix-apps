-- Wazuh App — BYOL cluster infrastructure + end-to-end deployment tracking
-- (app-owned).
--
-- These make the "deploy all necessary resources" surface real: a BYOL Wazuh
-- cluster, the region satellites its data/worker tiers may spread across, the
-- resource plan derived from the cluster's topology (PERSISTED on deploy), and a
-- deployment run + its ordered steps recording how the cluster came up.
-- Provisioning workers advance these rows via the app's onEvent/onWebhook hooks.
--
-- References to PLATFORM entities (customer, cloud provider, cloud account,
-- initiating user) are plain UUID columns with NO cross-boundary foreign key;
-- foreign keys are used only BETWEEN the app's own tables. Everything is
-- `wazuh_`-prefixed so it can never collide with a platform table. This migration
-- is a self-contained CREATE with every column present from the start (adapted
-- from Security Onion's consolidated byol migration).

-- --- BYOL infrastructure -----------------------------------------------------

CREATE TABLE IF NOT EXISTS wazuh_byol_infrastructure (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  -- 'single' (all-in-one node) | 'distributed' (full cluster)
  deployment_type             TEXT NOT NULL,
  environment_type            TEXT NOT NULL,
  -- Wazuh indexer (OpenSearch) node count; manager-worker (control-plane) count.
  indexer_count               INTEGER NOT NULL DEFAULT 1,
  search_head_count           INTEGER NOT NULL DEFAULT 1,
  -- not_started | provisioning | running | stopped | destroying | ...
  status                      TEXT NOT NULL DEFAULT 'not_started',
  customer_id                 UUID NOT NULL,
  cloud_provider_id           UUID,
  -- Provider display name, or "Self-Hosted".
  hosting_type                TEXT NOT NULL DEFAULT '',
  -- Cloud region (distributed cloud deployments only).
  region                      TEXT,
  -- Deployment target (hosted vs BYOC).
  network_mode                TEXT NOT NULL DEFAULT 'shared',   -- shared | dedicated | existing
  dns_mode                    TEXT NOT NULL DEFAULT 'managed',  -- managed | delegated | private-only
  cloud_account_connection_id UUID,
  -- Topology authoring.
  control_plane_layout        TEXT NOT NULL DEFAULT 'dedicated',-- dedicated | consolidated | single
  heavy_forwarder_count       INTEGER NOT NULL DEFAULT 1,       -- dashboard node count
  indexer_placement           JSONB,   -- data-tier (indexer) multi-site placement
  search_head_placement       JSONB,   -- control-plane (manager-worker) multi-site placement
  -- Compute size applied to every node; NULL = cloud default.
  instance_type               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazuh_byol_infrastructure_customer_idx
  ON wazuh_byol_infrastructure(customer_id);

-- --- Region satellites (legacy per-node region round-robin) -------------------

CREATE TABLE IF NOT EXISTS wazuh_byol_indexer_region (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region            TEXT NOT NULL,
  infrastructure_id UUID NOT NULL REFERENCES wazuh_byol_infrastructure(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazuh_byol_indexer_region_infra_idx
  ON wazuh_byol_indexer_region(infrastructure_id);

CREATE TABLE IF NOT EXISTS wazuh_byol_search_head_region (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region            TEXT NOT NULL,
  infrastructure_id UUID NOT NULL REFERENCES wazuh_byol_infrastructure(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazuh_byol_search_head_region_infra_idx
  ON wazuh_byol_search_head_region(infrastructure_id);

-- --- Resources: one row per thing that must exist for the cluster --------------

CREATE TABLE IF NOT EXISTS wazuh_byol_resource (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id UUID NOT NULL REFERENCES wazuh_byol_infrastructure(id) ON DELETE CASCADE,
  -- foundation | control-plane | data | dashboard
  tier              TEXT NOT NULL,
  -- machine kind: network, load-balancer, manager-master, manager-worker, indexer, dashboard, ...
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT,
  region            TEXT,
  -- availability zone within `region` for a multi-AZ-placed node.
  zone              TEXT,
  -- machine roles a node runs (e.g. an all-in-one standalone).
  roles             JSONB,
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

CREATE UNIQUE INDEX IF NOT EXISTS wazuh_byol_resource_plan_key_idx
  ON wazuh_byol_resource(infrastructure_id, plan_key);
CREATE INDEX IF NOT EXISTS wazuh_byol_resource_infra_idx
  ON wazuh_byol_resource(infrastructure_id);

-- --- Deployment runs: one row per deploy/destroy invocation -------------------

CREATE TABLE IF NOT EXISTS wazuh_byol_deployment (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id    UUID NOT NULL REFERENCES wazuh_byol_infrastructure(id) ON DELETE CASCADE,
  -- deploy | destroy
  action               TEXT NOT NULL DEFAULT 'deploy',
  -- running | succeeded | failed | cancelled
  status               TEXT NOT NULL DEFAULT 'running',
  message              TEXT,
  initiated_by_user_id UUID,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazuh_byol_deployment_infra_idx
  ON wazuh_byol_deployment(infrastructure_id, started_at DESC);

-- --- Deployment steps: the ordered Activity timeline within a run -------------

CREATE TABLE IF NOT EXISTS wazuh_byol_deployment_step (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES wazuh_byol_deployment(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX IF NOT EXISTS wazuh_byol_deployment_step_key_idx
  ON wazuh_byol_deployment_step(deployment_id, step_key);
CREATE INDEX IF NOT EXISTS wazuh_byol_deployment_step_order_idx
  ON wazuh_byol_deployment_step(deployment_id, step_order);
