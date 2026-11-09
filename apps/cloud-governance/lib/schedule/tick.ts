// =============================================================================
// The app-schedules facility. The platform never reads cgov_schedule; once a
// minute it delivers `governance.schedule.tick` with `{ now }` and the app
// fires whatever of its own schedules are due. A schedule stored without a due
// time is armed on its first tick (so deploying one never fires it on the
// spot); a due schedule is claimed atomically before any run is requested, so
// overlapping ticks cannot double-fire.
// =============================================================================

import * as store from '../db'
import type { Enforcement } from '../model/types'
import { isValidCron } from '../model/validate'
import { requestRun, type LifecycleContext, type RequestRunInput, type RunRequestResult } from '../runLifecycle'
import type { RunKind } from '../runner/contract'
import { nextCronRun } from './cron'

export interface ScheduleTickReport {
  /** Schedules that were due and claimed by this tick. */
  fired: number
  /** Runs actually requested (one per registered account). */
  requested: number
  /** Schedules that had no due time and were given one. */
  armed: number
  /** Human-readable reasons something was not run, for the host log. */
  skipped: string[]
}

export type RunRequester = (ctx: LifecycleContext, customerId: string, input: RequestRunInput) => Promise<RunRequestResult>

interface ScheduledRun {
  kind: RunKind
  enforcement?: Enforcement
  note?: string
}

/** Phase 0: only `auto` enforces; `ask` previews until the approval gate exists. */
export function scheduledRunFor(enforcement: Enforcement): ScheduledRun {
  if (enforcement === 'auto') return { kind: 'enforce', enforcement }
  if (enforcement === 'ask') return { kind: 'preview', note: 'ask schedules preview only until the per-run approval gate ships' }
  return { kind: 'preview' }
}

export const scheduleRequester = (policyName: string): string => `schedule:${policyName}`

export async function runDueSchedules(ctx: LifecycleContext, customerId: string, now: Date, request: RunRequester = requestRun): Promise<ScheduleTickReport> {
  const report: ScheduleTickReport = { fired: 0, requested: 0, armed: 0, skipped: [] }
  const schedules = await store.listSchedules(ctx.db, customerId, true)

  for (const schedule of schedules) {
    if (!isValidCron(schedule.cron)) {
      report.skipped.push(`${schedule.policyName}: stored cron is invalid`)
      continue
    }
    const next = nextCronRun(schedule.cron, now)
    if (!schedule.nextRunAt) {
      if (await store.armSchedule(ctx.db, customerId, schedule.id, next)) report.armed++
      continue
    }
    if (Date.parse(schedule.nextRunAt) > now.getTime()) continue
    if (!(await store.claimDueSchedule(ctx.db, customerId, schedule.id, now, next))) continue
    report.fired++

    const policy = await store.getPolicyByName(ctx.db, customerId, schedule.policyName)
    if (!policy) {
      report.skipped.push(`${schedule.policyName}: policy is no longer registered`)
      continue
    }
    const accounts = await store.listPolicyAccounts(ctx.db, customerId, policy.id)
    if (accounts.length === 0) report.skipped.push(`${schedule.policyName}: no accounts registered`)
    const { kind, enforcement, note } = scheduledRunFor(schedule.enforcement)
    if (note) report.skipped.push(`${schedule.policyName}: ${note}`)

    for (const account of accounts) {
      try {
        await request(ctx, customerId, { policyId: policy.id, componentId: account.componentId, kind, enforcement, requestedBy: scheduleRequester(schedule.policyName) })
        report.requested++
      } catch (error) {
        report.skipped.push(`${schedule.policyName}/${account.componentId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return report
}
