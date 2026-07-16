-- Splunk Enterprise App — BYOL deployment target (hosted vs BYOC).
--
-- Where + how an environment is provisioned, selected in the New BYOL form and
-- carried to the provisioning worker:
--   network_mode: shared (Veltrix-hosted) | dedicated | existing (BYOC)
--   dns_mode:     managed | delegated | private-only
--   cloud_account_connection_id: the customer's registered cloud account
--     (platform CloudAccountConnection) to deploy into — required for BYOC
--     (dedicated/existing); null for shared/hosted.

ALTER TABLE splunk_byol_infrastructure
  ADD COLUMN IF NOT EXISTS network_mode TEXT NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS dns_mode TEXT NOT NULL DEFAULT 'managed',
  ADD COLUMN IF NOT EXISTS cloud_account_connection_id UUID;
