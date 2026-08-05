import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findProfile, getProfileById, profileIdentifier } from './deploy'
import { extractProfileSpecs, parseSettingsObject } from './validate'

/**
 * Detect drift between the deployed profile configuration and the live tenant
 * state. Re-finds each declared profile by (sensor type, name), diffs
 * `description` when the canvas manages one, and — when advanced settings were
 * declared — diffs only the managed `config` keys the canvas actually set.
 * Server-added defaults on the live profile are ignored, since only the
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

  const specs = extractProfileSpecs(ctx.deployedConfig).filter((s) => s.name && s.sensorType)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findProfile(client, spec.sensorType, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // description — only compared when the canvas manages one.
      if (spec.description !== undefined) {
        const liveDescription = typeof live.description === 'string' ? live.description : ''
        if (spec.description !== liveDescription) {
          diffs.push({
            field: `${spec.name}.description`,
            expected: spec.description || 'not set',
            actual: liveDescription || 'not set',
            severity: 'info',
          })
        }
      }

      // Only diff the managed `config` keys the canvas declared. Fetch the full
      // profile detail (the list also returns config, but re-fetch by uuid for a
      // consistent, single-record read).
      if (spec.settingsJson) {
        const expected = parseSettingsObject(spec.settingsJson) ?? {}
        const id = profileIdentifier(live)
        const full = id !== undefined ? await getProfileById(client, spec.sensorType, id) : live
        const liveConfig = full?.config ?? {}

        for (const key of Object.keys(expected)) {
          const expectedValue = normalizeValue(expected[key])
          const actualValue = normalizeValue(liveConfig[key])
          if (expectedValue !== actualValue) {
            diffs.push({
              field: `${spec.name}.config.${key}`,
              expected: expectedValue || 'not set',
              actual: actualValue || 'not set',
              severity: 'warning',
            })
          }
        }
      }

      // Attribute every diff this profile produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: profileIdentifier(live),
        targetName: spec.name,
        excludeActorLogins,
      })
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
