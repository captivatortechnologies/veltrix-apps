import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { IT_TASK_ENDPOINTS } from './deploy'
import {
  extractITTaskSpecs,
  parameterKeys,
  parseTaskParameters,
  readLiveContent,
  type ITTaskSpec,
  type LiveITTask,
} from './validate'

/**
 * Detect drift between the deployed IT automation task configuration and the
 * live tenant state. Looks up each declared task by name and diffs task type,
 * description, the managed content, and the set of parameter keys. Parameter
 * comparison is on keys only (not server-defaulted parameter fields) so
 * unmanaged fields never manufacture false drift.
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
  const specs = extractITTaskSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = (await findEntityByIdentity(
        client,
        IT_TASK_ENDPOINTS,
        spec.name,
      )) as LiveITTask | null

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffTask(spec, live))

      attachDriftActor(diffs.slice(before), taskActorResource(live), { excludeActorLogins })
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

/** Bridge a task's modifier fields onto the audit reader shape. */
function taskActorResource(live: LiveITTask): ModifiedResource {
  return {
    modified_by: live.modified_by ?? live.updated_by,
    modified_timestamp: live.modified_timestamp ?? live.updated_timestamp,
    modified_on: live.modified_on,
  }
}

function diffTask(spec: ITTaskSpec, live: LiveITTask): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  if (live.task_type !== undefined && live.task_type !== spec.taskType) {
    diffs.push({
      field: `${label}.taskType`,
      expected: spec.taskType,
      actual: live.task_type ?? 'not set',
      severity: 'warning',
    })
  }

  const liveDescription = (live.description ?? '').trim()
  if ((spec.description ?? '') !== liveDescription) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description ?? 'not set',
      actual: liveDescription || 'not set',
      severity: 'info',
    })
  }

  // Content — the osquery/script the task runs is its most consequential field.
  const liveContent = readLiveContent(spec, live)
  if (liveContent !== spec.content) {
    diffs.push({
      field: `${label}.content`,
      expected: spec.content || 'not set',
      actual: liveContent || 'not set',
      severity: 'critical',
    })
  }

  // Parameters — compare declared keys against live keys (ignore defaulted fields).
  const declaredKeys = parameterKeys(parseTaskParameters(spec.parametersRaw).parameters)
  const liveKeys = (live.task_parameters ?? [])
    .map((p) => (typeof p.key === 'string' ? p.key : ''))
    .filter((k) => k.length > 0)
  if (!sameSet(declaredKeys, liveKeys)) {
    diffs.push({
      field: `${label}.parameters`,
      expected: declaredKeys.join(', ') || 'none',
      actual: liveKeys.join(', ') || 'none',
      severity: 'warning',
    })
  }

  return diffs
}
