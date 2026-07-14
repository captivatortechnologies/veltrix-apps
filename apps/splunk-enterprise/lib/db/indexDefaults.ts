// =============================================================================
// Index default configurations — raw-SQL access to the app-owned
// `splunk_index_default` table. These are the user-created inheritance sources
// a new index item can seed from.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapIndexDefault, type IndexDefaultDto, type Row } from './mappers'

export interface IndexDefaultInput {
  name: string
  maxEventSize: number
  retentionPeriod: number
  searchablePeriod: number
  frozenTimePeriod: number
  enableCompression: boolean
  enableTsidx: boolean
  requireApproval: boolean
}

export async function listIndexDefaults(
  db: PlatformDatabaseClient,
  customerId: string,
): Promise<IndexDefaultDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_index_default WHERE customer_id = $1::uuid ORDER BY updated_at DESC',
    customerId,
  )
  return rows.map(mapIndexDefault)
}

export async function getIndexDefault(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<IndexDefaultDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_index_default WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
  return rows[0] ? mapIndexDefault(rows[0]) : null
}

export async function createIndexDefault(
  db: PlatformDatabaseClient,
  customerId: string,
  input: IndexDefaultInput,
): Promise<IndexDefaultDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO splunk_index_default
       (name, max_event_size, retention_period, searchable_period, frozen_time_period,
        enable_compression, enable_tsidx, require_approval, customer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    input.name,
    input.maxEventSize,
    input.retentionPeriod,
    input.searchablePeriod,
    input.frozenTimePeriod,
    input.enableCompression,
    input.enableTsidx,
    input.requireApproval,
    customerId,
  )
  return mapIndexDefault(rows[0])
}

export async function updateIndexDefault(
  db: PlatformDatabaseClient,
  id: string,
  input: IndexDefaultInput,
): Promise<IndexDefaultDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `UPDATE splunk_index_default SET
       name = $2, max_event_size = $3, retention_period = $4, searchable_period = $5,
       frozen_time_period = $6, enable_compression = $7, enable_tsidx = $8,
       require_approval = $9, updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    id,
    input.name,
    input.maxEventSize,
    input.retentionPeriod,
    input.searchablePeriod,
    input.frozenTimePeriod,
    input.enableCompression,
    input.enableTsidx,
    input.requireApproval,
  )
  return mapIndexDefault(rows[0])
}

export async function deleteIndexDefault(db: PlatformDatabaseClient, id: string): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM splunk_index_default WHERE id = $1::uuid', id)
}
