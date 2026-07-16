import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { listAutomationRules, type LiveAutomationRule } from './healthCheck'
import { extractAutomationSpecs } from './validate'

/** Pull the ModifyProperties severity/status from a live rule's actions (first match). */
function liveModify(rule: LiveAutomationRule): { severity: string; status: string } {
  const action = (rule.properties?.actions ?? []).find((a) => a.actionType === 'ModifyProperties')
  return { severity: action?.actionConfiguration?.severity ?? '', status: action?.actionConfiguration?.status ?? '' }
}

/**
 * Detect drift between the deployed automation rules and the live workspace. A
 * declared rule that no longer exists is critical drift; a key field that differs
 * (order, enabled state, trigger, or the modify-properties severity/status) is
 * warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAutomationSpecs(ctx.deployedConfig).filter((s) => s.ruleName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAutomationRules(client)
    const byId = new Map(live.filter((r) => r.name).map((r) => [(r.name as string).toLowerCase(), r]))

    for (const spec of specs) {
      const liveRule = byId.get(spec.ruleId.toLowerCase())
      if (!liveRule) {
        diffs.push({ field: `rule:${spec.ruleName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const props = liveRule.properties ?? {}
      const logic = props.triggeringLogic ?? {}
      const modify = liveModify(liveRule)
      const comparisons: Array<{ label: string; want: unknown; have: unknown }> = [
        { label: 'order', want: spec.order, have: props.order },
        { label: 'enabled', want: spec.enabled, have: logic.isEnabled },
        { label: 'triggersOn', want: spec.triggersOn, have: logic.triggersOn },
        { label: 'triggersWhen', want: spec.triggersWhen, have: logic.triggersWhen },
        { label: 'setSeverity', want: spec.setSeverity, have: modify.severity },
        { label: 'setStatus', want: spec.setStatus, have: modify.status },
      ]
      for (const { label, want, have } of comparisons) {
        if (String(want ?? '') !== String(have ?? '')) {
          diffs.push({ field: `${spec.ruleName}.${label}`, expected: String(want ?? ''), actual: String(have ?? ''), severity: 'warning' })
        }
      }
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
