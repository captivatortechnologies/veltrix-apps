import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllHosts } from './deploy'
import { extractHostSpecs, hostKey, liveTagNames, sameStringSet, type LiveHost } from './validate'

/**
 * Detect drift between the deployed host-object configuration and the live
 * management database. Re-finds each declared host by name (show-hosts) and
 * diffs the managed fields: a missing host is critical drift; a changed
 * address, comment, color or tag set is a warning. Read-only — logs out at
 * the end without publishing or discarding (nothing was changed).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractHostSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllHosts(client)
    const byName = new Map<string, LiveHost>(live.filter((h) => h.name).map((h) => [hostKey(h.name as string), h]))

    for (const spec of specs) {
      const found = byName.get(hostKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (spec.ipv4Address && found['ipv4-address'] !== spec.ipv4Address) {
        diffs.push({
          field: `${label}.ipv4Address`,
          expected: spec.ipv4Address,
          actual: found['ipv4-address'] ?? '(none)',
          severity: 'critical',
        })
      }
      if (spec.ipv6Address && found['ipv6-address'] !== spec.ipv6Address) {
        diffs.push({
          field: `${label}.ipv6Address`,
          expected: spec.ipv6Address,
          actual: found['ipv6-address'] ?? '(none)',
          severity: 'critical',
        })
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
