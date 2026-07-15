// =============================================================================
// Splunk version catalog — raw-SQL access to the app-owned `splunk_version`
// table. Used by the install hook (seeding) and the /versions route.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapVersion, type Row, type SplunkVersionDto } from './mappers'

export interface VersionSeed {
  version: string
  releaseDate: Date
  isActive: boolean
  isLatest: boolean
  releaseNotes?: string | null
  features?: unknown
}

/** Count SYSTEM versions (customer_id IS NULL) — used to decide whether to seed. */
export async function countVersions(db: PlatformDatabaseClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: string }>>(
    'SELECT COUNT(*)::text AS count FROM splunk_version WHERE customer_id IS NULL',
  )
  return Number(rows[0]?.count ?? 0)
}

/**
 * Versions visible to a tenant: every system version (customer_id IS NULL) plus
 * that tenant's own. System versions sort first within an equal release date.
 */
export async function listActiveVersions(
  db: PlatformDatabaseClient,
  customerId: string,
): Promise<SplunkVersionDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT * FROM splunk_version
      WHERE is_active = true AND (customer_id IS NULL OR customer_id = $1::uuid)
      ORDER BY release_date DESC, (customer_id IS NULL) DESC`,
    customerId,
  )
  return rows.map(mapVersion)
}

/** Insert a SYSTEM version if its `version` is not already present (seeding). */
export async function insertVersionIfAbsent(db: PlatformDatabaseClient, v: VersionSeed): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO splunk_version (version, release_date, is_active, is_latest, release_notes, features)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (version) WHERE customer_id IS NULL DO NOTHING`,
    v.version,
    v.releaseDate,
    v.isActive,
    v.isLatest,
    v.releaseNotes ?? null,
    JSON.stringify(v.features ?? null),
  )
}

// --- CRUD for tenant-owned versions ----------------------------------------
// The catalog is seeded with SYSTEM versions at install (insertVersionIfAbsent,
// customer_id NULL, visible to all tenants). A tenant extends it with its own
// versions via the Upgrades › Versions tab — register a release and attach the
// installer by download URL or by uploading the package to S3. Tenants may read
// system + their own versions, but may only edit/delete their own.

export interface VersionInput {
  version: string
  releaseDate: Date
  downloadUrl: string | null
  releaseNotes: string | null
  isActive: boolean
  isLatest: boolean
}

/** A version the tenant may READ: a system version or one they own. */
export async function getReadableVersion(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<SplunkVersionDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_version WHERE id = $1::uuid AND (customer_id IS NULL OR customer_id = $2::uuid)',
    id,
    customerId,
  )
  return rows[0] ? mapVersion(rows[0]) : null
}

/** A version the tenant OWNS (editable/deletable). System versions excluded. */
export async function getOwnedVersion(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<SplunkVersionDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_version WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
  return rows[0] ? mapVersion(rows[0]) : null
}

/** Clear the tenant's own `is_latest` flag so a single owned version can hold it. */
async function clearLatest(db: PlatformDatabaseClient, customerId: string): Promise<void> {
  await db.$executeRawUnsafe(
    'UPDATE splunk_version SET is_latest = false WHERE is_latest = true AND customer_id = $1::uuid',
    customerId,
  )
}

/** Create a tenant-owned version. Throws on a duplicate `version` for the tenant. */
export async function createVersion(
  db: PlatformDatabaseClient,
  customerId: string,
  input: VersionInput,
): Promise<SplunkVersionDto> {
  if (input.isLatest) await clearLatest(db, customerId)
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO splunk_version (version, release_date, download_url, release_notes, is_active, is_latest, customer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
     RETURNING *`,
    input.version,
    input.releaseDate,
    input.downloadUrl,
    input.releaseNotes,
    input.isActive,
    input.isLatest,
    customerId,
  )
  return mapVersion(rows[0])
}

/** Update a tenant-owned version (system/other-tenant rows are never matched). */
export async function updateVersion(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
  input: VersionInput,
): Promise<SplunkVersionDto | null> {
  if (input.isLatest) await clearLatest(db, customerId)
  const rows = await db.$queryRawUnsafe<Row[]>(
    `UPDATE splunk_version
        SET version = $3, release_date = $4, download_url = $5, release_notes = $6,
            is_active = $7, is_latest = $8, updated_at = now()
      WHERE id = $1::uuid AND customer_id = $2::uuid
      RETURNING *`,
    id,
    customerId,
    input.version,
    input.releaseDate,
    input.downloadUrl,
    input.releaseNotes,
    input.isActive,
    input.isLatest,
  )
  return rows[0] ? mapVersion(rows[0]) : null
}

/** Set only the stored installer reference (download_url) for an owned version. */
export async function setVersionDownloadUrl(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
  downloadUrl: string,
): Promise<SplunkVersionDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `UPDATE splunk_version SET download_url = $3, updated_at = now()
      WHERE id = $1::uuid AND customer_id = $2::uuid RETURNING *`,
    id,
    customerId,
    downloadUrl,
  )
  return rows[0] ? mapVersion(rows[0]) : null
}

/** Delete a tenant-owned version (system/other-tenant rows are never matched). */
export async function deleteVersion(db: PlatformDatabaseClient, id: string, customerId: string): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM splunk_version WHERE id = $1::uuid AND customer_id = $2::uuid', id, customerId)
}
