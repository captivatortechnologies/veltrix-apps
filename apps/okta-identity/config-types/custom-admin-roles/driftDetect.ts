import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findRoleByLabel, listRolePermissions, listRoles } from './deploy'
import { extractRoleSpecs } from './validate'

/**
 * Detect drift between the deployed custom-admin-role configuration and the live
 * Okta org. Each declared role is re-found by label and compared:
 *   - description
 *   - permission set (order-insensitive) — read from the /permissions sub-resource
 *
 * `label` is the identity (used to match) so it can never read as drift. Server-
 * managed readOnly fields (id, created, lastUpdated, _links) are never modeled.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.label && s.permissions.length > 0)

  let liveRoles
  try {
    liveRoles = await listRoles(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'custom-admin-roles',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    try {
      const live = findRoleByLabel(liveRoles, spec.label)

      if (!live?.id) {
        diffs.push({ field: spec.label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // description
      const liveDescription = (live.description ?? '').toString()
      if (spec.description !== liveDescription) {
        diffs.push({
          field: `${spec.label}.description`,
          expected: spec.description || 'not set',
          actual: liveDescription || 'not set',
          severity: 'warning',
        })
      }

      // permission set — order-insensitive
      const livePermissions = await listRolePermissions(client, live.id)
      const expected = [...spec.permissions].sort()
      const actual = [...livePermissions].sort()
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        diffs.push({
          field: `${spec.label}.permissions`,
          expected,
          actual,
          severity: 'critical',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
