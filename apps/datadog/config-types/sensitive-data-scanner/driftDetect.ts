import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { readScannerConfig } from './deploy'
import { buildRuleBody, extractGroupSpecs, findGroupByName, parseJsonArray, ruleKey, type RawRuleJson, type ScannerRuleResource } from './_shared'

/**
 * Detect drift between the deployed Sensitive Data Scanner configuration and
 * the live organization: a missing group is critical drift; a changed group
 * attribute, a missing/extra/changed rule within a group is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let snapshot
  try {
    snapshot = await readScannerConfig(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [{ field: 'datadog', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' }],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findGroupByName(snapshot.groups, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    const attrs = found.attributes ?? {}

    const liveEnabled = attrs.is_enabled ?? true
    if (spec.isEnabled !== liveEnabled) {
      diffs.push({ field: `${label}.is_enabled`, expected: spec.isEnabled, actual: liveEnabled, severity: 'warning' })
    }
    const liveProducts = Array.isArray(attrs.product_list) ? [...attrs.product_list].sort() : []
    const declaredProducts = [...spec.productList].sort()
    if (JSON.stringify(declaredProducts) !== JSON.stringify(liveProducts)) {
      diffs.push({ field: `${label}.product_list`, expected: spec.productList, actual: attrs.product_list ?? [], severity: 'warning' })
    }
    const liveFilter = attrs.filter?.query ?? '*'
    if (spec.filterQuery !== liveFilter) {
      diffs.push({ field: `${label}.filter_query`, expected: spec.filterQuery, actual: liveFilter, severity: 'warning' })
    }

    const rulesParsed = parseJsonArray(spec.rulesRaw)
    const declaredRules = (rulesParsed.ok ? (rulesParsed.value ?? []) : []) as RawRuleJson[]
    const liveRuleIds = found.relationships?.rules?.data?.map((r) => r.id).filter((id): id is string => !!id) ?? []
    const liveRules = liveRuleIds.map((id) => snapshot.rulesById.get(id)).filter((r): r is ScannerRuleResource => !!r)
    const liveByKey = new Map(liveRules.filter((r) => r.attributes?.name).map((r) => [ruleKey(r.attributes!.name as string), r]))
    const declaredKeys = new Set<string>()

    for (const raw of declaredRules) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      if (!name) continue
      const key = ruleKey(name)
      declaredKeys.add(key)
      const live = liveByKey.get(key)
      if (!live) {
        diffs.push({ field: `${label}.rules.${name}`, expected: 'exists', actual: 'missing', severity: 'warning' })
        continue
      }
      const { body: declaredBody } = buildRuleBody(raw)
      const liveAttrs = live.attributes ?? {}
      const liveEnabledRule = liveAttrs.is_enabled ?? true
      if (declaredBody.is_enabled !== liveEnabledRule) {
        diffs.push({ field: `${label}.rules.${name}.is_enabled`, expected: declaredBody.is_enabled, actual: liveEnabledRule, severity: 'warning' })
      }
      const livePriority = typeof liveAttrs.priority === 'number' ? liveAttrs.priority : 3
      if (declaredBody.priority !== livePriority) {
        diffs.push({ field: `${label}.rules.${name}.priority`, expected: declaredBody.priority, actual: livePriority, severity: 'warning' })
      }
    }

    for (const [key, live] of liveByKey) {
      if (!declaredKeys.has(key)) {
        diffs.push({ field: `${label}.rules.${live.attributes?.name ?? key}`, expected: 'removed', actual: 'still present', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
