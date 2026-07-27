import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { DASHBOARD_ENDPOINTS, liveShared } from './deploy'
import type { LiveDashboard } from './validate'
import {
  extractDashboardSpecs,
  parseDefinition,
  stableStringify,
  type DashboardSpec,
} from './validate'

/**
 * Detect drift between the deployed dashboard configuration and the live tenant
 * state. Looks up each declared dashboard by name and diffs the managed fields
 * (definition, description, sharing). The definition is compared as a
 * canonicalized JSON object so key reordering is not reported as drift.
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

  const specs = extractDashboardSpecs(ctx.deployedConfig).filter((s) => s.name && s.definitionRaw)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = (await findEntityByIdentity(
        client,
        DASHBOARD_ENDPOINTS,
        spec.name,
      )) as LiveDashboard | null

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffDashboard(spec, live))

      // Attribute every diff this dashboard produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), dashboardActorResource(live), { excludeActorLogins })
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

/** Bridge a dashboard's modifier fields onto the audit reader shape. */
function dashboardActorResource(live: LiveDashboard): ModifiedResource {
  return {
    modified_by: live.modified_by ?? live.updated_by,
    modified_timestamp: live.modified_timestamp ?? live.updated_at,
    modified_on: live.modified_on,
  }
}

function diffDashboard(spec: DashboardSpec, live: LiveDashboard): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // The widget/layout definition is the consequential field — a changed
  // definition renders a different dashboard, so drift on it is critical.
  const expectedDefinition = stableStringify(parseDefinition(spec.definitionRaw).value ?? {})
  const actualDefinition = stableStringify(live.definition ?? {})
  if (expectedDefinition !== actualDefinition) {
    diffs.push({
      field: `${label}.definition`,
      expected: 'declared widget/layout definition',
      actual: 'differs from declared definition',
      severity: 'critical',
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
