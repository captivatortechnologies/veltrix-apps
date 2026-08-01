import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, normalizeBool } from '../../lib/secretServerApi'
import { extractGroupSpecs, searchGroups, findGroupByName } from './_shared'

/**
 * Drift for groups: for each declared group, re-find it by name and compare the
 * managed `enabled` flag. A group that can't be found is critical drift.
 * Best-effort — a read error asserts no drift rather than raising a false
 * critical. Read-only: GET /api/v1/groups.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractGroupSpecs(items).filter((s) => s.groupName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    for (const spec of specs) {
      const matches = await searchGroups(client, spec.groupName)
      const match = findGroupByName(matches, spec.groupName)
      if (!match) {
        diffs.push({ field: spec.groupName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (match.enabled !== undefined && normalizeBool(match.enabled) !== spec.enabled) {
        diffs.push({
          field: `${spec.groupName}.enabled`,
          expected: spec.enabled,
          actual: normalizeBool(match.enabled),
          severity: 'warning',
        })
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
