import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findBehavior } from './deploy'
import { extractBehaviorSpecs, parseSettingsObject } from './validate'

/**
 * Detect drift between the deployed behavior configuration and the live Okta org.
 * Each declared behavior is re-found by name and its meaningful fields are
 * compared. Server-managed readOnly fields (id, created, lastUpdated, system,
 * _links, _embedded) are never modeled so they cannot read as drift; status is
 * managed by the lifecycle endpoints and is compared separately (warning).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBehaviorSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    try {
      const live = await findBehavior(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — a behavior's kind is a defining field.
      const liveType = (live.type ?? '').toString()
      if (spec.type !== liveType) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: liveType || 'not set',
          severity: 'critical',
        })
      }

      // settings — diff each key present in the declared blob against the live
      // behavior's settings, normalising so key order / whitespace do not read as
      // drift. Only authored keys are compared; Okta-defaulted extras are ignored.
      const settings = spec.settingsJson ? parseSettingsObject(spec.settingsJson) : {}
      const liveSettings = (live.settings ?? {}) as Record<string, unknown>
      if (settings) {
        for (const key of Object.keys(settings)) {
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
