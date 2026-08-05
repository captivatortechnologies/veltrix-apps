import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listRoles } from '../../lib/sophosApi'
import { customRoleKey, customRoleMatches, extractCustomRoleSpecs } from './_shared'

/**
 * Detect drift for custom roles: for each declared name, find the live role
 * and compare description/permissionSets. A declared role that no longer
 * exists is critical drift; a changed description or permission set list is
 * a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCustomRoleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listRoles(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByName = new Map(live.filter((r) => r.name).map((r) => [customRoleKey(r.name), r] as const))

  for (const spec of specs) {
    const match = liveByName.get(customRoleKey(spec.name))
    if (!match) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!customRoleMatches(spec, match)) {
      diffs.push({
        field: `${spec.name}.grant`,
        expected: { description: spec.description, permissionSets: spec.permissionSets },
        actual: { description: match.description ?? '', permissionSets: match.permissionSets ?? [] },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
