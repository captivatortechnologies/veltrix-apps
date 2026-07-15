import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findRecastRule } from './deploy'
import { buildRecastFilter, extractRecastRuleSpecs } from './validate'

/**
 * Detect drift between the deployed recast rule configuration and the live
 * tenant state. Re-finds each declared rule by its (resource_type, pluginId,
 * action) tuple and diffs the managed fields: the merged filter, the recast
 * target severity (RECAST rules only), and the expiry.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRecastRuleSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.resourceType && s.action && s.pluginId,
  )

  for (const spec of specs) {
    const label = spec.name
    try {
      const live = await findRecastRule(client, spec)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // The filter decides which findings the rule matches — normalize both
      // sides so key order / whitespace do not read as drift.
      const expectedFilter = normalize(buildRecastFilter(spec))
      const actualFilter = normalize(live.filter)
      if (expectedFilter !== actualFilter) {
        diffs.push({
          field: `${label}.filter`,
          expected: expectedFilter || 'not set',
          actual: actualFilter || 'not set',
          severity: 'critical',
        })
      }

      // severity is only meaningful for a RECAST rule (it is the target severity).
      if (spec.action === 'RECAST') {
        const liveSeverity = (live.rule_value?.severity ?? '').toLowerCase()
        if ((spec.severity ?? '') !== liveSeverity) {
          diffs.push({
            field: `${label}.severity`,
            expected: spec.severity ?? 'not set',
            actual: liveSeverity || 'not set',
            severity: 'warning',
          })
        }
      }

      const liveExpires = typeof live.expires_at === 'string' ? live.expires_at : ''
      if ((spec.expiresAt ?? '') !== liveExpires) {
        diffs.push({
          field: `${label}.expires_at`,
          expected: spec.expiresAt ?? 'not set',
          actual: liveExpires || 'not set',
          severity: 'info',
        })
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Canonicalize a filter object to a stable comparison string. */
function normalize(filter: unknown): string {
  if (filter === null || filter === undefined) return ''
  if (typeof filter === 'object') return stableStringify(filter)
  return String(filter)
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
