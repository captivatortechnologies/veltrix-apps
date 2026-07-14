// =============================================================================
// Role default configurations — raw-SQL access to the app-owned
// `splunk_role_default` table.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapRoleDefault, type Row, type RoleDefaultDto } from './mappers'

export interface RoleDefaultInput {
  name: string
  description: string | null
  defaultPermissions: string[]
  requireApproval: boolean
}

export async function listRoleDefaults(
  db: PlatformDatabaseClient,
  customerId: string,
): Promise<RoleDefaultDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_role_default WHERE customer_id = $1::uuid ORDER BY updated_at DESC',
    customerId,
  )
  return rows.map(mapRoleDefault)
}

export async function getRoleDefault(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<RoleDefaultDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_role_default WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
  return rows[0] ? mapRoleDefault(rows[0]) : null
}

export async function createRoleDefault(
  db: PlatformDatabaseClient,
  customerId: string,
  input: RoleDefaultInput,
): Promise<RoleDefaultDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO splunk_role_default
       (name, description, default_permissions, require_approval, customer_id)
     VALUES ($1, $2, $3::text[], $4, $5)
     RETURNING *`,
    input.name,
    input.description,
    input.defaultPermissions,
    input.requireApproval,
    customerId,
  )
  return mapRoleDefault(rows[0])
}

export async function updateRoleDefault(
  db: PlatformDatabaseClient,
  id: string,
  input: RoleDefaultInput,
): Promise<RoleDefaultDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `UPDATE splunk_role_default SET
       name = $2, description = $3, default_permissions = $4::text[],
       require_approval = $5, updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    id,
    input.name,
    input.description,
    input.defaultPermissions,
    input.requireApproval,
  )
  return mapRoleDefault(rows[0])
}

export async function deleteRoleDefault(db: PlatformDatabaseClient, id: string): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM splunk_role_default WHERE id = $1::uuid', id)
}
