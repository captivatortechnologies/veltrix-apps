import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findRole } from './deploy'
import { extractRoleSpecs, livePermissionStrings } from './validate'

/**
 * Detect drift between the deployed role configuration and the live tenant
 * state. Re-finds each declared role by name and diffs the managed fields
 * (description and the granted permission strings). Permission strings are
 * compared as a set — order is not significant — after normalizing both sides.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findRole(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // Permission strings define what the role can do — drift here is a
      // meaningful access change. Compare as sorted sets so reordering is not
      // reported as drift.
      const expectedPerms = normalizePermissions(spec.permissionStrings)
      const actualPerms = normalizePermissions(livePermissionStrings(live))
      if (expectedPerms !== actualPerms) {
        diffs.push({
          field: `${spec.name}.permissionStrings`,
          expected: expectedPerms || 'none',
          actual: actualPerms || 'none',
          severity: 'warning',
        })
      }

      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this role produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.uuid,
        targetName: spec.name,
        excludeActorLogins,
      })
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

/** Sort + join a permission-string list to a stable, order-independent string. */
function normalizePermissions(permissions: string[]): string {
  return [...permissions].sort().join(',')
}
