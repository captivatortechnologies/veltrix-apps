import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, runzeroRequest, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildSiteOptions, type SiteRollbackEntry } from './_shared'

/**
 * Undo a sites deploy from rollbackData.previous (written by deploy):
 *   - a site that was CREATED (existed:false) is deleted (DELETE /org/sites/{id})
 *   - a site that was UPDATED (existed:true) is restored to its prior body
 *     (PATCH /org/sites/{id})
 * Entries are reverted in reverse order. Applied over the runZero console REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: SiteRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  let restored = 0
  let deleted = 0
  let left = 0
  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.siteId) {
        // Never learned the id (e.g. create response lacked one) — leave in place.
        left++
        continue
      }
      if (!entry.existed) {
        const res = await runzeroRequest(`${base}/org/sites/${encodeURIComponent(entry.siteId)}`, { method: 'DELETE', headers, timeoutMs })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete site "${entry.name}": HTTP ${res.status}`)
        }
        deleted++
      } else if (entry.prior) {
        await sendJson('PATCH', `${base}/org/sites/${encodeURIComponent(entry.siteId)}`, headers, buildSiteOptions({
          name: entry.prior.name,
          description: entry.prior.description,
          subnets: entry.prior.scope,
        }), timeoutMs)
        restored++
      } else {
        left++
      }
    }
    return {
      success: true,
      message: `Rolled back sites: ${restored} restored, ${deleted} deleted${left ? `, ${left} left in place` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
