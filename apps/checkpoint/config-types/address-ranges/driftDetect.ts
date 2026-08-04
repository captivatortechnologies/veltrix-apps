import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { liveTagNames, sameStringSet } from '../lib/checkpointShared'
import { listAllAddressRanges } from './deploy'
import { addressRangeKey, extractAddressRangeSpecs, type LiveAddressRange } from './validate'

/**
 * Detect drift between the deployed address-range configuration and the live
 * management database. Re-finds each declared range by name
 * (show-address-ranges) and diffs the managed fields: a missing range or a
 * changed endpoint is critical drift (it changes what traffic the object
 * matches); a changed comment, color or tag set is a warning. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAddressRangeSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllAddressRanges(client)
    const byName = new Map<string, LiveAddressRange>(live.filter((r) => r.name).map((r) => [addressRangeKey(r.name as string), r]))

    for (const spec of specs) {
      const found = byName.get(addressRangeKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const checks: Array<[string, string, string | undefined]> = [
        ['ipv4First', spec.ipv4First, found['ipv4-address-first']],
        ['ipv4Last', spec.ipv4Last, found['ipv4-address-last']],
        ['ipv6First', spec.ipv6First, found['ipv6-address-first']],
        ['ipv6Last', spec.ipv6Last, found['ipv6-address-last']],
      ]
      for (const [field, expected, actual] of checks) {
        if (expected && (actual ?? '') !== expected) {
          diffs.push({ field: `${label}.${field}`, expected, actual: actual ?? '(none)', severity: 'critical' })
        }
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
