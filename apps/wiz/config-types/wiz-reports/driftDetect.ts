import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listReports, readReport } from './deploy'
import { extractReportSpecs, reportKey, tryParseJson, type LiveReport } from './validate'

/**
 * Detect drift between the deployed report configuration and the live tenant.
 * Re-finds each declared report by name and diffs the managed fields: a missing
 * report is critical drift; a changed schedule interval or graph query is a
 * warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractReportSpecs(ctx.deployedConfig).filter((s) => s.name && s.query)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listReports(client)
    const byName = new Map<string, LiveReport>(live.filter((r) => r.name).map((r) => [reportKey(r.name as string), r]))

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(reportKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readReport(client, found.id)
      const liveInterval = typeof full.runIntervalHours === 'number' ? full.runIntervalHours : null
      if (liveInterval !== spec.runIntervalHours) {
        diffs.push({
          field: `${label}.run_interval_hours`,
          expected: spec.runIntervalHours === null ? 'on-demand' : String(spec.runIntervalHours),
          actual: liveInterval === null ? 'on-demand' : String(liveInterval),
          severity: 'warning',
        })
      }
      if (!sameQuery(full.params?.query, spec.query)) {
        diffs.push({ field: `${label}.query`, expected: 'as declared', actual: 'changed in Wiz', severity: 'warning' })
      }

      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'wiz',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Compare the live query value against the declared JSON, tolerant of key order. */
function sameQuery(liveQuery: unknown, declared: string): boolean {
  const parsed = tryParseJson(declared)
  if (!parsed.ok) return true // an unparseable declaration is a validate-time concern, not drift
  try {
    return JSON.stringify(canonical(liveQuery)) === JSON.stringify(canonical(parsed.value))
  } catch {
    return true
  }
}

/** Recursively sort object keys so equality ignores key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonical((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }
  return value
}
