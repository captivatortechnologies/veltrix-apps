import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { findGroup } from './deploy'
import { INTERNAL_TYPE, extractGroupSpecs } from './validate'

/**
 * Detect drift between the deployed identity group configuration and the live
 * Vault cluster. Re-reads each group via GET /identity/group/name/{name} and
 * diffs only the authored fields:
 *
 *   - type     → critical (immutable; a mismatch can only be fixed by recreating)
 *   - policies → warning (compared as a set — order-independent)
 *   - members  → warning, INTERNAL groups only (external membership is managed by
 *                Vault via group-aliases, so it is never a drift signal here)
 *
 * Server-computed fields (id, creation_time, modify_index, alias) are excluded,
 * as is metadata — it is authored "managed-when-set" and not a drift signal.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findGroup(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — immutable; a mismatch is unfixable without recreating the group.
      const liveType = (live.type ?? '').toLowerCase()
      if (liveType !== spec.type) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: `${spec.type} (immutable — a group's type is fixed at creation and cannot be changed without recreating the group)`,
          actual: liveType || 'unknown',
          severity: 'critical',
        })
      }

      // policies — compared as a set (order-independent).
      compareSet(diffs, `${spec.name}.policies`, spec.policies, live.policies)

      // members — reconciled for internal groups only. For an external group the
      // membership is auth-managed (group-aliases) and intentionally not compared.
      if (spec.type === INTERNAL_TYPE) {
        compareSet(diffs, `${spec.name}.member_entity_ids`, spec.memberEntityIds, live.member_entity_ids)
        compareSet(diffs, `${spec.name}.member_group_ids`, spec.memberGroupIds, live.member_group_ids)
      }
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

/** Push a warning-level diff when an authored id set differs from the live set. */
function compareSet(
  diffs: DriftDiff[],
  field: string,
  expected: string[],
  liveRaw: string[] | undefined,
): void {
  const actual = Array.isArray(liveRaw) ? liveRaw : []
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const same = expectedSet.size === actualSet.size && [...expectedSet].every((v) => actualSet.has(v))
  if (!same) {
    diffs.push({
      field,
      expected: expected.length ? [...expected].sort().join(', ') : 'none',
      actual: actual.length ? [...actual].sort().join(', ') : 'none',
      severity: 'warning',
    })
  }
}
