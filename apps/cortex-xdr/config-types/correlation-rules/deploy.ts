import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  CORRELATION_ENDPOINTS,
  buildCorrelationRuleFields,
  findCorrelationRule,
  correlationRulesFromReply,
  type CortexCorrelationRule,
} from './_shared'

/**
 * Deploy Cortex XDR correlation rules over the public REST API:
 *   read (identity + rollback): POST /correlations/get/    → best-effort snapshot
 *   upsert:                     POST /correlations/insert/  with { request_data: [ <rule>, … ] }
 *
 * /correlations/insert upserts by `rule_id` — a rule matched by name gets its
 * rule_id attached so the call updates it in place; an unmatched name creates a
 * new rule. rollbackData records, per rule, the prior body (null when it did not
 * exist) so rollback can restore the prior body or delete the one we created.
 *
 * VERIFY the insert request envelope and correlation-rule field names against a
 * live Cortex XDR tenant.
 */
async function listCorrelationRules(client: CortexXdrClient): Promise<CortexCorrelationRule[]> {
  try {
    const res = await client.call(CORRELATION_ENDPOINTS.get, { search_from: 0, search_to: 1000 })
    if (!res.ok) return []
    return correlationRulesFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for correlation-rule deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: CortexCorrelationRule | null }> = []
  const rules: CortexCorrelationRule[] = []
  const applied: string[] = []

  try {
    const live = await listCorrelationRules(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const rule = buildCorrelationRuleFields(item.fields)
      const match = findCorrelationRule(live, name)
      if (match?.rule_id !== undefined) rule.rule_id = match.rule_id
      rules.push(rule)
      previous.push({ name, prior: match })
      applied.push(name)
    }

    if (rules.length === 0) {
      return { success: true, message: 'No correlation rules to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    const res = await client.post(CORRELATION_ENDPOINTS.insert, { request_data: rules })
    const error = cortexWriteError(res)
    if (error) {
      return {
        success: false,
        message: `Correlation-rule deploy failed: ${error}`,
        artifacts: { applied: [] },
        rollbackData: { previous },
      }
    }

    return {
      success: true,
      message: `Applied ${applied.length} correlation rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Correlation-rule deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied: [] },
      rollbackData: { previous },
    }
  }
}
