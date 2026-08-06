import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { listBlueprints } from './deploy'
import { blueprintKey, extractBlueprintSpecs, indexBlueprintsByName } from './validate'

/**
 * Detect drift between the deployed Blueprint configuration and the live
 * Kandji tenant. Re-finds each declared Blueprint by name and diffs
 * description/icon/color/enrollment-active; a missing Blueprint is critical
 * drift, a changed field is a warning. `type` and `enrollment_code.code` are
 * not diffed — `type` is immutable after create, and Kandji regenerates the
 * enrollment code server-side when left blank, so comparing it would flag
 * false drift on every deploy that didn't pin an explicit code.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBlueprintSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listBlueprints(client)
    const byName = indexBlueprintsByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(blueprintKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = found.description ?? ''
      if (liveDescription !== spec.description) {
        diffs.push({ field: `${label}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
      }
      if (spec.type !== 'map') {
        const liveIcon = found.icon ?? ''
        if (spec.icon && liveIcon !== spec.icon) {
          diffs.push({ field: `${label}.icon`, expected: spec.icon, actual: liveIcon, severity: 'warning' })
        }
        const liveColor = found.color ?? ''
        if (spec.color && liveColor !== spec.color) {
          diffs.push({ field: `${label}.color`, expected: spec.color, actual: liveColor, severity: 'warning' })
        }
      }
      const liveActive = found.enrollment_code?.is_active ?? true
      if (liveActive !== spec.enrollmentActive) {
        diffs.push({
          field: `${label}.enrollment_active`,
          expected: spec.enrollmentActive,
          actual: liveActive,
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'kandji',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
