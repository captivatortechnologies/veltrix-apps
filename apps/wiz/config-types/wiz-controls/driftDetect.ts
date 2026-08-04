import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listControls, readControl } from './deploy'
import { controlKey, extractControlSpecs, jsonEquals, liveProjectId, type LiveControl } from './validate'

/**
 * Detect drift between the deployed control configuration and the live tenant.
 * Re-finds each declared control by name and diffs the managed fields: a
 * missing control is critical drift; a changed severity, enabled state, query,
 * scope query, resolution recommendation or security sub-categories is a
 * warning. A project-scope mismatch is reported but never auto-corrected —
 * Wiz has no API to change a control's project after creation.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractControlSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.query !== undefined && s.scopeQuery !== undefined,
  )
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listControls(client)
    const byName = new Map<string, LiveControl>(live.filter((c) => c.name).map((c) => [controlKey(c.name as string), c]))

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(controlKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readControl(client, found.id)

      if ((full.severity ?? '') !== spec.severity) {
        diffs.push({ field: `${label}.severity`, expected: spec.severity, actual: full.severity ?? 'not set', severity: 'warning' })
      }
      const liveEnabled = full.enabled ?? true
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled), severity: 'warning' })
      }
      if (!jsonEquals(full.query, spec.query)) {
        diffs.push({ field: `${label}.query`, expected: 'as declared', actual: 'changed in Wiz', severity: 'warning' })
      }
      if (!jsonEquals(full.scopeQuery, spec.scopeQuery)) {
        diffs.push({ field: `${label}.scope_query`, expected: 'as declared', actual: 'changed in Wiz', severity: 'warning' })
      }
      if ((full.resolutionRecommendation ?? '') !== spec.resolutionRecommendation) {
        diffs.push({
          field: `${label}.resolution_recommendation`,
          expected: spec.resolutionRecommendation || '(none)',
          actual: full.resolutionRecommendation || '(none)',
          severity: 'warning',
        })
      }
      const liveProject = liveProjectId(full.scopeProject)
      if (liveProject !== spec.projectId) {
        diffs.push({
          field: `${label}.project_id`,
          expected: `${spec.projectId} (recreate the control to change this)`,
          actual: liveProject,
          severity: 'warning',
        })
      }
      const declaredSubs = [...spec.securitySubCategories].map((s) => s.toLowerCase()).sort()
      const liveSubs = (full.securitySubCategories ?? [])
        .map((s) => (s.id ?? '').toLowerCase())
        .filter((s) => s !== '')
        .sort()
      if (declaredSubs.join(',') !== liveSubs.join(',')) {
        diffs.push({
          field: `${label}.security_sub_categories`,
          expected: spec.securitySubCategories,
          actual: (full.securitySubCategories ?? []).map((s) => s.id ?? ''),
          severity: 'warning',
        })
      }

      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'wiz',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
