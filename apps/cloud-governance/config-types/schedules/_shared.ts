import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { getPolicyByName, listSchedules } from '../../lib/db'
import type { PolicyDto, ScheduleDto } from '../../lib/db'
import { enforcementRank, validateSchedule } from '../../lib/model'
import type { Enforcement, PolicySchedule } from '../../lib/model/types'
import { readScheduleItem } from '../lib/guardrailItems'
import { itemsOf } from '../lib/readers'
import type { Store } from '../lib/store'

export interface ScheduleRollbackEntry {
  policyName: string
  scheduleId: string
  existed: boolean
  previous: {
    canvasId: string | null
    cron: string
    enabled: boolean
    enforcement: Enforcement
    nextRunAt: string | null
  } | null
}

export interface ScheduleRollbackData {
  schedules: ScheduleRollbackEntry[]
}

export interface Clamped {
  enforcement: Enforcement
  clamped: boolean
}

/** A schedule may never run stronger than its policy. */
export function clampEnforcement(requested: Enforcement, ceiling: Enforcement): Clamped {
  return enforcementRank(requested) > enforcementRank(ceiling)
    ? { enforcement: ceiling, clamped: true }
    : { enforcement: requested, clamped: false }
}

export interface ScheduleInspection {
  expected: PolicySchedule
  effectiveEnforcement: Enforcement
  policy: PolicyDto | null
  stored: ScheduleDto | null
}

export async function inspectSchedules(store: Store, ctx: Pick<PipelineContext, 'canvas'>): Promise<ScheduleInspection[]> {
  const stored = await listSchedules(store.db, store.customerId)
  const out: ScheduleInspection[] = []
  for (const item of itemsOf(ctx.canvas)) {
    const { value } = validateSchedule(readScheduleItem(item))
    if (!value) continue
    const policy = await getPolicyByName(store.db, store.customerId, value.policy)
    out.push({
      expected: value,
      effectiveEnforcement: policy ? clampEnforcement(value.enforcement, policy.enforcement).enforcement : value.enforcement,
      policy,
      stored: stored.find((s) => s.policyName === value.policy) ?? null,
    })
  }
  return out
}
