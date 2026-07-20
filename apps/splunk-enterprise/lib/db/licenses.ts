// =============================================================================
// Recorded Splunk licenses — raw-SQL access to the app-owned `splunk_licenses`
// table (migration 013). Everything is tenant-scoped by `customer_id`, a plain
// UUID referencing the platform Customer with no cross-boundary foreign key
// (matching the app's other tables).
//
// A license is recorded from its parsed XML (see ../licenseXml). Re-recording
// the same license (same guid) upserts rather than duplicating — a license's
// guid is its stable identity.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapLicense, type Row, type SplunkLicenseDto } from './mappers'
import type { ParsedLicense } from '../licenseXml'

export async function listLicenses(
  db: PlatformDatabaseClient,
  customerId: string,
): Promise<SplunkLicenseDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_licenses WHERE customer_id = $1::uuid ORDER BY expiration_time ASC NULLS LAST, updated_at DESC',
    customerId,
  )
  return rows.map(mapLicense)
}

export async function getLicense(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<SplunkLicenseDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_licenses WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
  return rows[0] ? mapLicense(rows[0]) : null
}

/**
 * Record (insert or refresh) a parsed license for a tenant. Upserts on
 * (customer_id, guid) so re-pasting the same license file updates its extracted
 * fields + raw XML in place instead of creating a duplicate. `createdBy` is the
 * initiating user id (nullable).
 */
export async function recordLicense(
  db: PlatformDatabaseClient,
  customerId: string,
  parsed: ParsedLicense,
  rawXml: string,
  createdBy: string | null,
): Promise<SplunkLicenseDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO splunk_licenses
       (customer_id, label, license_type, group_id, stack_id, quota_bytes,
        window_period, max_violations, creation_time, expiration_time, guid,
        features, raw_xml, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11,
             $12::jsonb, $13, $14::uuid)
     ON CONFLICT (customer_id, guid) DO UPDATE SET
       label           = EXCLUDED.label,
       license_type    = EXCLUDED.license_type,
       group_id        = EXCLUDED.group_id,
       stack_id        = EXCLUDED.stack_id,
       quota_bytes     = EXCLUDED.quota_bytes,
       window_period   = EXCLUDED.window_period,
       max_violations  = EXCLUDED.max_violations,
       creation_time   = EXCLUDED.creation_time,
       expiration_time = EXCLUDED.expiration_time,
       features        = EXCLUDED.features,
       raw_xml         = EXCLUDED.raw_xml,
       updated_at      = now()
     RETURNING *`,
    customerId,
    parsed.label || null,
    parsed.licenseType || null,
    parsed.groupId || null,
    parsed.stackId || null,
    parsed.quotaBytes,
    parsed.windowPeriod,
    parsed.maxViolations,
    parsed.creationTime,
    parsed.expirationTime,
    parsed.guid,
    JSON.stringify(parsed.features ?? []),
    rawXml,
    createdBy,
  )
  return mapLicense(rows[0])
}

export async function deleteLicense(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<void> {
  await db.$executeRawUnsafe(
    'DELETE FROM splunk_licenses WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
}
