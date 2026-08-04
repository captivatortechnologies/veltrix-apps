import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, runzeroRequest, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildMappingFromPrior, type SsoGroupMappingRollbackEntry } from './_shared'

/**
 * Undo an SSO group mappings deploy from rollbackData.previous (written by deploy):
 *   - a mapping that was CREATED (existed:false) is deleted (DELETE /account/sso/groups/{id})
 *   - a mapping that was UPDATED (existed:true) is restored to its prior body
 *     (PUT /account/sso/groups with the full prior object)
 * Entries are reverted in reverse order. Applied over the runZero console REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: SsoGroupMappingRollbackEntry[] }
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
      if (!entry.mappingId) {
        left++
        continue
      }
      if (!entry.existed) {
        const res = await runzeroRequest(`${base}/account/sso/groups/${encodeURIComponent(entry.mappingId)}`, { method: 'DELETE', headers, timeoutMs })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete SSO group mapping "${entry.ssoAttribute}=${entry.ssoValue}": HTTP ${res.status}`)
        }
        deleted++
      } else if (entry.prior) {
        await sendJson('PUT', `${base}/account/sso/groups`, headers, buildMappingFromPrior(entry.mappingId, entry.prior), timeoutMs)
        restored++
      } else {
        left++
      }
    }
    return {
      success: true,
      message: `Rolled back SSO group mappings: ${restored} restored, ${deleted} deleted${left ? `, ${left} left in place` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
