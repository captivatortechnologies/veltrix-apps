import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PRIMARY } from '../../lib/thehiveApi'
import { toOrganisationUpdate, type Organisation } from './_shared'

/**
 * Undo an organisations deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH /api/v1/organisation/<id> with the prior organisation's
 * mutable subset (restore). For an organisation this deploy CREATED (prior body
 * null), there is nothing to restore and — because TheHive has NO delete endpoint
 * for organisations — nothing to delete either. The only safe, available undo is
 * to LOCK it (PATCH { locked: true }), which disables member logins without
 * destroying the tenant's cases/alerts. This is a best-effort mitigation, not a
 * true rollback — surfaced clearly in the result message. See _shared.ts / README.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; orgId: string | null; org: Organisation | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for organisation rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let locked = 0
  let skipped = 0
  try {
    for (const { orgId, org } of previous) {
      if (!orgId) {
        skipped++
        continue
      }
      const path = `${base}${PRIMARY.organisationById(orgId)}`
      if (org) {
        await sendJson('PATCH', path, headers, toOrganisationUpdate(org))
        restored++
      } else {
        // Created by this deploy — TheHive has no delete endpoint for
        // organisations, so lock it instead of leaving it fully live.
        await sendJson('PATCH', path, headers, { locked: true })
        locked++
      }
    }
    const parts = [`${restored} restored`]
    if (locked) parts.push(`${locked} locked (no delete endpoint for organisations)`)
    if (skipped) parts.push(`${skipped} skipped`)
    return { success: true, message: `Rolled back organisations: ${parts.join(', ')}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
