import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { attachDriftActor, veltrixActorLogins } from '../../lib/s1ActivityLog'
import { getRoleDetail, listRbacRoles, permissionsOf } from './deploy'
import { extractRbacRoleSpecs, getNestedPath, roleKey, type LiveRbacRole } from './validate'

/**
 * Detect drift between the deployed RBAC role configuration and the live
 * scope. Re-finds each declared role by name; a missing role is critical
 * drift. For a role that still exists, each declared dot-path permission
 * override is re-read from the role's live detail and compared to the
 * enforced value (a changed permission is a warning — RBAC drift is
 * security-relevant, matching how s1-agent-policy treats a changed setting).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope) return { hasDrift: false, diffs: [] }

  const specs = extractRbacRoleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRbacRoles(client)
    const byKey = new Map<string, LiveRbacRole>(live.filter((r) => r.name).map((r) => [roleKey(r.name as string), r]))

    const veltrixLogins = veltrixActorLogins(ctx.credential)
    const attributions: Array<Promise<void>> = []

    for (const spec of specs) {
      const label = spec.name
      const before = diffs.length
      const found = byKey.get(roleKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else if (Object.keys(spec.permissions).length > 0) {
        const detail = await getRoleDetail(client, found.id)
        const permissions = permissionsOf(detail)
        for (const [permKey, expected] of Object.entries(spec.permissions)) {
          const actual = getNestedPath(permissions, permKey)
          if (actual !== expected) {
            diffs.push({
              field: `${label}.${permKey}`,
              expected: String(expected),
              actual: actual === undefined ? 'not set' : String(actual),
              severity: 'warning',
            })
          }
        }
      }

      const objectDiffs = diffs.slice(before)
      if (objectDiffs.length > 0) {
        attributions.push(
          attachDriftActor(client, objectDiffs, {
            targetId: found?.id,
            targetName: spec.name,
            excludeActorLogins: veltrixLogins,
          }),
        )
      }
    }
    await Promise.all(attributions)
  } catch (error) {
    diffs.push({
      field: 'sentinelone',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
