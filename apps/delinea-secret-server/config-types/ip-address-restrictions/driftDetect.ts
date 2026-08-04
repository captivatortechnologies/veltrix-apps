import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient } from '../../lib/secretServerApi'
import { extractIpRestrictionSpecs, listIpRestrictions, findIpRestrictionByName } from './_shared'

/**
 * Drift for IP address restrictions: for each declared restriction, re-find it
 * by name and compare the managed `range`. A restriction that can't be found
 * is critical drift. Best-effort — a read error asserts no drift rather than
 * raising a false critical. Read-only: GET /api/v1/ipaddress-restrictions.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractIpRestrictionSpecs(items).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    const allRestrictions = await listIpRestrictions(client)
    for (const spec of specs) {
      const match = findIpRestrictionByName(allRestrictions, spec.name)
      if (!match) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (match.range !== undefined && String(match.range) !== spec.range) {
        diffs.push({ field: `${spec.name}.range`, expected: spec.range, actual: String(match.range), severity: 'warning' })
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
