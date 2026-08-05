import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { buildApplicationBody, findApplication } from './deploy'
import { extractApplicationSpecs } from './validate'

/** Core identity fields whose drift is treated as critical (everything else is a warning). */
const CRITICAL_FIELDS = new Set(['enabled', 'protocol', 'type'])

/**
 * Detect drift between the deployed application configuration and the live
 * PingOne environment. Each declared application is re-found by name and
 * compared against the exact body deploy would send: `enabled`, `protocol`,
 * `type` (critical), plus every protocol-specific field actually present in
 * the declared item (warning) - arrays and objects (redirectUris, grantTypes,
 * idpSigningKey, ...) are compared with a stable, key-order-independent
 * stringify. The write-only client secret sub-resource is never fetched or
 * compared here - PingOne never returns it outside its own dedicated
 * endpoint, and this config type never manages it.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractApplicationSpecs(ctx.deployedConfig).filter((s) => s.name && s.protocol)

  for (const spec of specs) {
    try {
      const live = await findApplication(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Diff every field deploy would send (excluding `name`, the match key)
      // against the live application's corresponding wire-format field.
      const body = buildApplicationBody(spec)
      const liveRecord = live as Record<string, unknown>
      for (const [key, expected] of Object.entries(body)) {
        if (key === 'name') continue
        const actual = liveRecord[key]
        if (stableStringify(expected ?? null) !== stableStringify(actual ?? null)) {
          diffs.push({
            field: `${spec.name}.${key}`,
            expected: expected ?? 'not set',
            actual: actual ?? 'not set',
            severity: CRITICAL_FIELDS.has(key) ? 'critical' : 'warning',
          })
        }
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
