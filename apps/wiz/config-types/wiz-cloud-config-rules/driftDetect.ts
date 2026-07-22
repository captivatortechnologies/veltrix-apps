import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listCustomCloudConfigRules, readRule } from './deploy'
import { extractCloudConfigRuleSpecs, ruleKey, type LiveCloudConfigRule } from './validate'

/**
 * Detect drift between the deployed cloud configuration rule configuration and
 * the live tenant. Re-finds each declared rule by name and diffs the managed
 * fields: a missing rule is critical drift; a changed severity, enabled state or
 * Rego (OPA) policy is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCloudConfigRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.opaPolicy)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listCustomCloudConfigRules(client)
    const byName = new Map<string, LiveCloudConfigRule>(
      live.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(ruleKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readRule(client, found.id)
      if ((full.severity ?? '') !== spec.severity) {
        diffs.push({ field: `${label}.severity`, expected: spec.severity, actual: full.severity ?? 'not set', severity: 'warning' })
      }
      const liveEnabled = full.enabled ?? true
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled), severity: 'warning' })
      }
      if ((full.opaPolicy ?? '').trim() !== spec.opaPolicy.trim()) {
        diffs.push({ field: `${label}.opa_policy`, expected: 'as declared', actual: 'changed in Wiz', severity: 'warning' })
      }

      // Attribute every diff this rule produced to the last human change (once).
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
