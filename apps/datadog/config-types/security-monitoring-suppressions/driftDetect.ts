import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listSuppressions, readSuppression } from './deploy'
import { extractSuppressionSpecs, findSuppressionByName, sameTagSet, type SuppressionResource } from './_shared'

/**
 * Detect drift between the deployed Suppression Rule configuration and the
 * live organization. Re-finds each declared rule by name and diffs
 * description / enabled / rule_query / suppression_query /
 * data_exclusion_query / tags.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSuppressionSpecs(ctx.deployedConfig).filter((s) => s.name && s.ruleQuery)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: SuppressionResource[]
  try {
    live = await listSuppressions(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'datadog',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findSuppressionByName(live, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: SuppressionResource
    try {
      full = await readSuppression(client, found.id)
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'readable',
        actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'warning',
      })
      continue
    }
    const attrs = full.attributes ?? {}

    if (spec.description !== (attrs.description ?? '')) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: attrs.description ?? 'not set', severity: 'warning' })
    }
    const liveEnabled = attrs.enabled ?? true
    if (spec.enabled !== liveEnabled) {
      diffs.push({ field: `${label}.enabled`, expected: spec.enabled, actual: liveEnabled, severity: 'warning' })
    }
    if (spec.ruleQuery !== (attrs.rule_query ?? '')) {
      diffs.push({ field: `${label}.rule_query`, expected: spec.ruleQuery, actual: attrs.rule_query ?? 'not set', severity: 'warning' })
    }
    if (spec.suppressionQuery !== (attrs.suppression_query ?? '')) {
      diffs.push({
        field: `${label}.suppression_query`,
        expected: spec.suppressionQuery,
        actual: attrs.suppression_query ?? 'not set',
        severity: 'warning',
      })
    }
    if (spec.dataExclusionQuery !== (attrs.data_exclusion_query ?? '')) {
      diffs.push({
        field: `${label}.data_exclusion_query`,
        expected: spec.dataExclusionQuery,
        actual: attrs.data_exclusion_query ?? 'not set',
        severity: 'warning',
      })
    }
    const liveTags = Array.isArray(attrs.tags) ? attrs.tags : []
    if (!sameTagSet(spec.tags, liveTags)) {
      diffs.push({ field: `${label}.tags`, expected: spec.tags, actual: liveTags, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
