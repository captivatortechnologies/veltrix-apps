-- splunk_deployment_metadata was created in 001 without a tenant column: the
-- platform's tenant-partition check now requires every app table to carry
-- customer_id (or hang off another app table by foreign key). The table is
-- not written by the app today; the column is added so the app loads on a
-- fresh database and any future writes are tenant-scoped.
ALTER TABLE splunk_deployment_metadata ADD COLUMN IF NOT EXISTS customer_id UUID;

CREATE INDEX IF NOT EXISTS idx_splunk_deployment_metadata_customer
  ON splunk_deployment_metadata (customer_id);
