import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listAlertRules } from './healthCheck'
import { extractMsSecuritySpecs, readList } from './validate'

/** Order-independent comparison key for a list field (case-insensitive, sorted). */
function listKey(value: unknown): string {
  return readList(value).map((v) => v.toLowerCase()).sort().join('|')
}

/**
 * Detect drift between the deployed Microsoft Security rules and the live workspace.
 * A declared rule that no longer exists is critical drift; a differing displayName,
 * enabled state, productFilter or filter list is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractMsSecuritySpecs(ctx.deployedConfig).filter((s) => s.ruleName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAlertRules(client)
    const byId = new Map(live.filter((r) => r.name).map((r) => [(r.name as string).toLowerCase(), r]))

    for (const spec of specs) {
      const before = diffs.length
      const resourceId = client.sentinelPath(`/alertRules/${spec.ruleId}`)
      const liveRule = byId.get(spec.ruleId.toLowerCase())
      if (!liveRule) {
        diffs.push({ field: `rule:${spec.ruleName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
        continue
      }
      const props = liveRule.properties ?? {}
      const scalars: Array<{ label: string; want: unknown; have: unknown }> = [
        { label: 'displayName', want: spec.ruleName, have: props.displayName },
        { label: 'enabled', want: spec.enabled, have: props.enabled },
        { label: 'productFilter', want: spec.productFilter, have: props.productFilter },
      ]
      for (const { label, want, have } of scalars) {
        if (String(want ?? '') !== String(have ?? '')) {
          diffs.push({ field: `${spec.ruleName}.${label}`, expected: String(want ?? ''), actual: String(have ?? ''), severity: 'warning' })
        }
      }
      const lists: Array<{ label: string; want: string[]; have: unknown }> = [
        { label: 'severitiesFilter', want: spec.severitiesFilter, have: props.severitiesFilter },
        { label: 'displayNamesFilter', want: spec.displayNamesFilter, have: props.displayNamesFilter },
        { label: 'displayNamesExcludeFilter', want: spec.displayNamesExcludeFilter, have: props.displayNamesExcludeFilter },
      ]
      for (const { label, want, have } of lists) {
        if (listKey(want) !== listKey(have)) {
          diffs.push({
            field: `${spec.ruleName}.${label}`,
            expected: want.join(', ') || '(none)',
            actual: readList(have).join(', ') || '(none)',
            severity: 'warning',
          })
        }
      }
      // Attribute every diff this rule produced to the last human change (once);
      // a no-op when the rule did not drift.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
