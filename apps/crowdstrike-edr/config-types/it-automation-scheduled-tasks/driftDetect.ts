import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { IT_SCHEDULED_TASK_ENDPOINTS } from './deploy'
import {
  extractScheduledTaskSpecs,
  flattenSchedule,
  parseSchedule,
  readLiveGroupIds,
  type ITScheduledTaskSpec,
  type LiveScheduledTask,
} from './validate'

/**
 * Detect drift between the deployed scheduled task configuration and the live
 * tenant state. Looks up each declared scheduled task by task_id and diffs
 * enablement, the declared schedule keys, and host groups. Schedule comparison
 * is scoped to declared keys; host groups are compared against the CONFIRMED
 * live `group_ids` field only when present — so unverified fields never
 * manufacture false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractScheduledTaskSpecs(ctx.deployedConfig).filter((s) => s.taskId)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = (await findEntityByIdentity(
        client,
        IT_SCHEDULED_TASK_ENDPOINTS,
        spec.taskId,
      )) as LiveScheduledTask | null

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffScheduledTask(spec, live))

      attachDriftActor(diffs.slice(before), scheduledTaskActorResource(live), { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Bridge a scheduled task's modifier fields onto the audit reader shape. */
function scheduledTaskActorResource(live: LiveScheduledTask): ModifiedResource {
  return {
    modified_by: live.modified_by ?? live.updated_by,
    modified_timestamp: live.modified_timestamp ?? live.updated_timestamp,
    modified_on: live.modified_on,
  }
}

function diffScheduledTask(spec: ITScheduledTaskSpec, live: LiveScheduledTask): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // Enablement decides whether the schedule runs
  if (typeof live.is_active === 'boolean' && live.is_active !== spec.enabled) {
    diffs.push({
      field: `${label}.enabled`,
      expected: spec.enabled,
      actual: live.is_active,
      severity: 'warning',
    })
  }

  // Declared schedule keys vs live values (scoped to what the canvas declares)
  const declared = flattenSchedule(parseSchedule(spec.scheduleRaw, spec.timezone).schedule)
  const liveSchedule = flattenSchedule(
    live.schedule && typeof live.schedule === 'object' ? (live.schedule as Record<string, unknown>) : undefined,
  )
  for (const [path, expected] of declared) {
    const actual = liveSchedule.get(path)
    if (actual !== expected) {
      diffs.push({
        field: `${label}.schedule.${path}`,
        expected,
        actual: actual ?? 'not present on schedule',
        severity: 'warning',
      })
    }
  }

  // Host groups — compared against the confirmed live group_ids only when present.
  const liveGroups = readLiveGroupIds(live)
  if (liveGroups !== undefined && !sameSet(liveGroups, spec.hostGroups)) {
    diffs.push({
      field: `${label}.hostGroups`,
      expected: spec.hostGroups.join(', ') || 'none',
      actual: liveGroups.join(', ') || 'none',
      severity: 'warning',
    })
  }

  return diffs
}
