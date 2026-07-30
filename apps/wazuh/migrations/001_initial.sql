-- Wazuh App — Initial Migration
-- Core platform tables (Component, Deployment, Credential, …) live in the main
-- Prisma schema. This creates only app-specific extension tables (prefix wazuh_).

-- App-specific audit log for Wazuh operations.
CREATE TABLE IF NOT EXISTS wazuh_app_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL DEFAULT 'wazuh',
  customer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wazuh_audit_customer ON wazuh_app_audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_wazuh_audit_created ON wazuh_app_audit_log(created_at DESC);
