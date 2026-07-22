import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findTagValue } from './deploy'
import { extractTagSpecs, parseFilterObject } from './validate'

/**
 * Detect drift between the deployed tag configuration and the live tenant
 * state. Re-finds each declared tag by its (category, value) pair and diffs the
 * managed fields (description and, for dynamic tags, the asset filter).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTagSpecs(ctx.deployedConfig).filter((s) => s.category && s.value)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const label = `${spec.category}:${spec.value}`
    try {
      const live = await findTagValue(client, spec.category, spec.value)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.value, excludeActorLogins })
        continue
      }

      // The asset filter decides which assets a dynamic tag auto-applies to —
      // normalize both sides so key order / whitespace do not read as drift.
      if (spec.filters) {
        const expected = normalizeFilters(parseFilterObject(spec.filters))
        const actual = normalizeFilters(live.filters)
        if (expected !== actual) {
          diffs.push({
            field: `${label}.filters`,
            expected: expected || 'not set',
            actual: actual || 'not set',
            severity: 'critical',
          })
        }
      }

      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this tag produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.uuid,
        targetName: spec.value,
        excludeActorLogins,
      })
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

/** Canonicalize a filter (object or JSON string) to a stable comparison string. */
function normalizeFilters(filters: unknown): string {
  if (filters === null || filters === undefined) return ''
  if (typeof filters === 'string') {
    // A live filter may come back as a JSON string — re-parse so key order and
    // whitespace do not create phantom drift.
    const parsed = parseFilterObject(filters)
    return parsed ? stableStringify(parsed) : filters.trim()
  }
  if (typeof filters === 'object') return stableStringify(filters)
  return String(filters)
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
