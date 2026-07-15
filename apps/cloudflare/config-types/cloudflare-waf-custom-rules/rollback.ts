import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { PHASE, type LiveRule } from './validate'

/**
 * Roll back WAF custom rules by restoring the phase entrypoint to the rule list
 * captured before deploy. Because deploy replaces the whole entrypoint
 * declaratively, rollback is a single PUT of the prior list (an empty list when
 * the entrypoint did not previously exist).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as { priorRules?: LiveRule[]; existed?: boolean } | undefined
  if (!data || data.priorRules === undefined) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  // Rebuild the prior rules as writable objects (strip server-managed fields).
  const rules = (data.priorRules ?? []).map((r) => {
    const rule: Record<string, unknown> = {
      action: r.action,
      expression: r.expression,
      enabled: r.enabled ?? true,
    }
    if (r.ref) rule.ref = r.ref
    if (r.description) rule.description = r.description
    if (r.action_parameters) rule.action_parameters = r.action_parameters
    return rule
  })

  try {
    const res = await client.zone('PUT', `/rulesets/phases/${PHASE}/entrypoint`, { body: { rules } })
    if (!res.ok) {
      throw new Error(cloudflareErrorMessage(res))
    }
    return {
      success: true,
      message: `Rolled back the ${PHASE} entrypoint to its prior ${rules.length} rule(s)`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
