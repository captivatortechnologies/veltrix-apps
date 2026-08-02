import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  SECURITY_CONFIGURE_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import type { SecurityKind } from './_shared'

/**
 * Undo a security-rules deploy from rollbackData.previous (written by deploy()):
 * re-apply each rule's prior parameter values with POST /sites/configure/security.
 * Empty prior values are omitted (the API leaves those unchanged). A rule for
 * which we captured no prior value at all is skipped (nothing safe to restore).
 */

interface PriorEntry {
  siteId: string
  ruleId: string
  kind: SecurityKind
  prior: Record<string, string>
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      const values = Object.fromEntries(Object.entries(entry.prior ?? {}).filter(([, v]) => v !== ''))
      if (Object.keys(values).length === 0) {
        skipped++
        continue
      }
      const res = await client.post(SECURITY_CONFIGURE_PATH, { site_id: entry.siteId, rule_id: entry.ruleId, ...values })
      const json = parseJson<ImpervaEnvelope>(res.body)
      if (!res.ok || !isApiSuccess(json)) {
        throw new Error(`restore ${entry.ruleId} (site ${entry.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
      }
      restored++
    }
    return { success: true, message: `Rolled back security rules: ${restored} restored${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
