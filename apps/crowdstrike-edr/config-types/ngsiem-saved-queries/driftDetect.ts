import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { SAVED_QUERY_ENDPOINTS, liveShared } from './deploy'
import type { LiveSavedQuery } from './validate'
import { extractSavedQuerySpecs, type SavedQuerySpec } from './validate'

/**
 * Detect drift between the deployed saved query configuration and the live
 * tenant state. Looks up each declared query by name and diffs the managed
 * fields (query CQL, time range, description, sharing). The query is compared
 * as a normalized (trimmed) string.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractSavedQuerySpecs(ctx.deployedConfig).filter((s) => s.name && s.query)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = (await findEntityByIdentity(
        client,
        SAVED_QUERY_ENDPOINTS,
        spec.name,
      )) as LiveSavedQuery | null

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffSavedQuery(spec, live))

      // Attribute every diff this query produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), savedQueryActorResource(live), { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Bridge a saved query's modifier fields onto the audit reader shape. */
function savedQueryActorResource(live: LiveSavedQuery): ModifiedResource {
  return {
    modified_by: live.modified_by ?? live.updated_by,
    modified_timestamp: live.modified_timestamp ?? live.updated_at,
    modified_on: live.modified_on,
  }
}

function diffSavedQuery(spec: SavedQuerySpec, live: LiveSavedQuery): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // The CQL query is the consequential field — a changed query returns
  // different results, so drift on it is critical.
  const liveQuery = typeof live.query === 'string' ? live.query.trim() : ''
  if (liveQuery !== spec.query.trim()) {
    diffs.push({
      field: `${label}.query`,
      expected: spec.query.trim(),
      actual: liveQuery || 'not set',
      severity: 'critical',
    })
  }

  if (spec.timeRange !== undefined && (typeof live.time_range === 'string' ? live.time_range : '') !== spec.timeRange) {
    diffs.push({
      field: `${label}.timeRange`,
      expected: spec.timeRange,
      actual: (typeof live.time_range === 'string' && live.time_range) || 'not set',
      severity: 'warning',
    })
  }

  if (spec.description !== undefined && (typeof live.description === 'string' ? live.description : '') !== spec.description) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description,
      actual: (typeof live.description === 'string' && live.description) || 'not set',
      severity: 'warning',
    })
  }

  if (liveShared(live) !== spec.shared) {
    diffs.push({
      field: `${label}.shared`,
      expected: spec.shared,
      actual: liveShared(live),
      severity: 'warning',
    })
  }

  return diffs
}
