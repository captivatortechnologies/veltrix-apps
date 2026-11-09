import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import type { Enforcement } from '../model/types'
import { mapSchedule, type ScheduleDto } from './mappers'

export interface UpsertScheduleInput {
  canvasId?: string | null
  policyName: string
  cron: string
  enabled: boolean
  enforcement: Enforcement
  nextRunAt?: string | null
}

export async function upsertSchedule(db: PlatformDatabaseClient, customerId: string, input: UpsertScheduleInput): Promise<ScheduleDto> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `INSERT INTO cgov_schedule (customer_id, canvas_id, policy_name, cron, enabled, enforcement, next_run_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::boolean, $6, $7::timestamptz)
     ON CONFLICT (customer_id, policy_name) DO UPDATE SET
       canvas_id = EXCLUDED.canvas_id, cron = EXCLUDED.cron, enabled = EXCLUDED.enabled,
       enforcement = EXCLUDED.enforcement, next_run_at = EXCLUDED.next_run_at, updated_at = now()
     RETURNING *`,
    customerId, input.canvasId ?? null, input.policyName, input.cron, input.enabled, input.enforcement, input.nextRunAt ?? null)
  return mapSchedule(rows[0])
}

export async function listSchedules(db: PlatformDatabaseClient, customerId: string, enabledOnly = false): Promise<ScheduleDto[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM cgov_schedule WHERE customer_id = $1::uuid AND ($2::boolean = false OR enabled) ORDER BY policy_name', customerId, enabledOnly)
  return rows.map(mapSchedule)
}

/** First tick after a schedule is stored without a due time: arm it, never fire it. */
export async function armSchedule(db: PlatformDatabaseClient, customerId: string, id: string, nextRunAt: Date): Promise<boolean> {
  const updated = await db.$executeRawUnsafe(
    `UPDATE cgov_schedule SET next_run_at = $3::timestamptz, updated_at = now()
     WHERE id = $1::uuid AND customer_id = $2::uuid AND next_run_at IS NULL`,
    id, customerId, nextRunAt.toISOString())
  return updated > 0
}

/**
 * Atomically takes a due schedule for this tick by moving its due time forward.
 * Two overlapping ticks cannot both win: the second finds `next_run_at` already
 * past `now` and gets false.
 */
export async function claimDueSchedule(db: PlatformDatabaseClient, customerId: string, id: string, now: Date, nextRunAt: Date): Promise<boolean> {
  const updated = await db.$executeRawUnsafe(
    `UPDATE cgov_schedule SET last_run_at = $3::timestamptz, next_run_at = $4::timestamptz, updated_at = now()
     WHERE id = $1::uuid AND customer_id = $2::uuid AND enabled AND next_run_at IS NOT NULL AND next_run_at <= $3::timestamptz`,
    id, customerId, now.toISOString(), nextRunAt.toISOString())
  return updated > 0
}

export async function deleteSchedule(db: PlatformDatabaseClient, customerId: string, id: string): Promise<number> {
  return db.$executeRawUnsafe('DELETE FROM cgov_schedule WHERE id = $1::uuid AND customer_id = $2::uuid', id, customerId)
}
