import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listRules, readRule } from './deploy'
import {
  deepSubsetEqual,
  extractRuleSpecs,
  findRuleByName,
  parseJsonArray,
  parseJsonObject,
  stableStringify,
  type DatadogRule,
} from './_shared'

/**
 * Detect drift between the deployed Security Monitoring Rule configuration and
 * the live organization. Re-finds each declared rule by name
 * (GET /api/v2/security_monitoring/rules, then a full GET .../{rule_id}) and
 * diffs every managed field: a missing rule is critical drift; a changed
 * message / isEnabled / type / hasExtendedTitle / tags / queries / cases /
 * options / filters is a warning.
 *
 * queries / cases / options / filters use a SUBSET-aware comparison
 * (deepSubsetEqual): Datadog may default in extra keys we did not declare
 * (e.g. an empty "notifications": [] on a case) — those are not read as
 * drift, but any declared key that no longer matches, or a changed array
 * length, is.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.message)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: DatadogRule[]
  try {
    live = await listRules(client)
  } catch (error) {
    const diffs: DriftDiff[] = [
      {
        field: 'datadog',
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      },
    ]
    return { hasDrift: true, diffs }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findRuleByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: DatadogRule
    try {
      full = await readRule(client, found.id)
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'warning',
      })
      continue
    }

    if (spec.message !== (full.message ?? '')) {
      diffs.push({ field: `${label}.message`, expected: spec.message, actual: full.message ?? 'not set', severity: 'warning' })
    }
    const liveEnabled = full.isEnabled ?? true
    if (spec.isEnabled !== liveEnabled) {
      diffs.push({ field: `${label}.isEnabled`, expected: spec.isEnabled, actual: liveEnabled, severity: 'warning' })
    }
    const liveType = full.type ?? 'log_detection'
    if (spec.type !== liveType) {
      diffs.push({ field: `${label}.type`, expected: spec.type, actual: liveType, severity: 'warning' })
    }
    const liveExtendedTitle = full.hasExtendedTitle ?? false
    if (spec.hasExtendedTitle !== liveExtendedTitle) {
      diffs.push({ field: `${label}.hasExtendedTitle`, expected: spec.hasExtendedTitle, actual: liveExtendedTitle, severity: 'warning' })
    }
    const liveTags = Array.isArray(full.tags) ? full.tags : []
    if (!sameTagSet(spec.tags, liveTags)) {
      diffs.push({ field: `${label}.tags`, expected: spec.tags, actual: liveTags, severity: 'warning' })
    }

    const queries = parseJsonArray(spec.queriesRaw)
    if (queries.ok && queries.value !== undefined && !deepSubsetEqual(queries.value, full.queries ?? [])) {
      diffs.push({
        field: `${label}.queries`,
        expected: stableStringify(queries.value),
        actual: stableStringify(full.queries ?? []),
        severity: 'warning',
      })
    }
    const cases = parseJsonArray(spec.casesRaw)
    if (cases.ok && cases.value !== undefined && !deepSubsetEqual(cases.value, full.cases ?? [])) {
      diffs.push({
        field: `${label}.cases`,
        expected: stableStringify(cases.value),
        actual: stableStringify(full.cases ?? []),
        severity: 'warning',
      })
    }
    const options = parseJsonObject(spec.optionsRaw)
    if (options.ok && options.value !== undefined && !deepSubsetEqual(options.value, full.options ?? {})) {
      diffs.push({
        field: `${label}.options`,
        expected: stableStringify(options.value),
        actual: stableStringify(full.options ?? {}),
        severity: 'warning',
      })
    }
    const filters = parseJsonArray(spec.filtersRaw)
    if (filters.ok && filters.value !== undefined && !deepSubsetEqual(filters.value, full.filters ?? [])) {
      diffs.push({
        field: `${label}.filters`,
        expected: stableStringify(filters.value),
        actual: stableStringify(full.filters ?? []),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Case-sensitive set-equality for two tag lists (order-insensitive). */
function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((t) => setA.has(t))
}
