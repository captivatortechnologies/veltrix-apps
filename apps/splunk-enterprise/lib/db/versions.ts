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

export async function countVersions(db: PlatformDatabaseClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: string }>>(
    'SELECT COUNT(*)::text AS count FROM splunk_version',
  )
  return Number(rows[0]?.count ?? 0)
}

export async function listActiveVersions(db: PlatformDatabaseClient): Promise<SplunkVersionDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_version WHERE is_active = true ORDER BY release_date DESC',
  )
  return rows.map(mapVersion)
}

/** Insert a version if its `version` string is not already present (no-op on conflict). */
export async function insertVersionIfAbsent(db: PlatformDatabaseClient, v: VersionSeed): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO splunk_version (version, release_date, is_active, is_latest, release_notes, features)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (version) DO NOTHING`,
    v.version,
    v.releaseDate,
    v.isActive,
    v.isLatest,
    v.releaseNotes ?? null,
    JSON.stringify(v.features ?? null),
  )
}
