import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findDeviceAssurance } from './deploy'
import { extractDeviceAssuranceSpecs, parseConfigObject } from './validate'

/**
 * Detect drift between the deployed device-assurance configuration and the live
 * Okta org. Each declared policy is re-found by name and compared:
 *   - platform (a defining, immutable field)
 *   - each requirement key present in the declared configJson blob
 *
 * Server-managed readOnly fields (id, createdBy, createdDate, lastUpdate,
 * lastUpdatedBy, _links) are never modeled so they cannot read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDeviceAssuranceSpecs(ctx.deployedConfig).filter((s) => s.name && s.platform)

  for (const spec of specs) {
    try {
      const live = await findDeviceAssurance(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // platform
      const livePlatform = (live.platform ?? '').toString()
      if (spec.platform !== livePlatform) {
        diffs.push({
          field: `${spec.name}.platform`,
          expected: spec.platform,
          actual: livePlatform || 'not set',
          severity: 'critical',
        })
      }

      // requirements — diff each key present in the declared blob, normalising so
      // key order / whitespace do not read as drift.
      const config = spec.configJson ? parseConfigObject(spec.configJson) : {}
      if (config) {
        for (const key of Object.keys(config)) {
          const expected = stableStringify(config[key] ?? null)
          const actual = stableStringify((live as Record<string, unknown>)[key] ?? null)
          if (expected !== actual) {
            diffs.push({
              field: `${spec.name}.${key}`,
              expected: config[key] ?? 'not set',
              actual: (live as Record<string, unknown>)[key] ?? 'not set',
              severity: 'critical',
            })
          }
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

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
