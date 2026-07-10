-- Splunk Enterprise App - Initial Migration
-- Note: The core Splunk tables already exist in the main Prisma schema.
-- This migration creates any app-specific extension tables.

-- App-specific audit log for Splunk operations
CREATE TABLE IF NOT EXISTS splunk_app_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL DEFAULT 'splunk-enterprise',
  customer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_splunk_audit_customer ON splunk_app_audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_splunk_audit_created ON splunk_app_audit_log(created_at DESC);

-- Splunk deployment tracking (app-specific metadata beyond core Deployment table)
CREATE TABLE IF NOT EXISTS splunk_deployment_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id TEXT NOT NULL,
  config_type TEXT NOT NULL,
  target_conf_file TEXT,
  restart_required BOOLEAN DEFAULT false,
  cluster_bundle_push BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_splunk_deploy_meta ON splunk_deployment_metadata(deployment_id);
