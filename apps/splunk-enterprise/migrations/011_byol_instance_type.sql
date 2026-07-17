-- Splunk Enterprise App — BYOL compute size (instance type).
--
--   instance_type: the cloud compute size applied to every provisioned node
--     (e.g. AWS t2.medium, Azure Standard_B2s, GCP e2-medium, Hetzner cx22).
--     NULL means "use the cloud default" (the OpenTofu module default, which is
--     a ~2 vCPU / 4 GB t2.medium-class size per cloud). Customer-selectable in
--     the New/Edit BYOL form.

ALTER TABLE splunk_byol_infrastructure
  ADD COLUMN IF NOT EXISTS instance_type TEXT;
