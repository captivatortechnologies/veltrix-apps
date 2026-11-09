-- Durable dispatch and run correlation. Existing history is retained.
ALTER TABLE splunk_byol_infrastructure ADD COLUMN IF NOT EXISTS active_deployment_id UUID;
ALTER TABLE splunk_byol_infrastructure ADD COLUMN IF NOT EXISTS applied_configuration JSONB;
ALTER TABLE splunk_byol_deployment ADD COLUMN IF NOT EXISTS command_payload JSONB;
ALTER TABLE splunk_byol_deployment ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE splunk_byol_deployment ADD COLUMN IF NOT EXISTS customer_id UUID;
UPDATE splunk_byol_deployment d SET customer_id = i.customer_id
FROM splunk_byol_infrastructure i WHERE d.infrastructure_id = i.id AND d.customer_id IS NULL;
ALTER TABLE splunk_byol_deployment ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE splunk_byol_deployment_step ADD COLUMN IF NOT EXISTS customer_id UUID;
UPDATE splunk_byol_deployment_step s SET customer_id = d.customer_id
FROM splunk_byol_deployment d WHERE s.deployment_id = d.id AND s.customer_id IS NULL;
ALTER TABLE splunk_byol_deployment_step ALTER COLUMN customer_id SET NOT NULL;
-- Legacy running runs cannot be safely auto-cancelled: a cloud apply may still be executing.
UPDATE splunk_byol_infrastructure i SET active_deployment_id = d.id
FROM (SELECT DISTINCT ON (infrastructure_id) id, infrastructure_id FROM splunk_byol_deployment
      WHERE status = 'running' ORDER BY infrastructure_id, started_at DESC, id DESC) d
WHERE i.id = d.infrastructure_id AND i.active_deployment_id IS NULL;
CREATE INDEX IF NOT EXISTS splunk_byol_dispatch_pending_idx ON splunk_byol_deployment(dispatched_at)
WHERE command_payload IS NOT NULL AND status = 'running';
