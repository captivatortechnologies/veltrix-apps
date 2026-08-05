import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractTrafficRuleSpecs, listTrafficRules, trafficRuleKey, type LiveTrafficRule } from './validate'

/**
 * Detect drift between the deployed Traffic Rules and the live Application: a
 * declared rule missing live is critical; a live rule not declared (this
 * config type owns the full list) is drift; field differences are warned.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const specs = extractTrafficRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listTrafficRules(client, appName)
    const byKey = new Map<string, LiveTrafficRule>(live.filter((r) => r.name).map((r) => [trafficRuleKey(r.name as string), r]))
    const declaredKeys = new Set(specs.map((s) => trafficRuleKey(s.name)))

    for (const spec of specs) {
      const found = byKey.get(trafficRuleKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.status ?? true) !== spec.status) {
        diffs.push({ field: `${spec.name}.status`, expected: spec.status, actual: found.status ?? true, severity: 'warning' })
      }
      if ((found.host_match ?? '*') !== spec.hostMatch) {
        diffs.push({ field: `${spec.name}.host_match`, expected: spec.hostMatch, actual: found.host_match ?? '*', severity: 'warning' })
      }
      if ((found.url_match ?? '/*') !== spec.urlMatch) {
        diffs.push({ field: `${spec.name}.url_match`, expected: spec.urlMatch, actual: found.url_match ?? '/*', severity: 'warning' })
      }
    }

    for (const rule of live) {
      if (rule.name && !declaredKeys.has(trafficRuleKey(rule.name))) {
        diffs.push({ field: rule.name, expected: 'not present (undeclared)', actual: 'present', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
