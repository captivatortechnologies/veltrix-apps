import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, stableStringify } from '../../lib/oneLogin'
import { listAppRules } from './deploy'
import { extractAppRuleSpecs, type AppRuleSpec } from './validate'

/**
 * Detect drift between the deployed app-rule configuration and the live
 * account. Re-finds each declared rule by (appId, name) and diffs match/
 * enabled/conditions/actions. Also checks the RELATIVE order of just the
 * declared rules within each app - not their absolute position, since
 * undeclared rules for that app may legitimately sit between them.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAppRuleSpecs(ctx.deployedConfig).filter((s) => s.appId !== undefined && s.name)
  const byApp = new Map<number, AppRuleSpec[]>()
  for (const spec of specs) {
    const appId = spec.appId as number
    if (!byApp.has(appId)) byApp.set(appId, [])
    byApp.get(appId)!.push(spec)
  }

  for (const [appId, appSpecs] of byApp) {
    let liveRules
    try {
      liveRules = await listAppRules(client, appId)
    } catch (error) {
      diffs.push({
        field: `app ${appId}`,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
      continue
    }

    const liveByName = new Map(liveRules.map((r) => [r.name, r]))

    for (const spec of appSpecs) {
      const label = `${spec.name} (app ${appId})`
      const live = liveByName.get(spec.name)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveMatch = live.match === 'any' ? 'any' : 'all'
      if (spec.match !== liveMatch) {
        diffs.push({ field: `${label}.match`, expected: spec.match, actual: liveMatch, severity: 'warning' })
      }

      const liveEnabled = live.enabled ?? true
      if (spec.enabled !== liveEnabled) {
        diffs.push({ field: `${label}.enabled`, expected: spec.enabled, actual: liveEnabled, severity: 'critical' })
      }

      const specConditions = JSON.parse(spec.conditionsJson || '[]')
      if (stableStringify(specConditions) !== stableStringify(live.conditions ?? [])) {
        diffs.push({
          field: `${label}.conditions`,
          expected: stableStringify(specConditions),
          actual: stableStringify(live.conditions ?? []),
          severity: 'critical',
        })
      }

      const specActions = JSON.parse(spec.actionsJson || '[]')
      if (stableStringify(specActions) !== stableStringify(live.actions ?? [])) {
        diffs.push({
          field: `${label}.actions`,
          expected: stableStringify(specActions),
          actual: stableStringify(live.actions ?? []),
          severity: 'critical',
        })
      }
    }

    const declaredNames = appSpecs.map((s) => s.name)
    const liveOrderOfDeclared = liveRules.filter((r) => typeof r.name === 'string' && declaredNames.includes(r.name)).map((r) => r.name as string)
    const expectedOrderOfDeclared = declaredNames.filter((name) => liveOrderOfDeclared.includes(name))
    if (liveOrderOfDeclared.join(' ') !== expectedOrderOfDeclared.join(' ')) {
      diffs.push({
        field: `app ${appId}.rules.order`,
        expected: expectedOrderOfDeclared.join(' -> '),
        actual: liveOrderOfDeclared.join(' -> '),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
