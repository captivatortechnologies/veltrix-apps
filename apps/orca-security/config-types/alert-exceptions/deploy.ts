import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import {
  normalizeEnabled,
  readSystemAlert,
  setSystemAlertEnabled,
  type AlertExceptionRollbackData,
  type AlertExceptionRollbackEntry,
} from './_shared'

/**
 * Deploy Orca alert exceptions over the REST API:
 *   read:  GET /api/sonar/rules/{rule_id}        -> confirms the alert exists, gets rule_type + current enabled
 *   write: PUT /api/sonar/rules/status/{rule_id}  body { rule_id, rule_type, enabled, custom: false }
 *
 * Identity is the CALLER-SUPPLIED rule_id — a system alert already exists in
 * Orca's catalog and can never be created here, only toggled. A rule_id that
 * cannot be read is an error (nothing to except). Every deploy reads the LIVE
 * enabled state fresh (there is no "list my managed exceptions" to fall back
 * to, and a live read is cheap and authoritative) rather than trusting
 * rollbackData for identity — rollbackData exists purely so rollback can
 * restore the enabled value that was live immediately before this deploy ran.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previous: AlertExceptionRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const ruleId = String(item.fields.ruleId ?? '').trim()
      if (!ruleId) continue
      const desiredEnabled = normalizeEnabled(item.fields.enabled, true)

      const live = await readSystemAlert(client, ruleId)
      if (!live || !live.rule_type) {
        throw new Error(`alert exception "${ruleId}": rule not found (system alerts cannot be created — verify the rule_id in the Orca Alert Catalog)`)
      }

      const priorEnabled = normalizeEnabled(live.enabled, true)
      const result = await setSystemAlertEnabled(client, ruleId, live.rule_type, desiredEnabled)
      if (!result.ok) throw new Error(`alert exception "${ruleId}" failed: ${result.error}`)

      previous.push({ itemId, ruleId, priorEnabled })
      applied.push(ruleId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} alert exception(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies AlertExceptionRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Alert exception deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies AlertExceptionRollbackData,
    }
  }
}

