-- Splunk Enterprise app — recorded Splunk Enterprise license files (app-owned).
--
-- A Splunk license is an XML document (the `.lic` file) describing an
-- entitlement: its stack, daily indexing quota (bytes), validity window, and
-- enabled features. Operators paste or upload the XML on the License page; the
-- server parses it (see lib/licenseXml.ts) and records the extracted fields here
-- so expiration/quota/status are tracked WITHOUT needing a live Splunk
-- connection. When a working Connection exists the page ALSO live-pulls
-- /services/licenser/licenses for real-time stack usage (see lib/liveLicense.ts).
--
-- Tenant-scoped by customer_id — a plain UUID referencing the platform Customer
-- with NO cross-boundary foreign key, matching the app's other tables (FKs are
-- used only BETWEEN the app's own tables). Everything is `splunk_`-prefixed
-- (manifest database.tablePrefix) so it can never collide with a platform table.

CREATE TABLE IF NOT EXISTS splunk_licenses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL,
  -- Human-readable label from the license payload.
  label            TEXT,
  -- License kind (enterprise | free | forwarder | ...), from <type>.
  license_type     TEXT,
  -- License group (Enterprise | Trial | ...), from <group_id>.
  group_id         TEXT,
  -- Licensing stack, from <stack_id>.
  stack_id         TEXT,
  -- Daily indexing volume entitlement in BYTES (can exceed 2^31 → BIGINT).
  quota_bytes      BIGINT,
  -- Rolling usage window in days, from <window_period>.
  window_period    INTEGER,
  -- Allowed quota violations within the window before enforcement.
  max_violations   INTEGER,
  -- Issue / expiry timestamps (converted from the payload's unix epochs).
  creation_time    TIMESTAMPTZ,
  expiration_time  TIMESTAMPTZ,
  -- Stable license identity — the dedupe/upsert key.
  guid             TEXT NOT NULL,
  -- Enabled feature flags, from <features><feature>…</feature></features>.
  features         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The original license XML, retained for re-download / audit.
  raw_xml          TEXT NOT NULL,
  -- Initiating platform user id (nullable), no cross-boundary FK.
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS splunk_licenses_customer_idx
  ON splunk_licenses(customer_id);

-- A license's guid is its stable identity; re-recording the same license upserts
-- on this key rather than creating a duplicate (see lib/db/licenses.ts).
CREATE UNIQUE INDEX IF NOT EXISTS splunk_licenses_customer_guid_idx
  ON splunk_licenses(customer_id, guid);
