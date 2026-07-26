import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listAlertRules } from './healthCheck'
import { extractRuleSpecs, isNrt } from './validate'

type RuleField = { label: string; specKey: keyof ReturnType<typeof extractRuleSpecs>[number]; liveKey: string }

/** Fields compared for every rule kind. */
const COMMON_COMPARED: RuleField[] = [
  { label: 'enabled', specKey: 'enabled', liveKey: 'enabled' },
  { label: 'severity', specKey: 'severity', liveKey: 'severity' },
  { label: 'query', specKey: 'query', liveKey: 'query' },
]

/** Fields compared only for Scheduled rules — NRT rules have none of these. */
const SCHEDULED_COMPARED: RuleField[] = [
  { label: 'queryFrequency', specKey: 'queryFrequency', liveKey: 'queryFrequency' },
  { label: 'queryPeriod', specKey: 'queryPeriod', liveKey: 'queryPeriod' },
  { label: 'triggerOperator', specKey: 'triggerOperator', liveKey: 'triggerOperator' },
  { label: 'triggerThreshold', specKey: 'triggerThreshold', liveKey: 'triggerThreshold' },
]

/**
 * Detect drift between the deployed analytics rules and the live workspace. A
 * declared rule that no longer exists is critical drift; a key field that differs
 * from the declared configuration is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractRuleSpecs(ctx.deployedConfig).filter((s) => s.ruleName)
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
      // A rule whose kind changed out-of-band (Scheduled <-> NRT) is drift.
      if (String(spec.kind) !== String(liveRule.kind ?? '')) {
        diffs.push({ field: `${spec.ruleName}.kind`, expected: String(spec.kind), actual: String(liveRule.kind ?? ''), severity: 'warning' })
      }
      const props = liveRule.properties ?? {}
      const compared = isNrt(spec.kind) ? COMMON_COMPARED : [...COMMON_COMPARED, ...SCHEDULED_COMPARED]
      for (const { label, specKey, liveKey } of compared) {
        const want = spec[specKey]
        const have = props[liveKey]
        if (String(want ?? '') !== String(have ?? '')) {
          diffs.push({ field: `${spec.ruleName}.${label}`, expected: String(want ?? ''), actual: String(have ?? ''), severity: 'warning' })
        }
      }
      // Attribute every diff this rule produced to the last human change (once);
      // a no-op (no query) when the rule did not drift.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
