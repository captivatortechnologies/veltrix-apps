import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findLogStream } from './deploy'
import { extractLogStreamSpecs, parseConfigObject } from './validate'

/**
 * Detect drift between the deployed log-stream configuration and the live Okta
 * org. Each declared stream is re-found by name and its fields compared:
 *   - type
 *   - settings (each non-secret key declared in settingsJson)
 *   - status (lifecycle-managed) — compared separately as a WARNING
 *
 * The Splunk HEC `token` is WRITE-ONLY (never returned) so it is NEVER compared —
 * it cannot read as drift. Server-managed readOnly fields (id, created,
 * lastUpdated, _links) are never modeled so they cannot read as drift either.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractLogStreamSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    try {
      const live = await findLogStream(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — a stream's destination (a defining, immutable field).
      const liveType = (live.type ?? '').toString()
      if (spec.type !== liveType) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: liveType || 'not set',
          severity: 'critical',
        })
      }

      // settings — diff each non-secret key declared in settingsJson (the token,
      // if present, is stripped so the write-only secret never reads as drift).
      const settings = spec.settingsJson ? parseConfigObject(spec.settingsJson) : {}
      const liveSettings = (live.settings ?? {}) as Record<string, unknown>
      if (settings) {
        for (const key of Object.keys(settings)) {
          if (key === 'token') continue
          const expected = stableStringify(settings[key] ?? null)
          const actual = stableStringify(liveSettings[key] ?? null)
          if (expected !== actual) {
            diffs.push({
              field: `${spec.name}.settings.${key}`,
              expected: settings[key] ?? 'not set',
              actual: liveSettings[key] ?? 'not set',
              severity: 'critical',
            })
          }
        }
      }

      // status — managed via lifecycle endpoints; compared separately (warning).
      const liveStatus = (live.status ?? '').toString().toUpperCase()
      const desiredStatus = (spec.status ?? '').toUpperCase()
      if (desiredStatus && liveStatus && desiredStatus !== liveStatus) {
        diffs.push({
          field: `${spec.name}.status`,
          expected: spec.status,
          actual: live.status ?? 'not set',
          severity: 'warning',
        })
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
