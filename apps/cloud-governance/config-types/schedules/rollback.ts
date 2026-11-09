import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deleteSchedule, upsertSchedule } from '../../lib/db'
import { isRecord } from '../../lib/model/issues'
import { errorMessage } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import type { ScheduleRollbackData } from './_shared'

function readRollbackData(value: unknown): ScheduleRollbackData | null {
  if (!isRecord(value) || !Array.isArray(value.schedules)) return null
  return value as unknown as ScheduleRollbackData
}

/** Restores replaced schedules and deletes the ones this deploy created. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }
  const data = readRollbackData(ctx.rollbackData)
  if (!data) return { success: false, message: 'No rollback data recorded for this deployment.' }

  let restored = 0
  let removed = 0
  const failures: string[] = []
  for (const entry of [...data.schedules].reverse()) {
    try {
      if (entry.existed && entry.previous) {
        await upsertSchedule(store.db, store.customerId, { policyName: entry.policyName, ...entry.previous })
        restored += 1
      } else {
        await deleteSchedule(store.db, store.customerId, entry.scheduleId)
        removed += 1
      }
    } catch (error) {
      failures.push(`${entry.policyName}: ${errorMessage(error)}`)
    }
  }
  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Rolled back schedules: restored ${restored}, removed ${removed}`
        : `Schedule rollback had ${failures.length} failure(s): ${failures.join(' | ')}`,
  }
}
