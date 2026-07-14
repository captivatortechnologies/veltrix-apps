// =============================================================================
// Splunk upgrade operations — raw-SQL access to the app-owned
// `splunk_upgrade_operation` table. A record is a planned/executed upgrade of a
// BYOL infrastructure from one Splunk version to another.
//
// The operation table has no customer_id of its own, so ownership is enforced
// by joining `splunk_byol_infrastructure` (which does) on customer_id.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import type { Row } from './mappers'

export interface UpgradeOperationDto {
  id: string
  infrastructureId: string
  infraName: string
  previousVersionId: string
  previousVersion: string
  targetVersionId: string
  targetVersion: string
  status: string
  scheduledFor: Date | null
  maintenanceWindow: string | null
  startedAt: Date
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Terminal states — once here, the operation is done and gets a completed_at. */
export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELED']
export const UPGRADE_STATUSES = ['PENDING', 'IN_PROGRESS', ...TERMINAL_STATUSES]

function mapOp(r: Row): UpgradeOperationDto {
  return {
    id: r.id,
    infrastructureId: r.infrastructure_id,
    infraName: r.infra_name,
    previousVersionId: r.previous_version_id,
    previousVersion: r.previous_version,
    targetVersionId: r.target_version_id,
    targetVersion: r.target_version,
    status: r.status,
    scheduledFor: r.scheduled_for ?? null,
    maintenanceWindow: r.maintenance_window ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface UpgradeOperationInput {
  infrastructureId: string
  fromVersionId: string
  toVersionId: string
  scheduledFor?: string | null
  maintenanceWindow?: string | null
}

export async function listUpgradeOperations(
  db: PlatformDatabaseClient,
  customerId: string,
): Promise<UpgradeOperationDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT o.*,
            inf.name       AS infra_name,
            pv.version     AS previous_version,
            tv.version     AS target_version
       FROM splunk_upgrade_operation o
       JOIN splunk_byol_infrastructure inf ON inf.id = o.infrastructure_id
       JOIN splunk_version pv ON pv.id = o.previous_version_id
       JOIN splunk_version tv ON tv.id = o.target_version_id
      WHERE inf.customer_id = $1::uuid
      ORDER BY o.created_at DESC`,
    customerId,
  )
  return rows.map(mapOp)
}

/** Create a PENDING upgrade operation. Ownership of the infra is checked by the caller. */
export async function createUpgradeOperation(
  db: PlatformDatabaseClient,
  input: UpgradeOperationInput,
): Promise<{ id: string }> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO splunk_upgrade_operation
       (infrastructure_id, previous_version_id, target_version_id, status, scheduled_for, maintenance_window)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING', $4, $5)
     RETURNING id`,
    input.infrastructureId,
    input.fromVersionId,
    input.toVersionId,
    input.scheduledFor ?? null,
    input.maintenanceWindow ?? null,
  )
  return { id: rows[0].id }
}

/** True if the operation exists and its infrastructure belongs to the customer. */
export async function isUpgradeOperationOwned(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT 1 AS ok
       FROM splunk_upgrade_operation o
       JOIN splunk_byol_infrastructure inf ON inf.id = o.infrastructure_id
      WHERE o.id = $1::uuid AND inf.customer_id = $2::uuid`,
    id,
    customerId,
  )
  return rows.length > 0
}

export async function setUpgradeOperationStatus(
  db: PlatformDatabaseClient,
  id: string,
  status: string,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE splunk_upgrade_operation
        SET status = $2,
            completed_at = CASE WHEN $2 = ANY($3::text[]) THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1::uuid`,
    id,
    status,
    TERMINAL_STATUSES,
  )
}
