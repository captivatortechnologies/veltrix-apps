import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { ASR_RULES, parseLiveRuleStates } from '../../lib/asr'
import { listAsrPolicies, getPolicyWithSettings } from './deploy'
import { extractAsrSpecs, policyKey } from './validate'

/**
 * Detect drift between the deployed ASR policies and the live tenant. A declared
 * policy that no longer exists is critical drift; a per-rule state that differs
 * from the declared configuration is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAsrSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAsrPolicies(client)
    const byName = new Map(live.filter((p) => p.name && p.id).map((p) => [policyKey(p.name as string), p]))

    for (const spec of specs) {
      const livePolicy = byName.get(policyKey(spec.name))
      if (!livePolicy || !livePolicy.id) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const full = await getPolicyWithSettings(client, livePolicy.id)
      if (!full) continue
      const liveStates = parseLiveRuleStates(full)
      for (const rule of ASR_RULES) {
        const want = spec.rules[rule.key] ?? 'notconfigured'
        const have = liveStates[rule.key] ?? 'notconfigured'
        if (want !== have) {
          diffs.push({ field: `${spec.name}.${rule.key}`, expected: want, actual: have, severity: 'warning' })
        }
      }
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
