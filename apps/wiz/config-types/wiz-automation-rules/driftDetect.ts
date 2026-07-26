import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listAutomationRules, readRule } from './deploy'
import { extractAutomationRuleSpecs, ruleKey, type LiveAutomationRule } from './validate'

/**
 * Detect drift between the deployed automation-rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs the managed scalar
 * fields: a missing rule is critical drift; a changed enabled state, trigger
 * source or trigger-type set is a warning. (Per-action parameters are a
 * non-introspectable Wiz union and are not compared.)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAutomationRuleSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.integrationId && s.actionTemplateType,
  )
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAutomationRules(client)
    const byName = new Map<string, LiveAutomationRule>(
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
      if ((full.triggerSource ?? '') !== spec.triggerSource) {
        diffs.push({
          field: `${label}.trigger_source`,
          expected: spec.triggerSource,
          actual: full.triggerSource ?? 'not set',
          severity: 'warning',
        })
      }
      const liveTypes = Array.isArray(full.triggerType) ? full.triggerType : []
      if (!sameSet(liveTypes, spec.triggerTypes)) {
        diffs.push({
          field: `${label}.trigger_types`,
          expected: spec.triggerTypes.join(', ') || '(none)',
          actual: liveTypes.join(', ') || '(none)',
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

/** Case-insensitive set-equality for two string lists. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}
