-- Splunk Enterprise app — add the cloud region to BYOL infrastructure.
--
-- The region a distributed cloud deployment is provisioned in. Empty for
-- Self-Hosted providers and for single-instance deployments (region only
-- applies when a cloud provider is chosen with a distributed topology).
ALTER TABLE splunk_byol_infrastructure ADD COLUMN IF NOT EXISTS region TEXT;
