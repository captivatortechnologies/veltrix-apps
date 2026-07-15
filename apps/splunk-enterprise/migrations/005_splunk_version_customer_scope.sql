-- 005_splunk_version_customer_scope.sql
-- Scope the Splunk version catalog by owner.
--   * customer_id IS NULL  -> a SYSTEM version (seeded release lines or system
--     uploads) that is visible to every tenant.
--   * customer_id = <uuid> -> a COMPANY-owned version, visible only to that
--     tenant.
-- A tenant sees system + its own versions and may only edit/delete its own.

ALTER TABLE splunk_version ADD COLUMN IF NOT EXISTS customer_id UUID;

-- Replace the global UNIQUE(version) with scope-aware partial unique indexes so
-- the same version string can exist once at the system level and once per tenant.
ALTER TABLE splunk_version DROP CONSTRAINT IF EXISTS splunk_version_version_key;

CREATE UNIQUE INDEX IF NOT EXISTS splunk_version_system_version_uniq
  ON splunk_version (version)
  WHERE customer_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS splunk_version_customer_version_uniq
  ON splunk_version (customer_id, version)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS splunk_version_customer_idx
  ON splunk_version (customer_id);
