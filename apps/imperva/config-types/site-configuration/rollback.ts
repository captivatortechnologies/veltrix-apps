import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, SITE_CONFIGURE_PATH, SITE_LOG_LEVEL_PATH, isApiSuccess, apiMessage, parseJson, type ImpervaEnvelope } from '../../lib/impervaApi'
import { READABLE_FIELDS, SITE_CONFIGURE_PARAM_NAMES } from './_shared'

/**
 * Undo a site configuration deploy from rollbackData.previous (written by
 * deploy()): re-apply the prior value of every READABLE field (active,
 * acceleration_level, ref_id, restricted_cname_reuse, naked_domain_san,
 * wildcard_san, log_level). Fields with no read-back on this API
 * (domain_validation, approver, ignore_ssl, domain_redirect_to_full) CANNOT be
 * restored — if any were declared, the result surfaces which ones so an
 * operator knows to re-check the site manually.
 */

interface PriorEntry {
  siteId: string
  prior: Record<string, string>
  declaredWriteOnly: string[]
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  const unrestorable: string[] = []
  try {
    for (const entry of previous) {
      for (const [field, param] of Object.entries(SITE_CONFIGURE_PARAM_NAMES)) {
        if (!READABLE_FIELDS.has(field)) continue
        const value = entry.prior[field]
        if (value === undefined || value === '') continue
        const res = await client.post(SITE_CONFIGURE_PATH, { site_id: entry.siteId, param, value })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`restore ${param}=${value} (site ${entry.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        restored++
      }
      if (entry.prior.logLevel) {
        const res = await client.post(SITE_LOG_LEVEL_PATH, { site_id: entry.siteId, log_level: entry.prior.logLevel })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`restore log_level=${entry.prior.logLevel} (site ${entry.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
        restored++
      }
      if (entry.declaredWriteOnly.length > 0) {
        unrestorable.push(`site ${entry.siteId}: ${entry.declaredWriteOnly.join(', ')}`)
      }
    }
    const note = unrestorable.length ? ` NOT restorable (write-only on this API, verify manually): ${unrestorable.join('; ')}.` : ''
    return { success: true, message: `Rolled back ${restored} site setting(s).${note}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
