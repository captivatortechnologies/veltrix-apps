-- Splunk Enterprise app — config default tables (app-owned).
--
-- The "index/role default configuration" tables were previously hardcoded in
-- the platform's central Prisma schema. They now belong to the app and are
-- created by the app on install. References to PLATFORM entities (customer,
-- user, tag) are plain UUID columns with NO cross-boundary foreign key — the
-- app enforces those relationships in code. Foreign keys are used only BETWEEN
-- the app's own tables.
--
-- Every object is prefixed `splunk_` (manifest database.tablePrefix), so it can
-- never collide with or clobber a platform table under shared isolation.
--
-- NOTE: BYOL / SplunkVersion / SplunkUpgrade tables stay in the platform schema
-- on purpose — they are consumed by platform provisioning services (rabbitmq,
-- webhooks, api-key scoping), not just by this app.

-- --- Index default configurations (user-created inheritance sources) --------

CREATE TABLE IF NOT EXISTS splunk_index_default (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  max_event_size     INTEGER NOT NULL DEFAULT 10000,
  enable_compression BOOLEAN NOT NULL DEFAULT true,
  retention_period   INTEGER NOT NULL DEFAULT 30,
  searchable_period  INTEGER NOT NULL DEFAULT 15,
  enable_tsidx       BOOLEAN NOT NULL DEFAULT true,
  frozen_time_period INTEGER NOT NULL DEFAULT 90,
  require_approval   BOOLEAN NOT NULL DEFAULT true,
  customer_id        UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_index_default_customer_idx ON splunk_index_default(customer_id);

CREATE TABLE IF NOT EXISTS splunk_index_default_env_tag (
  default_config_id UUID NOT NULL REFERENCES splunk_index_default(id) ON DELETE CASCADE,
  tag_id            UUID NOT NULL,
  PRIMARY KEY (default_config_id, tag_id)
);

CREATE TABLE IF NOT EXISTS splunk_index_default_approver (
  default_config_id UUID NOT NULL REFERENCES splunk_index_default(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL,
  PRIMARY KEY (default_config_id, user_id)
);

-- --- Role default configurations -------------------------------------------

CREATE TABLE IF NOT EXISTS splunk_role_default (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  description         TEXT,
  default_permissions TEXT[] NOT NULL DEFAULT '{}',
  require_approval     BOOLEAN NOT NULL DEFAULT true,
  customer_id         UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_role_default_customer_idx ON splunk_role_default(customer_id);

CREATE TABLE IF NOT EXISTS splunk_role_default_env_tag (
  default_config_id UUID NOT NULL REFERENCES splunk_role_default(id) ON DELETE CASCADE,
  tag_id            UUID NOT NULL,
  PRIMARY KEY (default_config_id, tag_id)
);

CREATE TABLE IF NOT EXISTS splunk_role_default_approver (
  default_config_id UUID NOT NULL REFERENCES splunk_role_default(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL,
  PRIMARY KEY (default_config_id, user_id)
);
