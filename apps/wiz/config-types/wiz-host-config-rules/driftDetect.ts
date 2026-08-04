import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listCustomHostConfigRules, readRule } from './deploy'
import { extractHostConfigRuleSpecs, ruleKey, type LiveHostConfigRule } from './validate'

/**
 * Detect drift between the deployed host-configuration-rule configuration and
 * the live tenant. Re-finds each declared rule by name and diffs the managed
 * fields: a missing rule is critical drift; a changed enabled state, OVAL
 * definition, target platform set or security sub-category set is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractHostConfigRuleSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.directOval && s.targetPlatformIds.length > 0,
  )
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listCustomHostConfigRules(client)
    const byName = new Map<string, LiveHostConfigRule>(
      live.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(ruleKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readRule(client, found.id)
      const liveEnabled = full.enabled ?? true
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled), severity: 'warning' })
      }
      if ((full.directOVAL ?? '').trim() !== spec.directOval.trim()) {
        diffs.push({ field: `${label}.direct_oval`, expected: 'as declared', actual: 'changed in Wiz', severity: 'warning' })
      }

      const declaredPlatforms = [...spec.targetPlatformIds].map((v) => v.toLowerCase()).sort()
      const livePlatforms = (full.targetPlatforms ?? [])
        .map((p) => (p.id ?? '').toLowerCase())
        .filter((v) => v !== '')
        .sort()
      if (declaredPlatforms.join(',') !== livePlatforms.join(',')) {
        diffs.push({
          field: `${label}.target_platform_ids`,
          expected: spec.targetPlatformIds,
          actual: (full.targetPlatforms ?? []).map((p) => p.id ?? ''),
          severity: 'warning',
        })
      }

      const declaredSubs = [...spec.securitySubCategories].map((v) => v.toLowerCase()).sort()
      const liveSubs = (full.securitySubCategories ?? [])
        .map((s) => (s.id ?? '').toLowerCase())
        .filter((v) => v !== '')
        .sort()
      if (declaredSubs.join(',') !== liveSubs.join(',')) {
        diffs.push({
          field: `${label}.security_sub_categories`,
          expected: spec.securitySubCategories,
          actual: (full.securitySubCategories ?? []).map((s) => s.id ?? ''),
          severity: 'warning',
        })
      }

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
