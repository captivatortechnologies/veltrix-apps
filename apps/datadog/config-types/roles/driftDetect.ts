import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listRoles } from './deploy'
import { extractRoleSpecs, findRoleByName, resolvePermissionIds } from './_shared'
import { listAllPermissions, listRolePermissionIds } from './permissions'

/**
 * Detect drift between the declared Role configuration and the live
 * organization: a missing role is critical drift; a MISSING declared
 * permission is a warning. Permission grants are additive-only (see
 * permissions.ts), so an EXTRA live permission (a Datadog baseline default,
 * or one a human added) is never reported as drift — only a subset check
 * (every declared permission must be present), not a set-equality check.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  let allPermissions
  try {
    ;[live, allPermissions] = await Promise.all([listRoles(client), listAllPermissions(client)])
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [{ field: 'datadog', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' }],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findRoleByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const { ids: desiredIds, unknown } = resolvePermissionIds(allPermissions, spec.permissionNames)
    if (unknown.length > 0) {
      diffs.push({
        field: `${label}.permissions`,
        expected: `all of: ${spec.permissionNames.join(', ')}`,
        actual: `unrecognized name(s): ${unknown.join(', ')}`,
        severity: 'warning',
      })
    }

    let liveIds: string[]
    try {
      liveIds = await listRolePermissionIds(client, found.id)
    } catch (error) {
      diffs.push({ field: `${label}.permissions`, expected: 'readable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'warning' })
      continue
    }

    const liveIdSet = new Set(liveIds)
    const missing = desiredIds.filter((id) => !liveIdSet.has(id))
    if (missing.length > 0) {
      diffs.push({
        field: `${label}.permissions`,
        expected: `all ${desiredIds.length} declared permission(s) granted`,
        actual: `${missing.length} declared permission(s) missing`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
