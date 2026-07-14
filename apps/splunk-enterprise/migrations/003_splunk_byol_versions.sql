-- Splunk Enterprise app — BYOL infrastructure, version catalog, and upgrade
-- tracking (app-owned).
--
-- These are Splunk-specific and now belong to the app. References to PLATFORM
-- entities (customer, cloud provider, initiating user) are plain UUID columns
-- with NO cross-boundary foreign key. The app/platform enforce those in code.
-- Foreign keys are used only BETWEEN the app's own tables. Everything is
-- `splunk_`-prefixed so it can never collide with a platform table.

-- --- Version catalog -------------------------------------------------------

CREATE TABLE IF NOT EXISTS splunk_version (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version       TEXT NOT NULL UNIQUE,
  release_date  TIMESTAMPTZ NOT NULL,
  download_url  TEXT,
  release_notes TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_latest     BOOLEAN NOT NULL DEFAULT false,
  features      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- BYOL infrastructure ---------------------------------------------------

CREATE TABLE IF NOT EXISTS splunk_byol_infrastructure (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  deployment_type      TEXT NOT NULL,
  environment_type     TEXT NOT NULL,
  indexer_count        INTEGER NOT NULL DEFAULT 1,
  search_head_count    INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'provisioning',
  customer_id          UUID NOT NULL,
  cloud_provider_id    UUID,
  github_deployment_id TEXT,
  hosting_type         TEXT NOT NULL DEFAULT 'kubernetes',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_byol_infrastructure_customer_idx ON splunk_byol_infrastructure(customer_id);

CREATE TABLE IF NOT EXISTS splunk_byol_indexer_region (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region            TEXT NOT NULL,
  infrastructure_id UUID NOT NULL REFERENCES splunk_byol_infrastructure(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_byol_indexer_region_infra_idx ON splunk_byol_indexer_region(infrastructure_id);

CREATE TABLE IF NOT EXISTS splunk_byol_search_head_region (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region            TEXT NOT NULL,
  infrastructure_id UUID NOT NULL REFERENCES splunk_byol_infrastructure(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_byol_search_head_region_infra_idx ON splunk_byol_search_head_region(infrastructure_id);

-- --- Upgrade tracking ------------------------------------------------------

CREATE TABLE IF NOT EXISTS splunk_upgrade (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id  UUID NOT NULL UNIQUE REFERENCES splunk_byol_infrastructure(id) ON DELETE CASCADE,
  current_version_id UUID NOT NULL REFERENCES splunk_version(id),
  last_upgraded_at   TIMESTAMPTZ,
  auto_upgrade       BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_upgrade_current_version_idx ON splunk_upgrade(current_version_id);

CREATE TABLE IF NOT EXISTS splunk_upgrade_operation (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  infrastructure_id    UUID NOT NULL REFERENCES splunk_byol_infrastructure(id) ON DELETE CASCADE,
  previous_version_id  UUID NOT NULL REFERENCES splunk_version(id),
  target_version_id    UUID NOT NULL REFERENCES splunk_version(id),
  status               TEXT NOT NULL DEFAULT 'PENDING',
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  scheduled_for        TIMESTAMPTZ,
  maintenance_window   TEXT,
  logs                 TEXT,
  error_message        TEXT,
  initiated_by_user_id UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_upgrade_operation_infra_idx ON splunk_upgrade_operation(infrastructure_id);
CREATE INDEX IF NOT EXISTS splunk_upgrade_operation_scheduled_idx ON splunk_upgrade_operation(scheduled_for);
