import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { RULE_ACTION, type LiveRule } from './validate'
import type { PhaseRollback } from './deploy'

/**
 * Roll back transform rules by restoring EACH phase entrypoint that deploy
 * touched to the rule list captured before deploy. Because deploy replaces each
 * phase entrypoint declaratively, rollback is one PUT per phase of its prior list
 * (an empty list when that phase's entrypoint did not previously exist).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as { phases?: Record<string, PhaseRollback> } | undefined
  if (!data || !data.phases) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []
  try {
    for (const [phase, state] of Object.entries(data.phases)) {
      const rules = (state.priorRules ?? []).map(rebuildRule)
      const res = await client.zone('PUT', `/rulesets/phases/${phase}/entrypoint`, { body: { rules } })
      if (!res.ok) {
        throw new Error(`${phase}: ${cloudflareErrorMessage(res)}`)
      }
      restored.push(`${phase} (${rules.length} rule(s))`)
    }
    return {
      success: true,
      message: `Rolled back ${restored.length} phase entrypoint(s): ${restored.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/** Rebuild a prior rule as a writable object (strip server-managed fields). */
function rebuildRule(r: LiveRule): Record<string, unknown> {
  const rule: Record<string, unknown> = {
    action: r.action ?? RULE_ACTION,
    expression: r.expression,
    enabled: r.enabled ?? true,
  }
  if (r.ref) rule.ref = r.ref
  if (r.description) rule.description = r.description
  if (r.action_parameters) rule.action_parameters = r.action_parameters
  return rule
}
