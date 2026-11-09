import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getPolicyByName, listSchedules, upsertSchedule } from '../../lib/db'
import { validateSchedule } from '../../lib/model'
import { readScheduleItem } from '../lib/guardrailItems'
import { itemsOf } from '../lib/readers'
import { errorMessage } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import { clampEnforcement } from './_shared'
import type { ScheduleRollbackData, ScheduleRollbackEntry } from './_shared'

/**
 * Records each schedule with its enforcement clamped to the policy's own. This
 * handler only stores the schedule: the platform scheduler that reads
 * cgov_schedule and requests the runs is Phase 0 platform work and is not part
 * of this repository, so next_run_at is left for it to maintain.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }

  const entries: ScheduleRollbackEntry[] = []
  const deployed: string[] = []
  const failures: string[] = []
  const clamps: string[] = []

  try {
    const existing = await listSchedules(store.db, store.customerId)
    for (const canvasItem of itemsOf(ctx.canvas)) {
      const { value, errors } = validateSchedule(readScheduleItem(canvasItem))
      if (!value) {
        failures.push(`${canvasItem.name}: ${errors.map((e) => e.message).join('; ')}`)
        continue
      }
      const policy = await getPolicyByName(store.db, store.customerId, value.policy)
      if (!policy) {
        failures.push(`${value.policy}: policy is not registered; deploy it before scheduling it`)
        continue
      }
      const { enforcement, clamped } = clampEnforcement(value.enforcement, policy.enforcement)
      if (clamped) clamps.push(`${value.policy}: ${value.enforcement} lowered to ${enforcement}`)

      const previous = existing.find((s) => s.policyName === value.policy)
      const saved = await upsertSchedule(store.db, store.customerId, {
        canvasId: ctx.canvas.canvasId,
        policyName: value.policy,
        cron: value.cron,
        enabled: value.enabled,
        enforcement,
        nextRunAt: previous?.nextRunAt ?? null,
      })
      entries.push({
        policyName: value.policy,
        scheduleId: saved.id,
        existed: previous !== undefined,
        previous: previous
          ? { canvasId: previous.canvasId, cron: previous.cron, enabled: previous.enabled, enforcement: previous.enforcement, nextRunAt: previous.nextRunAt }
          : null,
      })
      deployed.push(value.policy)
    }
  } catch (error) {
    failures.push(`Store error: ${errorMessage(error)}`)
  }

  const rollbackData: ScheduleRollbackData = { schedules: entries }
  const clampNote = clamps.length > 0 ? ` Enforcement was clamped to the policy's: ${clamps.join('; ')}.` : ''
  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Recorded ${deployed.length} schedule(s): ${deployed.join(', ') || '(none)'}.${clampNote}`
        : `Schedule deploy had ${failures.length} failure(s): ${failures.join(' | ')}.${clampNote}`,
    artifacts: { deployed, clamped: clamps, failures },
    rollbackData,
  }
}
