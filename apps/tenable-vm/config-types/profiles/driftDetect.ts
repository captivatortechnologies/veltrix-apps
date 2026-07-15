import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findProfile, getProfileById, profileIdentifier } from './deploy'
import { extractProfileSpecs, parseSettingsObject } from './validate'

/**
 * Detect drift between the deployed profile configuration and the live tenant
 * state. Re-finds each declared profile by name and, when advanced settings
 * were declared, diffs only the managed keys — the fields the canvas actually
 * set. Server-added defaults on the live profile are ignored, since only the
 * declared settingsJson keys are under this config's management.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractProfileSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findProfile(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Only diff the managed keys the canvas declared. Fetch the full profile
      // body (the list only returns id/uuid/name) to read the tuning fields.
      if (spec.settingsJson) {
        const expected = parseSettingsObject(spec.settingsJson) ?? {}
        const id = profileIdentifier(live)
        const full = id !== undefined ? await getProfileById(client, id) : live

        for (const key of Object.keys(expected)) {
          if (key === 'name') continue // identity — matched on, never drifts
          const expectedValue = normalizeValue(expected[key])
          const actualValue = normalizeValue(full ? full[key] : undefined)
          if (expectedValue !== actualValue) {
            diffs.push({
              field: `${spec.name}.${key}`,
              expected: expectedValue || 'not set',
              actual: actualValue || 'not set',
              severity: 'warning',
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

/** Canonicalize a value (primitive, object or array) to a stable comparison string. */
function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return stableStringify(value)
  return String(value)
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
