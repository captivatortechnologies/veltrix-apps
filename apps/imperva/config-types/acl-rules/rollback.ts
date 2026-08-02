import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  INCAP_RULES_EDIT_PATH,
  INCAP_RULES_DELETE_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'

/**
 * Undo an ACL rules deploy from rollbackData.previous (written by deploy()):
 *   - a rule that PRE-EXISTED → POST /sites/incapRules/edit with its prior body.
 *   - a rule we CREATED (prior === null) → POST /sites/incapRules/delete.
 *
 * Applied over the Cloud WAF (Incapsula) API v1. A rule whose id we never learned
 * is skipped (nothing safe to undo).
 */

interface PriorEntry {
  siteId: string
  name: string
  ruleId: string | number | null
  prior: { name: string; action: string; filter: string; enabled: boolean } | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (entry.ruleId == null) {
        skipped++
        continue
      }
      if (entry.prior) {
        const params: Record<string, string | number> = {
          rule_id: entry.ruleId,
          name: entry.prior.name,
          action: entry.prior.action,
          enabled: String(entry.prior.enabled),
        }
        if (entry.prior.filter) params.filter = entry.prior.filter
        const res = await client.post(INCAP_RULES_EDIT_PATH, params)
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`restore "${entry.name}" → HTTP ${res.status}: ${apiMessage(json)}`)
        restored++
      } else {
        const res = await client.post(INCAP_RULES_DELETE_PATH, { rule_id: entry.ruleId })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`delete "${entry.name}" → HTTP ${res.status}: ${apiMessage(json)}`)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back ACL rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
