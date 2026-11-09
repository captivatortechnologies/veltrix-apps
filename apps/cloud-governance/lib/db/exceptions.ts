import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapException, type ExceptionDto } from './mappers'

export interface UpsertExceptionInput {
  canvasId?: string | null
  policyName: string
  resourceId: string
  reason: string
  approver: string
  expiresAt: string
}

export async function upsertException(db: PlatformDatabaseClient, customerId: string, input: UpsertExceptionInput): Promise<ExceptionDto> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `INSERT INTO cgov_exception (customer_id, canvas_id, policy_name, resource_id, reason, approver, expires_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
     ON CONFLICT (customer_id, policy_name, resource_id) DO UPDATE SET
       canvas_id = EXCLUDED.canvas_id, reason = EXCLUDED.reason, approver = EXCLUDED.approver, expires_at = EXCLUDED.expires_at
     RETURNING *`,
    customerId, input.canvasId ?? null, input.policyName, input.resourceId, input.reason, input.approver, input.expiresAt)
  return mapException(rows[0])
}

export async function listExceptions(db: PlatformDatabaseClient, customerId: string, policyName?: string | null): Promise<ExceptionDto[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT * FROM cgov_exception WHERE customer_id = $1::uuid AND ($2::text IS NULL OR policy_name = $2)
     ORDER BY policy_name, expires_at`, customerId, policyName ?? null)
  return rows.map(mapException)
}

export async function deleteException(db: PlatformDatabaseClient, customerId: string, id: string): Promise<number> {
  return db.$executeRawUnsafe('DELETE FROM cgov_exception WHERE id = $1::uuid AND customer_id = $2::uuid', id, customerId)
}

export async function listActiveExceptions(db: PlatformDatabaseClient, customerId: string, policyName: string, now: Date): Promise<ExceptionDto[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT * FROM cgov_exception WHERE customer_id = $1::uuid AND policy_name = $2 AND expires_at > $3::timestamptz
     ORDER BY resource_id`, customerId, policyName, now.toISOString())
  return rows.map(mapException)
}
