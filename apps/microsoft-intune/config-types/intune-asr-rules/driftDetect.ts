import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { ASR_RULES, parseLiveRuleStates } from '../../lib/asr'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
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

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAsrPolicies(client)
    const byName = new Map(live.filter((p) => p.name && p.id).map((p) => [policyKey(p.name as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const livePolicy = byName.get(policyKey(spec.name))
      if (!livePolicy || !livePolicy.id) {
        diffs.push({ field: `policy:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
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
      // Attribute every diff this policy produced to the last human change (once);
      // a no-op (no query) when the policy did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: livePolicy.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
