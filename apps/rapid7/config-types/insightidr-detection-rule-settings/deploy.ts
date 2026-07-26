import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient, insightIDRErrorMessage, type InsightIDRClient } from '../../lib/insightidr'
import {
  detectionRuleName,
  indexRulesByName,
  listDetectionRules,
  resolveRuleByName,
  type LiveDetectionRule,
} from '../../lib/insightidr-rules'
import { extractRuleSettingSpecs, ruleKey, type RuleSettingSpec } from './validate'

/** A field change applied to a detection rule via POST /idr/v1/rules/update. */
export interface RuleUpdateEvent {
  type: 'SET'
  field: 'rule_action' | 'priority_level'
  new_value: string
  old_value?: string
}

export interface RuleSettingRollbackEntry {
  key: string
  label: string
  rrn: string
  /** Events needed to restore the rule to its pre-deploy settings. */
  restore: RuleUpdateEvent[]
}

/**
 * Deploy Rapid7 InsightIDR detection rule settings via the Detection Rules API.
 *
 * Identity is the rule NAME, resolved to its RRN via GET /idr/v1/rules. For each
 * declared rule the desired rule action (and optional priority) is diffed against
 * the live value and applied with POST /idr/v1/rules/update (a SET event per
 * changed field); a rule already at the desired settings is skipped. The prior
 * value of each changed field is captured so rollback can restore it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRuleSettingSpecs(ctx.canvas).filter((s) => s.ruleName && s.ruleAction)
  const rollbackState: RuleSettingRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    const rulesByName = indexRulesByName(await listDetectionRules(client))

    for (const spec of specs) {
      const label = spec.ruleName
      const resolved = resolveRuleByName(rulesByName, spec.ruleName)
      if ('error' in resolved) throw new Error(`Cannot configure rule "${spec.ruleName}": ${resolved.error}`)
      const rule = resolved.rule
      const rrn = rule.rrn as string

      const { events, restore } = diffRule(spec, rule)
      if (events.length === 0) {
        skipped.push(label)
        continue
      }

      const res = await client.request('POST', '/idr/v1/rules/update', { body: [{ rrn, events }] })
      if (!res.ok) throw new Error(`Failed to update rule "${label}": ${insightIDRErrorMessage(res)}`)
      rollbackState.push({ key: ruleKey(spec), label, rrn, restore })
      applied.push(label)
    }

    const summary = `Updated ${applied.length}, skipped ${skipped.length} already-matching detection rule(s) on ${baseUrl}`
    return {
      success: true,
      message: applied.length ? `${summary}: ${applied.join(', ')}` : summary,
      artifacts: { baseUrl, updatedRules: applied, skippedRules: skipped },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Detection rule settings deployment failed after ${applied.length + skipped.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, updatedRules: applied, skippedRules: skipped },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Apply a batch of update events to one rule; throws on a non-OK response. */
export async function applyRuleEvents(client: InsightIDRClient, rrn: string, events: RuleUpdateEvent[]): Promise<void> {
  const res = await client.request('POST', '/idr/v1/rules/update', { body: [{ rrn, events }] })
  if (!res.ok) throw new Error(insightIDRErrorMessage(res))
}

/**
 * Compute the SET events needed to bring a live rule to the desired settings and
 * the inverse events that would restore it. Only changed fields are emitted.
 */
export function diffRule(
  spec: RuleSettingSpec,
  rule: LiveDetectionRule,
): { events: RuleUpdateEvent[]; restore: RuleUpdateEvent[] } {
  const events: RuleUpdateEvent[] = []
  const restore: RuleUpdateEvent[] = []
  const liveAction = (rule.rule?.rule_action ?? '').trim()
  const livePriority = (rule.rule?.priority_level ?? '').trim()

  if (spec.ruleAction && spec.ruleAction !== liveAction) {
    events.push({ type: 'SET', field: 'rule_action', new_value: spec.ruleAction, old_value: liveAction || undefined })
    restore.push({ type: 'SET', field: 'rule_action', new_value: liveAction, old_value: spec.ruleAction })
  }
  if (spec.priorityLevel && spec.priorityLevel !== livePriority) {
    events.push({ type: 'SET', field: 'priority_level', new_value: spec.priorityLevel, old_value: livePriority || undefined })
    restore.push({ type: 'SET', field: 'priority_level', new_value: livePriority, old_value: spec.priorityLevel })
  }
  return { events, restore }
}

/** Re-export so sibling handlers can read a live rule's display name. */
export { detectionRuleName }
