-- Fleet App — Initial Migration
-- Core platform tables (Component, Deployment, Credential, …) live in the main
-- Prisma schema. This creates only app-specific extension tables (prefix fleet_).

-- App-specific audit log for Fleet operations.
CREATE TABLE IF NOT EXISTS fleet_app_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL DEFAULT 'fleet',
  customer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fleet_audit_customer ON fleet_app_audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_fleet_audit_created ON fleet_app_audit_log(created_at DESC);
