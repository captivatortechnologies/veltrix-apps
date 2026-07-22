import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { attachDriftActor, veltrixActorLogins } from '../lib/oktaSystemLog'
import { findZone } from './deploy'
import { extractZoneSpecs, parseConfigObject } from './validate'

/**
 * Detect drift between the deployed zone configuration and the live Okta org.
 * Each declared zone is re-found by name and its meaningful fields are compared.
 * Server-managed readOnly fields (id, created, lastUpdated, system, _links,
 * _embedded) are never modeled so they cannot read as drift; status is managed by
 * the lifecycle endpoints and is compared separately (warning).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractZoneSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findZone(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // type — a zone's kind (IP vs dynamic) is a defining field.
      const liveType = (live.type ?? '').toString()
      if (spec.type !== liveType) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: liveType || 'not set',
          severity: 'critical',
        })
      }

      // definition — diff each key present in the declared blob (gateways,
      // proxies, asns, locations, proxyType, ipServiceCategories) against the
      // live zone, normalising so key order / whitespace do not read as drift.
      const config = spec.configJson ? parseConfigObject(spec.configJson) : {}
      if (config) {
        for (const key of Object.keys(config)) {
          const expected = stableStringify(config[key] ?? null)
          const actual = stableStringify(live[key] ?? null)
          if (expected !== actual) {
            diffs.push({
              field: `${spec.name}.${key}`,
              expected: config[key] ?? 'not set',
              actual: live[key] ?? 'not set',
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

      // Attribute every diff this zone produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.id,
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

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
