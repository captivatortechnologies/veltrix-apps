import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { liveTagNames, sameStringSet } from '../lib/checkpointShared'
import { listAllSecurityZones } from './deploy'
import { extractSecurityZoneSpecs, securityZoneKey, type LiveSecurityZone } from './validate'

/**
 * Detect drift between the deployed security-zone configuration and the live
 * management database. Re-finds each declared zone by name
 * (show-security-zones) and diffs the managed fields: a missing zone is
 * critical drift (interface anti-spoofing / zone-based rules referencing it
 * would be affected); a changed comment, color or tag set is a warning.
 * Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSecurityZoneSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllSecurityZones(client)
    const byName = new Map<string, LiveSecurityZone>(live.filter((z) => z.name).map((z) => [securityZoneKey(z.name as string), z]))

    for (const spec of specs) {
      const found = byName.get(securityZoneKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (spec.comments || found.comments) {
        const liveComments = found.comments ?? ''
        if (liveComments !== spec.comments) {
          diffs.push({ field: `${label}.comments`, expected: spec.comments, actual: liveComments, severity: 'warning' })
        }
      }
      if (spec.color && found.color && found.color !== spec.color) {
        diffs.push({ field: `${label}.color`, expected: spec.color, actual: found.color, severity: 'warning' })
      }
      const liveTags = liveTagNames(found.tags)
      if (!sameStringSet(liveTags, spec.tags)) {
        diffs.push({
          field: `${label}.tags`,
          expected: spec.tags.join(', ') || '(none)',
          actual: liveTags.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }
  } catch {
    diffs.push({ field: 'checkpoint', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
