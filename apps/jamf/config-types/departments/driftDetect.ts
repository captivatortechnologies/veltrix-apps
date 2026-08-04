import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listDepartments } from './deploy'
import { departmentKey, extractDepartmentSpecs, indexDepartmentsByName } from './validate'

/** A department has no field beyond `name` (its own identity) — drift is only ever "missing". */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDepartmentSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listDepartments(client, ctx.settings)
    const byName = indexDepartmentsByName(live)
    for (const spec of specs) {
      if (!byName.has(departmentKey(spec.name))) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'jamf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
