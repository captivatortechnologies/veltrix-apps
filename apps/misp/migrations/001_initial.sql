-- MISP App — Initial Migration
-- Core platform tables (Component, Deployment, Credential, …) live in the main
-- Prisma schema. This creates only app-specific extension tables (prefix misp_).

-- App-specific audit log for MISP operations.
CREATE TABLE IF NOT EXISTS misp_app_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL DEFAULT 'misp',
  customer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_misp_audit_customer ON misp_app_audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_misp_audit_created ON misp_app_audit_log(created_at DESC);
