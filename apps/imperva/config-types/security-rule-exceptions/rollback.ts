import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, SECURITY_EXCEPTION_CONFIGURE_PATH, isApiSuccess, apiMessage, parseJson, type ImpervaEnvelope } from '../../lib/impervaApi'
import { exceptionParams, type ExceptionFields } from './_shared'

/**
 * Undo a security rule exceptions deploy from rollbackData.previous (written by
 * deploy()): delete every exception this deploy CREATED, then re-add every
 * exception this deploy DELETED. A re-added exception gets a NEW whitelist_id —
 * content is restored, identity is not (the same best-effort caveat this app
 * documents for every content-only restore).
 */

interface PriorEntry {
  siteId: string
  ruleId: string
  created: Array<{ whitelistId: string | number }>
  deleted: Array<{ fields: ExceptionFields }>
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let deleted = 0
  let restored = 0
  try {
    for (const entry of previous) {
      for (const { whitelistId } of entry.created) {
        const res = await client.post(SECURITY_EXCEPTION_CONFIGURE_PATH, {
          site_id: entry.siteId,
          rule_id: entry.ruleId,
          whitelist_id: whitelistId,
          delete_whitelist: 'true',
        })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`delete exception ${whitelistId} (rule ${entry.ruleId}, site ${entry.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        deleted++
      }
      for (const { fields } of entry.deleted) {
        const res = await client.post(SECURITY_EXCEPTION_CONFIGURE_PATH, {
          site_id: entry.siteId,
          rule_id: entry.ruleId,
          exception_id_only: 'true',
          ...exceptionParams(fields),
        })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`re-add exception (rule ${entry.ruleId}, site ${entry.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        restored++
      }
    }
    return { success: true, message: `Rolled back security rule exceptions: ${deleted} deleted, ${restored} re-added.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
